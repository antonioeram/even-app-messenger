package store

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "messages.db"))
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

var t0 = time.Date(2026, 11, 12, 10, 0, 0, 0, time.UTC)

func msg(chat, id string, minutes int, text string) Message {
	return Message{ChatID: chat, ID: id, Sender: "Ana", Time: t0.Add(time.Duration(minutes) * time.Minute), Text: text}
}

func TestSaveMessageCreatesChatWithPreview(t *testing.T) {
	s, ctx := open(t), context.Background()
	if _, err := s.SaveMessage(ctx, msg("ana@s.whatsapp.net", "m1", 0, "Salut")); err != nil {
		t.Fatal(err)
	}
	chats, err := s.Chats(ctx, 10, 0, All)
	if err != nil {
		t.Fatal(err)
	}
	if len(chats) != 1 {
		t.Fatalf("got %d chats, want 1", len(chats))
	}
	c := chats[0]
	if c.ID != "ana@s.whatsapp.net" || c.Preview != "Salut" || !c.LastTime.Equal(t0) {
		t.Errorf("chat = %+v", c)
	}
}

func TestSaveMessageReportsWhetherItIsNew(t *testing.T) {
	s, ctx := open(t), context.Background()
	first, _ := s.SaveMessage(ctx, msg("a", "m1", 0, "x"))
	second, _ := s.SaveMessage(ctx, msg("a", "m1", 0, "x"))
	if !first || second {
		t.Errorf("new flags = %v, %v; want true, false", first, second)
	}
}

func TestChatsOrderUnreadFirstThenNewest(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("old-unread", "m1", 0, "a"))
	s.SaveMessage(ctx, msg("newest-read", "m2", 30, "b"))
	s.SaveMessage(ctx, msg("mid-read", "m3", 10, "c"))
	if err := s.SetUnread(ctx, "old-unread", 2); err != nil {
		t.Fatal(err)
	}
	chats, _ := s.Chats(ctx, 10, 0, All)
	got := []string{chats[0].ID, chats[1].ID, chats[2].ID}
	want := []string{"old-unread", "newest-read", "mid-read"}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("order = %v, want %v", got, want)
		}
	}
	if chats[0].Unread != 2 {
		t.Errorf("unread = %d, want 2", chats[0].Unread)
	}
}

func TestChatsHonoursLimit(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("a", "m1", 0, "a"))
	s.SaveMessage(ctx, msg("b", "m2", 1, "b"))
	chats, _ := s.Chats(ctx, 1, 0, All)
	if len(chats) != 1 || chats[0].ID != "b" {
		t.Errorf("chats = %+v", chats)
	}
}

func TestUpsertChatKeepsNameWhenNewNameIsEmpty(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.UpsertChat(ctx, Chat{ID: "a", Name: "Ana Pop"})
	s.UpsertChat(ctx, Chat{ID: "a", Name: ""})
	c, ok, err := s.Chat(ctx, "a")
	if err != nil || !ok {
		t.Fatalf("Chat: ok=%v err=%v", ok, err)
	}
	if c.Name != "Ana Pop" {
		t.Errorf("name = %q", c.Name)
	}
}

func TestUpsertChatReplacesNameAndGroupFlag(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.UpsertChat(ctx, Chat{ID: "g", Name: "Old"})
	s.UpsertChat(ctx, Chat{ID: "g", Name: "Familia", Group: true})
	c, _, _ := s.Chat(ctx, "g")
	if c.Name != "Familia" || !c.Group {
		t.Errorf("chat = %+v", c)
	}
}

func TestChatReportsMissing(t *testing.T) {
	s := open(t)
	if _, ok, err := s.Chat(context.Background(), "nope"); ok || err != nil {
		t.Errorf("ok=%v err=%v, want false, nil", ok, err)
	}
}

func TestMessagesReturnsLatestInChronologicalOrder(t *testing.T) {
	s, ctx := open(t), context.Background()
	for i, id := range []string{"m1", "m2", "m3", "m4"} {
		s.SaveMessage(ctx, msg("a", id, i, id))
	}
	s.SaveMessage(ctx, msg("other", "x", 9, "x"))
	got, err := s.Messages(ctx, "a", 3, Cursor{})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].ID != "m2" || got[2].ID != "m4" {
		t.Errorf("messages = %+v", got)
	}
}

func TestMessagesBeforeReturnsOlderPage(t *testing.T) {
	s, ctx := open(t), context.Background()
	for i, id := range []string{"m1", "m2", "m3", "m4"} {
		s.SaveMessage(ctx, msg("a", id, i, id))
	}
	got, _ := s.Messages(ctx, "a", 2, Cursor{Time: t0.Add(2 * time.Minute)})
	if len(got) != 2 || got[0].ID != "m1" || got[1].ID != "m2" {
		t.Errorf("messages = %+v", got)
	}
}

func TestMessageFieldsRoundTrip(t *testing.T) {
	s, ctx := open(t), context.Background()
	in := Message{ChatID: "a", ID: "m1", Sender: "Me", FromMe: true, Time: t0, Text: "pa", Kind: "text"}
	s.SaveMessage(ctx, in)
	got, _ := s.Messages(ctx, "a", 1, Cursor{})
	if len(got) != 1 || got[0].Sender != "Me" || !got[0].FromMe || got[0].Text != "pa" || got[0].Kind != "text" || !got[0].Time.Equal(t0) {
		t.Errorf("message = %+v", got)
	}
}

func TestOlderMessageDoesNotReplacePreview(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("a", "new", 10, "new"))
	s.SaveMessage(ctx, msg("a", "old", 0, "old"))
	chats, _ := s.Chats(ctx, 1, 0, All)
	if chats[0].Preview != "new" || !chats[0].LastTime.Equal(t0.Add(10*time.Minute)) {
		t.Errorf("chat = %+v", chats[0])
	}
}

func TestAddUnreadIncrements(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("a", "m1", 0, "a"))
	s.AddUnread(ctx, "a", 1)
	s.AddUnread(ctx, "a", 1)
	c, _, _ := s.Chat(ctx, "a")
	if c.Unread != 2 {
		t.Errorf("unread = %d, want 2", c.Unread)
	}
}

func TestDataSurvivesReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	ctx := context.Background()
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	s.SaveMessage(ctx, msg("a", "m1", 0, "kept"))
	s.Close()
	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	got, _ := s.Messages(ctx, "a", 5, Cursor{})
	if len(got) != 1 || got[0].Text != "kept" {
		t.Errorf("messages = %+v", got)
	}
}

func TestUnansweredListsDirectChatsWhoseNewestMessageIsIncoming(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("waiting", "m1", 0, "ping"))
	s.SaveMessage(ctx, msg("answered", "m2", 1, "ping"))
	mine := msg("answered", "m3", 2, "pong")
	mine.FromMe = true
	s.SaveMessage(ctx, mine)
	s.UpsertChat(ctx, Chat{ID: "group", Name: "Familia", Group: true})
	s.SaveMessage(ctx, msg("group", "m4", 3, "hello all"))

	chats, err := s.Chats(ctx, 10, 0, Unanswered)
	if err != nil {
		t.Fatal(err)
	}
	if len(chats) != 1 || chats[0].ID != "waiting" {
		t.Errorf("unanswered = %+v, want only the chat waiting for a reply", chats)
	}
}

func TestOlderOwnMessageDoesNotMarkChatAsAnswered(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("a", "new", 10, "still waiting"))
	old := msg("a", "old", 0, "mine")
	old.FromMe = true
	s.SaveMessage(ctx, old) // history arrives after the live message
	chats, _ := s.Chats(ctx, 10, 0, Unanswered)
	if len(chats) != 1 {
		t.Errorf("unanswered = %+v, want the chat", chats)
	}
}

func TestOpenUpgradesADatabaseFromBeforeTheAnsweredFlag(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	ctx := context.Background()
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	mine := msg("answered", "m1", 0, "pong")
	mine.FromMe = true
	s.SaveMessage(ctx, mine)
	s.SaveMessage(ctx, msg("waiting", "m2", 1, "ping"))
	// Recreate the 0.1.0 shape: no flag column.
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE chats DROP COLUMN last_from_me`); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	chats, _ := s.Chats(ctx, 10, 0, Unanswered)
	if len(chats) != 1 || chats[0].ID != "waiting" {
		t.Errorf("unanswered after upgrade = %+v", chats)
	}
}

func TestUnreadListsOnlyChatsWithUnreadMessages(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("read", "m1", 0, "old"))
	s.SaveMessage(ctx, msg("unread", "m2", 1, "new"))
	s.AddUnread(ctx, "unread", 1)
	chats, _ := s.Chats(ctx, 10, 0, Unread)
	if len(chats) != 1 || chats[0].ID != "unread" {
		t.Errorf("unread = %+v", chats)
	}
}

func TestUnansweredLeavesOutUnreadChats(t *testing.T) {
	// Unread chats have their own box; a chat is shown in one place only.
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("read-waiting", "m1", 0, "ping"))
	s.SaveMessage(ctx, msg("unread", "m2", 1, "ping"))
	s.AddUnread(ctx, "unread", 1)
	chats, _ := s.Chats(ctx, 10, 0, Unanswered)
	if len(chats) != 1 || chats[0].ID != "read-waiting" {
		t.Errorf("unanswered = %+v", chats)
	}
}

func TestMessagesUseTheCurrentNameOfTheSender(t *testing.T) {
	// History is stored before the address book arrives; names must follow later.
	s, ctx := open(t), context.Background()
	m := msg("group", "m1", 0, "salut")
	m.Sender, m.SenderID = "+40711000001", "40711000001@s.whatsapp.net"
	s.SaveMessage(ctx, m)
	s.UpsertChat(ctx, Chat{ID: "40711000001@s.whatsapp.net", Name: "Ana Pop"})
	got, _ := s.Messages(ctx, "group", 5, Cursor{})
	if len(got) != 1 || got[0].Sender != "Ana Pop" {
		t.Errorf("messages = %+v, want sender Ana Pop", got)
	}
}

func TestMessagesKeepTheStoredSenderWhenNoNameIsKnown(t *testing.T) {
	s, ctx := open(t), context.Background()
	m := msg("group", "m1", 0, "salut")
	m.Sender, m.SenderID = "anutza", "40711000001@s.whatsapp.net"
	s.SaveMessage(ctx, m)
	got, _ := s.Messages(ctx, "group", 5, Cursor{})
	if got[0].Sender != "anutza" {
		t.Errorf("sender = %q, want anutza", got[0].Sender)
	}
}

func TestOpenUpgradeDerivesSenderIDFromStoredPhoneNumbers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	ctx := context.Background()
	s, _ := Open(ctx, path)
	m := msg("group", "m1", 0, "salut")
	m.Sender = "+40711000001"
	s.SaveMessage(ctx, m)
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE messages DROP COLUMN sender_id`); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err := Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	s.UpsertChat(ctx, Chat{ID: "40711000001@s.whatsapp.net", Name: "Ana Pop"})
	got, _ := s.Messages(ctx, "group", 5, Cursor{})
	if len(got) != 1 || got[0].Sender != "Ana Pop" {
		t.Errorf("messages after upgrade = %+v", got)
	}
}

func TestCountsPerBox(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("unread", "m1", 0, "new"))
	s.AddUnread(ctx, "unread", 2)
	s.SaveMessage(ctx, msg("waiting", "m2", 1, "ping"))
	s.SaveMessage(ctx, msg("answered", "m3", 2, "ping"))
	mine := msg("answered", "m4", 3, "pong")
	mine.FromMe = true
	s.SaveMessage(ctx, mine)
	s.UpsertChat(ctx, Chat{ID: "contact-without-messages", Name: "Nobody"})

	got, err := s.Counts(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if want := (Counts{Unread: 1, Unanswered: 1, All: 3}); got != want {
		t.Errorf("counts = %+v, want %+v", got, want)
	}
}

func TestChatsOffsetReturnsTheNextPage(t *testing.T) {
	s, ctx := open(t), context.Background()
	for i, id := range []string{"a", "b", "c", "d", "e"} {
		s.SaveMessage(ctx, msg(id, "m", i, id))
	}
	first, _ := s.Chats(ctx, 2, 0, All)
	second, _ := s.Chats(ctx, 2, 2, All)
	last, _ := s.Chats(ctx, 2, 4, All)
	ids := func(chats []Chat) (out []string) {
		for _, c := range chats {
			out = append(out, c.ID)
		}
		return
	}
	if got := append(append(ids(first), ids(second)...), ids(last)...); len(got) != 5 || got[0] != "e" || got[2] != "c" || got[4] != "a" {
		t.Errorf("pages = %v, want e d | c b | a", got)
	}
}

func TestMessagesBeforeSeparatesMessagesOfTheSameSecond(t *testing.T) {
	s, ctx := open(t), context.Background()
	// Four messages in the same second, as a history sync delivers them.
	for _, id := range []string{"m1", "m2", "m3", "m4"} {
		s.SaveMessage(ctx, msg("a", id, 0, id))
	}
	newest, _ := s.Messages(ctx, "a", 2, Cursor{})
	if len(newest) != 2 || newest[0].ID != "m3" {
		t.Fatalf("newest page = %+v", newest)
	}
	older, _ := s.Messages(ctx, "a", 2, Cursor{Time: newest[0].Time, ID: newest[0].ID})
	if len(older) != 2 || older[0].ID != "m1" || older[1].ID != "m2" {
		t.Errorf("older page = %+v, want m1 and m2", older)
	}
}

func TestPreviewFollowsTheNewestMessageAmongEqualTimes(t *testing.T) {
	s, ctx := open(t), context.Background()
	// Same second: the reading order puts "m2" last, whatever the saving order.
	s.SaveMessage(ctx, msg("a", "m2", 0, "second"))
	mine := msg("a", "m1", 0, "first")
	mine.FromMe = true
	s.SaveMessage(ctx, mine)
	chats, _ := s.Chats(ctx, 1, 0, All)
	messages, _ := s.Messages(ctx, "a", 1, Cursor{})
	if chats[0].Preview != messages[0].Text || chats[0].LastFromMe != messages[0].FromMe {
		t.Errorf("preview = %q (mine=%v), newest message = %q (mine=%v)",
			chats[0].Preview, chats[0].LastFromMe, messages[0].Text, messages[0].FromMe)
	}
}

func TestOpenRepairsPreviewsThatDifferFromTheNewestMessage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "messages.db")
	ctx := context.Background()
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	s.SaveMessage(ctx, msg("a", "m1", 0, "newest"))
	// Recreate what versions up to 0.7.0 could leave behind.
	if _, err := s.db.ExecContext(ctx, `UPDATE chats SET preview = 'stale', last_from_me = 1; PRAGMA user_version = 0`); err != nil {
		t.Fatal(err)
	}
	s.Close()

	s, err = Open(ctx, path)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer s.Close()
	chats, _ := s.Chats(ctx, 1, 0, All)
	if chats[0].Preview != "newest" || chats[0].LastFromMe {
		t.Errorf("chat after repair = %+v", chats[0])
	}
}
