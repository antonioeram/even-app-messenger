// Package whatsapp links the gateway to a WhatsApp account as a companion
// device (whatsmeow) and copies chats and messages into the message store.
// The only thing it sends is a reply that the user confirmed; it never sends
// read receipts.
package whatsapp

import (
	"fmt"
	"strings"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
)

// messageText returns what the glasses show for a message: its text, or a
// bracketed label for media. ok is false for things that are not messages
// to read (reactions, protocol messages, unknown types).
func messageText(msg *waE2E.Message) (text, kind string, ok bool) {
	if msg == nil {
		return "", "", false
	}
	switch {
	case msg.GetConversation() != "":
		return msg.GetConversation(), "text", true
	case msg.GetExtendedTextMessage() != nil:
		return msg.GetExtendedTextMessage().GetText(), "text", true
	case msg.GetImageMessage() != nil:
		return label("Photo", msg.GetImageMessage().GetCaption()), "image", true
	case msg.GetVideoMessage() != nil:
		return label("Video", msg.GetVideoMessage().GetCaption()), "video", true
	case msg.GetPtvMessage() != nil:
		return "[Video note]", "video", true
	case msg.GetAudioMessage() != nil:
		audio := msg.GetAudioMessage()
		if !audio.GetPTT() {
			return "[Audio]", "audio", true
		}
		if s := audio.GetSeconds(); s > 0 {
			return fmt.Sprintf("[Voice message %d:%02d]", s/60, s%60), "audio", true
		}
		return "[Voice message]", "audio", true
	case msg.GetDocumentMessage() != nil:
		doc := msg.GetDocumentMessage()
		return label("Document", strings.TrimSpace(doc.GetFileName()+" "+doc.GetCaption())), "document", true
	case msg.GetStickerMessage() != nil:
		return "[Sticker]", "sticker", true
	case msg.GetLocationMessage() != nil:
		return label("Location", msg.GetLocationMessage().GetName()), "location", true
	case msg.GetLiveLocationMessage() != nil:
		return "[Live location]", "location", true
	case msg.GetContactMessage() != nil:
		return label("Contact", msg.GetContactMessage().GetDisplayName()), "contact", true
	case msg.GetContactsArrayMessage() != nil:
		return "[Contacts]", "contact", true
	case msg.GetEventMessage() != nil:
		return label("Event", msg.GetEventMessage().GetName()), "event", true
	}
	for _, poll := range []*waE2E.PollCreationMessage{
		msg.GetPollCreationMessage(), msg.GetPollCreationMessageV2(), msg.GetPollCreationMessageV3(),
		msg.GetPollCreationMessageV5(), msg.GetPollCreationMessageV6(),
	} {
		if poll != nil {
			return label("Poll", poll.GetName()), "poll", true
		}
	}
	return "", "", false
}

func label(kind, detail string) string {
	if detail = strings.TrimSpace(detail); detail != "" {
		return "[" + kind + "] " + detail
	}
	return "[" + kind + "]"
}

// bestName picks the most useful display name: the address book entry, then
// the name the person set for themselves, then a business name.
func bestName(contact types.ContactInfo, pushName string) string {
	for _, name := range []string{contact.FullName, contact.FirstName, pushName, contact.PushName, contact.BusinessName} {
		if name = strings.TrimSpace(name); name != "" {
			return name
		}
	}
	return ""
}

// skipChat reports chats the inbox does not show: status updates, broadcast
// lists and channels.
func skipChat(chat types.JID) bool {
	return chat.Server == types.BroadcastServer || chat.Server == types.NewsletterServer
}
