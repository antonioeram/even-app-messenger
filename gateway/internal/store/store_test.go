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
	chats, err := s.Chats(ctx, 10)
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
	chats, _ := s.Chats(ctx, 10)
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
	chats, _ := s.Chats(ctx, 1)
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
	got, err := s.Messages(ctx, "a", 3, time.Time{})
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
	got, _ := s.Messages(ctx, "a", 2, t0.Add(2*time.Minute))
	if len(got) != 2 || got[0].ID != "m1" || got[1].ID != "m2" {
		t.Errorf("messages = %+v", got)
	}
}

func TestMessageFieldsRoundTrip(t *testing.T) {
	s, ctx := open(t), context.Background()
	in := Message{ChatID: "a", ID: "m1", Sender: "Me", FromMe: true, Time: t0, Text: "pa", Kind: "text"}
	s.SaveMessage(ctx, in)
	got, _ := s.Messages(ctx, "a", 1, time.Time{})
	if len(got) != 1 || got[0].Sender != "Me" || !got[0].FromMe || got[0].Text != "pa" || got[0].Kind != "text" || !got[0].Time.Equal(t0) {
		t.Errorf("message = %+v", got)
	}
}

func TestOlderMessageDoesNotReplacePreview(t *testing.T) {
	s, ctx := open(t), context.Background()
	s.SaveMessage(ctx, msg("a", "new", 10, "new"))
	s.SaveMessage(ctx, msg("a", "old", 0, "old"))
	chats, _ := s.Chats(ctx, 1)
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
	got, _ := s.Messages(ctx, "a", 5, time.Time{})
	if len(got) != 1 || got[0].Text != "kept" {
		t.Errorf("messages = %+v", got)
	}
}
