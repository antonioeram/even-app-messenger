package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/antonioeram/even-app-messenger/gateway/internal/store"
	"github.com/antonioeram/even-app-messenger/gateway/internal/translit"
)

// ChatStore is the part of the message store the API reads.
type ChatStore interface {
	Chats(ctx context.Context, limit int, filter store.Filter) ([]store.Chat, error)
	SetUnread(ctx context.Context, chatID string, unread int) error
	Chat(ctx context.Context, id string) (store.Chat, bool, error)
	Messages(ctx context.Context, chatID string, limit int, before time.Time) ([]store.Message, error)
}

// Sender delivers a text message to an existing chat.
type Sender interface {
	Send(ctx context.Context, chatID, text string) error
}

// Limits for replies. A recording is 16 kHz, 16 bit, mono: 32 kB per second.
const (
	maxSendChars     = 4000
	maxRecordingSize = 16000 * 2 * 120
)

// LinkStatus describes the WhatsApp session for the admin page.
type LinkStatus struct {
	// State is "starting", "pairing", "pairing_expired", "connected",
	// "disconnected" or "logged_out".
	State string
	// QR is the current pairing code while State is "pairing".
	QR string
	// Account is the linked phone number, once connected.
	Account string
}

const (
	defaultLimit = 20
	maxLimit     = 100
)

type chatJSON struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Group   bool   `json:"group"`
	Unread  int    `json:"unread"`
	Time    string `json:"time"`
	Clock   string `json:"clock"`
	Preview string `json:"preview"`
}

type messageJSON struct {
	ID     string `json:"id"`
	Sender string `json:"sender"`
	FromMe bool   `json:"from_me"`
	Time   string `json:"time"`
	Clock  string `json:"clock"`
	Text   string `json:"text"`
	Kind   string `json:"kind"`
}

// api holds what the stage 1 handlers share.
type api struct {
	store      ChatStore
	link       func() LinkStatus
	pair       func()
	sender     Sender
	transcribe func(ctx context.Context, pcm []byte) (string, string, error)
	log        *slog.Logger
	now        func() time.Time
	loc        *time.Location
}

func (a *api) chats(w http.ResponseWriter, r *http.Request) {
	if a.store == nil {
		writeError(w, http.StatusServiceUnavailable, "message store is not configured")
		return
	}
	limit, ok := limitParam(w, r)
	if !ok {
		return
	}
	filter := store.All
	switch r.URL.Query().Get("filter") {
	case "":
	case "unread":
		filter = store.Unread
	case "unanswered":
		filter = store.Unanswered
	default:
		writeError(w, http.StatusBadRequest, "filter must be unread, unanswered or absent")
		return
	}
	chats, err := a.store.Chats(r.Context(), limit, filter)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read chats")
		return
	}
	out := make([]chatJSON, 0, len(chats))
	for _, c := range chats {
		out = append(out, a.chatJSON(c))
	}
	writeJSON(w, http.StatusOK, map[string]any{"chats": out})
}

func (a *api) messages(w http.ResponseWriter, r *http.Request) {
	if a.store == nil {
		writeError(w, http.StatusServiceUnavailable, "message store is not configured")
		return
	}
	limit, ok := limitParam(w, r)
	if !ok {
		return
	}
	var before time.Time
	if raw := r.URL.Query().Get("before"); raw != "" {
		parsed, err := time.Parse(time.RFC3339Nano, raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "before must be an RFC 3339 time")
			return
		}
		before = parsed
	}
	chat, found, err := a.store.Chat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read chat")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "unknown chat")
		return
	}
	messages, err := a.store.Messages(r.Context(), chat.ID, limit, before)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read messages")
		return
	}
	chatOut := a.chatJSON(chat)
	out := make([]messageJSON, 0, len(messages))
	for _, m := range messages {
		sender := translit.ASCII(m.Sender)
		switch {
		case m.FromMe:
			sender = "Me"
		case sender == "" || !chat.Group:
			// In a direct chat the other person is the chat itself; its name
			// is kept current, while a stored sender may be a bare number.
			sender = chatOut.Name
		}
		out = append(out, messageJSON{
			ID:     m.ID,
			Sender: sender,
			FromMe: m.FromMe,
			Time:   m.Time.UTC().Format(time.RFC3339),
			Clock:  a.clock(m.Time),
			Text:   displayText(m.Text),
			Kind:   m.Kind,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"chat": chatOut, "messages": out})
}

// markRead clears the gateway's own unread counter for a chat. It does not
// send a read receipt to WhatsApp.
func (a *api) markRead(w http.ResponseWriter, r *http.Request) {
	if a.store == nil {
		writeError(w, http.StatusServiceUnavailable, "message store is not configured")
		return
	}
	chat, found, err := a.store.Chat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read chat")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "unknown chat")
		return
	}
	if err := a.store.SetUnread(r.Context(), chat.ID, 0); err != nil {
		writeError(w, http.StatusInternalServerError, "could not mark chat read")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "read"})
}

// send delivers a reply. The text is sent exactly as received; only chats
// that already exist can be answered.
func (a *api) send(w http.ResponseWriter, r *http.Request) {
	if a.sender == nil || a.store == nil {
		writeError(w, http.StatusServiceUnavailable, "sending is not enabled")
		return
	}
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "body must be JSON with a text field")
		return
	}
	text := strings.TrimSpace(body.Text)
	if text == "" || utf8.RuneCountInString(text) > maxSendChars {
		writeError(w, http.StatusBadRequest, "text must have 1 to 4000 characters")
		return
	}
	chat, found, err := a.store.Chat(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusInternalServerError, "could not read chat")
		return
	}
	if !found {
		writeError(w, http.StatusNotFound, "unknown chat")
		return
	}
	if err := a.sender.Send(r.Context(), chat.ID, text); err != nil {
		a.log.Warn("send failed", "error", err)
		writeError(w, http.StatusBadGateway, "message was not sent: "+translit.ASCII(err.Error()))
		return
	}
	// The log records that a message was sent, never its text.
	a.log.Info("message sent", "chars", utf8.RuneCountInString(text))
	writeJSON(w, http.StatusOK, map[string]string{"status": "sent"})
}

// transcribeAudio turns a recording into text. It returns the text to send
// and an ASCII copy to display on the glasses.
func (a *api) transcribeAudio(w http.ResponseWriter, r *http.Request) {
	if a.transcribe == nil {
		writeError(w, http.StatusServiceUnavailable, "speech-to-text is not configured")
		return
	}
	pcm, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxRecordingSize))
	if err != nil {
		writeError(w, http.StatusRequestEntityTooLarge, "recording is longer than 2 minutes")
		return
	}
	if len(pcm) < 2 {
		writeError(w, http.StatusBadRequest, "recording is empty")
		return
	}
	text, lang, err := a.transcribe(r.Context(), pcm)
	if err != nil {
		a.log.Warn("transcription failed", "error", err)
		writeError(w, http.StatusBadGateway, "transcription failed: "+translit.ASCII(err.Error()))
		return
	}
	a.log.Info("transcribed", "seconds", len(pcm)/32000, "lang", lang, "chars", utf8.RuneCountInString(text))
	writeJSON(w, http.StatusOK, map[string]string{"text": text, "display": displayText(text), "lang": lang})
}

func (a *api) adminStatus(w http.ResponseWriter, r *http.Request) {
	status := LinkStatus{State: "disabled"}
	if a.link != nil {
		status = a.link()
	}
	qr := ""
	if status.QR != "" {
		png, err := qrcode.Encode(status.QR, qrcode.Medium, 360)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "could not render the pairing code")
			return
		}
		qr = "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)
	}
	writeJSON(w, http.StatusOK, map[string]string{"state": status.State, "account": status.Account, "qr_png": qr})
}

func (a *api) adminPair(w http.ResponseWriter, r *http.Request) {
	if a.pair == nil {
		writeError(w, http.StatusServiceUnavailable, "whatsapp is not enabled")
		return
	}
	a.pair()
	writeJSON(w, http.StatusAccepted, map[string]string{"status": "pairing requested"})
}

func (a *api) adminPage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	_, _ = w.Write([]byte(adminHTML))
}

func (a *api) chatJSON(c store.Chat) chatJSON {
	name := translit.ASCII(c.Name)
	if name == "" {
		name = nameFromID(c.ID)
	}
	out := chatJSON{ID: c.ID, Name: name, Group: c.Group, Unread: c.Unread, Preview: displayText(c.Preview)}
	if !c.LastTime.IsZero() {
		out.Time = c.LastTime.UTC().Format(time.RFC3339)
		out.Clock = a.clock(c.LastTime)
	}
	return out
}

// displayText reduces message text to ASCII. A message made only of emoji
// would vanish, so it is shown as a label instead.
func displayText(text string) string {
	ascii := translit.ASCII(text)
	if ascii == "" && strings.TrimSpace(text) != "" {
		return "[emoji]"
	}
	return ascii
}

// clock formats t for the glasses: the hour for today, the date otherwise.
func (a *api) clock(t time.Time) string {
	local, now := t.In(a.loc), a.now().In(a.loc)
	if local.Year() == now.Year() && local.YearDay() == now.YearDay() {
		return local.Format("15:04")
	}
	return local.Format("02.01")
}

// nameFromID turns a WhatsApp address into something readable when no
// contact name is known: "+40722123456" for a phone number.
func nameFromID(id string) string {
	user, server, _ := strings.Cut(id, "@")
	if server == "s.whatsapp.net" && user != "" && strings.Trim(user, "0123456789") == "" {
		return "+" + user
	}
	return user
}

func limitParam(w http.ResponseWriter, r *http.Request) (int, bool) {
	raw := r.URL.Query().Get("limit")
	if raw == "" {
		return defaultLimit, true
	}
	limit, err := strconv.Atoi(raw)
	if err != nil || limit < 1 {
		writeError(w, http.StatusBadRequest, "limit must be a positive number")
		return 0, false
	}
	return min(limit, maxLimit), true
}

// adminHTML is the pairing page. It holds no data and no secret: the token
// is typed in, kept in the tab's session storage and sent as a header.
const adminHTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Messenger gateway</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; padding: 24px 16px; background: #111; color: #eee; }
  main { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 20px; }
  input, button { font: inherit; padding: 8px 10px; border-radius: 6px; border: 1px solid #555; background: #222; color: #eee; }
  input { width: 100%; box-sizing: border-box; margin-bottom: 8px; }
  #state { font-weight: 600; }
  #qr { display: none; width: 100%; max-width: 360px; background: #fff; padding: 12px; box-sizing: border-box; border-radius: 8px; margin-top: 12px; }
  .muted { color: #999; font-size: 14px; }
</style>
</head>
<body>
<main>
  <h1>Messenger gateway</h1>
  <form id="login">
    <input id="token" type="password" autocomplete="off" placeholder="Gateway token">
    <button>Connect</button>
  </form>
  <p>WhatsApp: <span id="state">-</span> <span id="account" class="muted"></span></p>
  <img id="qr" alt="WhatsApp pairing code">
  <p><button id="pair" hidden>Show a new pairing code</button></p>
  <p id="hint" class="muted"></p>
</main>
<script>
  const $ = (id) => document.getElementById(id);
  const HINTS = {
    pairing: 'On the phone: WhatsApp > Settings > Linked devices > Link a device, then scan this code.',
    connected: 'Linked. Messages are being stored.',
    pairing_expired: 'The pairing codes expired. Ask for a new one when the phone is at hand.',
    logged_out: 'The phone removed this device. Restart the gateway to pair again.',
    disconnected: 'Not connected to WhatsApp; the gateway retries on its own.',
    starting: 'Starting...',
    disabled: 'WhatsApp is not enabled on this gateway.',
  };
  // A link may carry the token as #token=...; a fragment is never sent to the server.
  const fragment = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fragment) {
    sessionStorage.setItem('token', fragment);
    history.replaceState(null, '', location.pathname);
  }
  let token = sessionStorage.getItem('token') || '';
  const authHeaders = () => (token ? { Authorization: 'Bearer ' + token } : {});
  $('pair').addEventListener('click', async () => {
    await fetch('/admin/pair', { method: 'POST', headers: authHeaders() });
    refresh();
  });
  $('token').value = token;
  $('login').addEventListener('submit', (event) => {
    event.preventDefault();
    token = $('token').value.trim();
    sessionStorage.setItem('token', token);
    refresh();
  });
  async function refresh() {
    try {
      const response = await fetch('/admin/status', { headers: authHeaders(), cache: 'no-store' });
      if (response.status === 401) { show('token required', '', '', 'Type the gateway token and press Connect.'); return; }
      const body = await response.json();
      show(body.state, body.account, body.qr_png, HINTS[body.state] || '');
    } catch (error) {
      show('gateway unreachable', '', '', String(error));
    }
  }
  function show(state, account, qr, hint) {
    $('state').textContent = state;
    $('account').textContent = account || '';
    $('hint').textContent = hint;
    $('pair').hidden = state !== 'pairing_expired';
    $('login').hidden = state !== 'token required' && state !== 'gateway unreachable' && state !== '-';
    $('qr').style.display = qr ? 'block' : 'none';
    if (qr) $('qr').src = qr;
  }
  refresh();
  setInterval(refresh, 3000);
</script>
</body>
</html>
`
