package whatsapp

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func TestMessageText(t *testing.T) {
	cases := []struct {
		name     string
		msg      *waE2E.Message
		wantText string
		wantKind string
	}{
		{"plain conversation", &waE2E.Message{Conversation: proto.String("Salut")}, "Salut", "text"},
		{"extended text", &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("link https://x.ro")}}, "link https://x.ro", "text"},
		{"photo with caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("la mare")}}, "[Photo] la mare", "image"},
		{"photo without caption", &waE2E.Message{ImageMessage: &waE2E.ImageMessage{}}, "[Photo]", "image"},
		{"video", &waE2E.Message{VideoMessage: &waE2E.VideoMessage{Caption: proto.String("uite")}}, "[Video] uite", "video"},
		{"voice message", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{PTT: proto.Bool(true), Seconds: proto.Uint32(75)}}, "[Voice message 1:15]", "audio"},
		{"audio file", &waE2E.Message{AudioMessage: &waE2E.AudioMessage{}}, "[Audio]", "audio"},
		{"document", &waE2E.Message{DocumentMessage: &waE2E.DocumentMessage{FileName: proto.String("oferta.pdf")}}, "[Document] oferta.pdf", "document"},
		{"sticker", &waE2E.Message{StickerMessage: &waE2E.StickerMessage{}}, "[Sticker]", "sticker"},
		{"location", &waE2E.Message{LocationMessage: &waE2E.LocationMessage{Name: proto.String("Piata Unirii")}}, "[Location] Piata Unirii", "location"},
		{"contact card", &waE2E.Message{ContactMessage: &waE2E.ContactMessage{DisplayName: proto.String("Ana Pop")}}, "[Contact] Ana Pop", "contact"},
		{"poll", &waE2E.Message{PollCreationMessageV3: &waE2E.PollCreationMessage{Name: proto.String("Unde mergem?")}}, "[Poll] Unde mergem?", "poll"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			text, kind, ok := messageText(c.msg)
			if !ok || text != c.wantText || kind != c.wantKind {
				t.Errorf("messageText = %q, %q, %v; want %q, %q, true", text, kind, ok, c.wantText, c.wantKind)
			}
		})
	}
}

func TestMessageTextSkipsWhatIsNotAMessageToRead(t *testing.T) {
	cases := map[string]*waE2E.Message{
		"nil":      nil,
		"empty":    {},
		"reaction": {ReactionMessage: &waE2E.ReactionMessage{Text: proto.String("👍")}},
		"protocol": {ProtocolMessage: &waE2E.ProtocolMessage{}},
	}
	for name, msg := range cases {
		t.Run(name, func(t *testing.T) {
			if text, kind, ok := messageText(msg); ok {
				t.Errorf("messageText = %q, %q, true; want skipped", text, kind)
			}
		})
	}
}

func TestBestName(t *testing.T) {
	cases := []struct {
		name     string
		contact  types.ContactInfo
		pushName string
		want     string
	}{
		{"address book name wins", types.ContactInfo{FullName: "Ana Pop", PushName: "anutza"}, "anutza", "Ana Pop"},
		{"first name when no full name", types.ContactInfo{FirstName: "Ana"}, "", "Ana"},
		{"push name from the message", types.ContactInfo{}, "anutza", "anutza"},
		{"cached push name", types.ContactInfo{PushName: "cached"}, "", "cached"},
		{"business name", types.ContactInfo{BusinessName: "Pizzeria"}, "", "Pizzeria"},
		{"nothing known", types.ContactInfo{}, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := bestName(c.contact, c.pushName); got != c.want {
				t.Errorf("bestName = %q, want %q", got, c.want)
			}
		})
	}
}

func TestSkipChat(t *testing.T) {
	cases := map[string]bool{
		"40711@s.whatsapp.net": false,
		"12345@lid":            false,
		"123-456@g.us":         false,
		"status@broadcast":     true,
		"999@newsletter":       true,
		"40711@broadcast":      true,
	}
	for raw, want := range cases {
		jid, err := types.ParseJID(raw)
		if err != nil {
			t.Fatalf("ParseJID(%q): %v", raw, err)
		}
		if got := skipChat(jid); got != want {
			t.Errorf("skipChat(%s) = %v, want %v", raw, got, want)
		}
	}
}
