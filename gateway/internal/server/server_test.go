package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/antonioeram/even-app-messenger/gateway/internal/config"
	"github.com/antonioeram/even-app-messenger/gateway/internal/store"
)

var fixedNow = time.Date(2026, 11, 12, 9, 41, 7, 0, time.UTC)

func newTestHandler(cfg config.Config) http.Handler {
	if cfg.CORSOrigins == nil {
		cfg.CORSOrigins = []string{"*"}
	}
	return New(cfg, Options{
		Version: "test",
		Now:     func() time.Time { return fixedNow },
	})
}

func do(t *testing.T, h http.Handler, method, path string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("body is not JSON: %v (%s)", err, rec.Body.String())
	}
	return body
}

func TestHealthReportsOkAndVersion(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decode(t, rec)
	if body["status"] != "ok" {
		t.Errorf("status field = %v, want ok", body["status"])
	}
	if body["version"] != "test" {
		t.Errorf("version field = %v, want test", body["version"])
	}
}

func TestResponsesAreNotCacheable(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, &fakeStore{}, nil), http.MethodGet, "/counts", nil)
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("Cache-Control = %q, want no-store", cc)
	}
}

func TestUnknownPathReturnsJSON404(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/nope", nil)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
	if body := decode(t, rec); body["error"] == nil {
		t.Errorf("404 body has no error field: %v", body)
	}
}

func TestWrongMethodReturns405(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodPost, "/health", nil)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", rec.Code)
	}
}

func TestWildcardCORSAllowsAnyOrigin(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, &fakeStore{}, nil), http.MethodGet, "/counts",
		map[string]string{"Origin": "https://webview.example"})
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

func TestListedCORSOriginIsEchoedAndOthersAreNot(t *testing.T) {
	h := newStoreHandler(config.Config{CORSOrigins: []string{"https://app.example"}}, &fakeStore{}, nil)

	allowed := do(t, h, http.MethodGet, "/counts", map[string]string{"Origin": "https://app.example"})
	if got := allowed.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Errorf("allowed origin: Access-Control-Allow-Origin = %q", got)
	}
	if got := allowed.Header().Get("Vary"); !strings.Contains(got, "Origin") {
		t.Errorf("allowed origin: Vary = %q, want it to include Origin", got)
	}

	denied := do(t, h, http.MethodGet, "/counts", map[string]string{"Origin": "https://evil.example"})
	if got := denied.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("denied origin: Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestPreflightIsAnsweredWithoutAuth(t *testing.T) {
	h := newStoreHandler(config.Config{Token: "s3cret"}, &fakeStore{}, nil)
	rec := do(t, h, http.MethodOptions, "/counts", map[string]string{
		"Origin":                         "https://webview.example",
		"Access-Control-Request-Method":  "GET",
		"Access-Control-Request-Headers": "authorization",
	})
	if rec.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); !strings.Contains(got, "GET") || !strings.Contains(got, "POST") {
		t.Errorf("Access-Control-Allow-Methods = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(got, "Authorization") || !strings.Contains(got, "Content-Type") {
		t.Errorf("Access-Control-Allow-Headers = %q", got)
	}
	if got := rec.Header().Get("Access-Control-Max-Age"); got == "" {
		t.Errorf("Access-Control-Max-Age is missing")
	}
}

func TestTokenIsRequiredWhenConfigured(t *testing.T) {
	h := newStoreHandler(config.Config{Token: "s3cret"}, &fakeStore{}, nil)

	cases := []struct {
		name   string
		header string
		want   int
	}{
		{"no header", "", http.StatusUnauthorized},
		{"wrong token", "Bearer nope", http.StatusUnauthorized},
		{"wrong scheme", "Basic s3cret", http.StatusUnauthorized},
		{"correct token", "Bearer s3cret", http.StatusOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string]string{"Origin": "https://webview.example"}
			if tc.header != "" {
				headers["Authorization"] = tc.header
			}
			rec := do(t, h, http.MethodGet, "/counts", headers)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
			// The WebView can only read the 401 if it carries CORS headers too.
			if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
				t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
			}
		})
	}
}

func TestHealthStaysOpenWhenTokenIsConfigured(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{Token: "s3cret"}), http.MethodGet, "/health", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

func TestAPIIsOpenWhenNoTokenIsConfigured(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, &fakeStore{}, nil), http.MethodGet, "/counts", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}

// --- chats and messages ---

type fakeStore struct {
	chats     []store.Chat
	messages  map[string][]store.Message
	gotLimit  int
	gotBefore store.Cursor
	gotFilter store.Filter
	gotOffset int
	readChat  string
}

func (f *fakeStore) SetUnread(_ context.Context, chatID string, unread int) error {
	if unread == 0 {
		f.readChat = chatID
	}
	return nil
}

func (f *fakeStore) Chats(_ context.Context, limit, offset int, filter store.Filter) ([]store.Chat, error) {
	f.gotLimit, f.gotOffset, f.gotFilter = limit, offset, filter
	return f.chats, nil
}

func (f *fakeStore) Chat(_ context.Context, id string) (store.Chat, bool, error) {
	for _, c := range f.chats {
		if c.ID == id {
			return c, true, nil
		}
	}
	return store.Chat{}, false, nil
}

func (f *fakeStore) Messages(_ context.Context, chatID string, limit int, before store.Cursor) ([]store.Message, error) {
	f.gotLimit, f.gotBefore = limit, before
	return f.messages[chatID], nil
}

func newStoreHandler(cfg config.Config, st ChatStore, link func() LinkStatus) http.Handler {
	if cfg.CORSOrigins == nil {
		cfg.CORSOrigins = []string{"*"}
	}
	return New(cfg, Options{
		Version: "test",
		Now:     func() time.Time { return fixedNow },
		Store:   st, Link: link,
		Location: time.UTC,
	})
}

func sampleStore() *fakeStore {
	return &fakeStore{
		chats: []store.Chat{
			{ID: "40711@s.whatsapp.net", Name: "Ștefan Țîru", Unread: 2, LastTime: fixedNow.Add(-5 * time.Minute), Preview: "Vii mâine? 👍"},
			{ID: "123@g.us", Name: "Familia", Group: true, LastTime: fixedNow.Add(-26 * time.Hour), Preview: "ok"},
		},
		messages: map[string][]store.Message{
			"40711@s.whatsapp.net": {
				{ChatID: "40711@s.whatsapp.net", ID: "m1", Sender: "Ștefan Țîru", Time: fixedNow.Add(-6 * time.Minute), Text: "Bună", Kind: "text"},
				{ChatID: "40711@s.whatsapp.net", ID: "m2", Sender: "", FromMe: true, Time: fixedNow.Add(-5 * time.Minute), Text: "Vii mâine? 👍", Kind: "text"},
			},
		},
	}
}

func TestChatsListsChatsInASCII(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, sampleStore(), nil), http.MethodGet, "/chats", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	chats := decode(t, rec)["chats"].([]any)
	if len(chats) != 2 {
		t.Fatalf("got %d chats", len(chats))
	}
	first := chats[0].(map[string]any)
	if first["id"] != "40711@s.whatsapp.net" || first["name"] != "Stefan Tiru" || first["preview"] != "Vii maine?" {
		t.Errorf("first chat = %v", first)
	}
	if first["unread"] != float64(2) || first["group"] != false {
		t.Errorf("first chat = %v", first)
	}
	// Today's messages show the hour, older ones the date.
	if first["clock"] != "09:36" {
		t.Errorf("clock = %v, want 09:36", first["clock"])
	}
	if second := chats[1].(map[string]any); second["clock"] != "11.11" || second["group"] != true {
		t.Errorf("second chat = %v", second)
	}
}

func TestChatsRequiresToken(t *testing.T) {
	h := newStoreHandler(config.Config{Token: "s3cret"}, sampleStore(), nil)
	if rec := do(t, h, http.MethodGet, "/chats", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("without token: status = %d, want 401", rec.Code)
	}
	if rec := do(t, h, http.MethodGet, "/chats/x/messages", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("messages without token: status = %d, want 401", rec.Code)
	}
	if rec := do(t, h, http.MethodGet, "/admin/status", nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("admin status without token: status = %d, want 401", rec.Code)
	}
}

func TestChatsLimitIsCappedAndDefaulted(t *testing.T) {
	st := sampleStore()
	h := newStoreHandler(config.Config{}, st, nil)
	do(t, h, http.MethodGet, "/chats", nil)
	if st.gotLimit != 20 {
		t.Errorf("default limit = %d, want 20", st.gotLimit)
	}
	do(t, h, http.MethodGet, "/chats?limit=500", nil)
	if st.gotLimit != 100 {
		t.Errorf("capped limit = %d, want 100", st.gotLimit)
	}
	if rec := do(t, h, http.MethodGet, "/chats?limit=abc", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad limit: status = %d, want 400", rec.Code)
	}
}

func TestMessagesReturnsChatAndMessages(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, sampleStore(), nil), http.MethodGet, "/chats/40711@s.whatsapp.net/messages", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if chat := body["chat"].(map[string]any); chat["name"] != "Stefan Tiru" {
		t.Errorf("chat = %v", chat)
	}
	messages := body["messages"].([]any)
	if len(messages) != 2 {
		t.Fatalf("got %d messages", len(messages))
	}
	m1, m2 := messages[0].(map[string]any), messages[1].(map[string]any)
	if m1["sender"] != "Stefan Tiru" || m1["text"] != "Buna" || m1["from_me"] != false || m1["clock"] != "09:35" {
		t.Errorf("m1 = %v", m1)
	}
	if m2["sender"] != "Me" || m2["from_me"] != true || m2["text"] != "Vii maine?" {
		t.Errorf("m2 = %v", m2)
	}
}

func TestMessagesPassesBeforeAndLimit(t *testing.T) {
	st := sampleStore()
	h := newStoreHandler(config.Config{}, st, nil)
	do(t, h, http.MethodGet, "/chats/40711@s.whatsapp.net/messages?limit=5&before=2026-11-12T09:00:00Z&before_id=m7", nil)
	if st.gotLimit != 5 || !st.gotBefore.Time.Equal(time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)) || st.gotBefore.ID != "m7" {
		t.Errorf("limit=%d before=%+v", st.gotLimit, st.gotBefore)
	}
	if rec := do(t, h, http.MethodGet, "/chats/40711@s.whatsapp.net/messages?before_id=m7", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("before_id without before: status = %d, want 400", rec.Code)
	}
	if rec := do(t, h, http.MethodGet, "/chats/40711@s.whatsapp.net/messages?before=yesterday", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("bad before: status = %d, want 400", rec.Code)
	}
}

func TestMessagesUnknownChatIs404(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{}, sampleStore(), nil), http.MethodGet, "/chats/nope/messages", nil)
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}

func TestChatWithoutNameFallsBackToItsNumber(t *testing.T) {
	st := &fakeStore{chats: []store.Chat{{ID: "40722123456@s.whatsapp.net", LastTime: fixedNow, Preview: "x"}}}
	rec := do(t, newStoreHandler(config.Config{}, st, nil), http.MethodGet, "/chats", nil)
	first := decode(t, rec)["chats"].([]any)[0].(map[string]any)
	if first["name"] != "+40722123456" {
		t.Errorf("name = %v, want +40722123456", first["name"])
	}
}

func TestChatsWithoutStoreIs503(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/chats", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestAdminStatusReportsLinkStateAndQR(t *testing.T) {
	link := func() LinkStatus { return LinkStatus{State: "pairing", QR: "2@abc,def"} }
	rec := do(t, newStoreHandler(config.Config{}, sampleStore(), link), http.MethodGet, "/admin/status", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	body := decode(t, rec)
	if body["state"] != "pairing" {
		t.Errorf("state = %v", body["state"])
	}
	qr, _ := body["qr_png"].(string)
	if !strings.HasPrefix(qr, "data:image/png;base64,") || len(qr) < 200 {
		t.Errorf("qr_png = %.40q (len %d)", qr, len(qr))
	}
	// The raw pairing code is a credential for linking a device; only the image leaves the gateway.
	if strings.Contains(rec.Body.String(), "2@abc") {
		t.Error("response leaks the raw pairing code")
	}
}

func TestAdminStatusWithoutQRWhenConnected(t *testing.T) {
	link := func() LinkStatus { return LinkStatus{State: "connected", Account: "+40711"} }
	body := decode(t, do(t, newStoreHandler(config.Config{}, sampleStore(), link), http.MethodGet, "/admin/status", nil))
	if body["state"] != "connected" || body["account"] != "+40711" || body["qr_png"] != "" {
		t.Errorf("body = %v", body)
	}
}

func TestAdminPageIsHTMLAndCarriesNoToken(t *testing.T) {
	rec := do(t, newStoreHandler(config.Config{Token: "s3cret"}, sampleStore(), nil), http.MethodGet, "/admin", nil)
	if rec.Code != http.StatusOK || !strings.HasPrefix(rec.Header().Get("Content-Type"), "text/html") {
		t.Fatalf("status = %d, type = %q", rec.Code, rec.Header().Get("Content-Type"))
	}
	if strings.Contains(rec.Body.String(), "s3cret") {
		t.Error("admin page embeds the token")
	}
}

func TestAdminPairRestartsPairing(t *testing.T) {
	calls := 0
	h := New(config.Config{Token: "s3cret", CORSOrigins: []string{"*"}}, Options{
		Version: "test",
		Pair:    func() { calls++ },
	})
	if rec := do(t, h, http.MethodPost, "/admin/pair", nil); rec.Code != http.StatusUnauthorized || calls != 0 {
		t.Fatalf("without token: status = %d, calls = %d", rec.Code, calls)
	}
	rec := do(t, h, http.MethodPost, "/admin/pair", map[string]string{"Authorization": "Bearer s3cret"})
	if rec.Code != http.StatusAccepted || calls != 1 {
		t.Errorf("status = %d, calls = %d; want 202, 1", rec.Code, calls)
	}
}

func TestAdminPairWithoutWhatsAppIs503(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodPost, "/admin/pair", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
}

func TestAdminPageReadsTheTokenFromTheURLFragment(t *testing.T) {
	// A fragment never reaches the server or its logs, unlike a query string.
	body := do(t, newTestHandler(config.Config{}), http.MethodGet, "/admin", nil).Body.String()
	if !strings.Contains(body, "location.hash") || !strings.Contains(body, "replaceState") {
		t.Error("admin page does not read and clear a #token= fragment")
	}
}

func TestChatsFilters(t *testing.T) {
	st := sampleStore()
	h := newStoreHandler(config.Config{}, st, nil)
	for query, want := range map[string]store.Filter{"": store.All, "?filter=unread": store.Unread, "?filter=unanswered": store.Unanswered} {
		do(t, h, http.MethodGet, "/chats"+query, nil)
		if st.gotFilter != want {
			t.Errorf("/chats%s: filter = %v, want %v", query, st.gotFilter, want)
		}
	}
	if rec := do(t, h, http.MethodGet, "/chats?filter=bogus", nil); rec.Code != http.StatusBadRequest {
		t.Errorf("unknown filter: status = %d, want 400", rec.Code)
	}
}

func TestDirectChatMessagesShowTheChatNameNotAPhoneNumber(t *testing.T) {
	st := &fakeStore{
		chats: []store.Chat{{ID: "40711@s.whatsapp.net", Name: "Ana Pop", LastTime: fixedNow, Preview: "x"}},
		messages: map[string][]store.Message{"40711@s.whatsapp.net": {
			{ChatID: "40711@s.whatsapp.net", ID: "m1", Sender: "+40711", Time: fixedNow, Text: "Buna"},
		}},
	}
	rec := do(t, newStoreHandler(config.Config{}, st, nil), http.MethodGet, "/chats/40711@s.whatsapp.net/messages", nil)
	if got := decode(t, rec)["messages"].([]any)[0].(map[string]any)["sender"]; got != "Ana Pop" {
		t.Errorf("sender = %v, want Ana Pop", got)
	}
}

func TestMarkReadClearsTheUnreadCounter(t *testing.T) {
	st := sampleStore()
	h := newStoreHandler(config.Config{Token: "s3cret"}, st, nil)
	if rec := do(t, h, http.MethodPost, "/chats/40711@s.whatsapp.net/read", nil); rec.Code != http.StatusUnauthorized || st.readChat != "" {
		t.Fatalf("without token: status = %d, read %q", rec.Code, st.readChat)
	}
	auth := map[string]string{"Authorization": "Bearer s3cret"}
	if rec := do(t, h, http.MethodPost, "/chats/40711@s.whatsapp.net/read", auth); rec.Code != http.StatusOK || st.readChat != "40711@s.whatsapp.net" {
		t.Errorf("status = %d, read %q", rec.Code, st.readChat)
	}
	if rec := do(t, h, http.MethodPost, "/chats/nope/read", auth); rec.Code != http.StatusNotFound {
		t.Errorf("unknown chat: status = %d, want 404", rec.Code)
	}
}

func TestEmojiOnlyTextGetsALabel(t *testing.T) {
	st := &fakeStore{
		chats: []store.Chat{{ID: "a@s.whatsapp.net", Name: "Ana", LastTime: fixedNow, Preview: "😀😀"}},
		messages: map[string][]store.Message{"a@s.whatsapp.net": {
			{ChatID: "a@s.whatsapp.net", ID: "m1", Sender: "Ana", Time: fixedNow, Text: "👍"},
			{ChatID: "a@s.whatsapp.net", ID: "m2", Sender: "Ana", Time: fixedNow, Text: ""},
		}},
	}
	h := newStoreHandler(config.Config{}, st, nil)
	if first := decode(t, do(t, h, http.MethodGet, "/chats", nil))["chats"].([]any)[0].(map[string]any); first["preview"] != "[emoji]" {
		t.Errorf("preview = %v, want [emoji]", first["preview"])
	}
	messages := decode(t, do(t, h, http.MethodGet, "/chats/a@s.whatsapp.net/messages", nil))["messages"].([]any)
	if got := messages[0].(map[string]any)["text"]; got != "[emoji]" {
		t.Errorf("emoji-only text = %v, want [emoji]", got)
	}
	if got := messages[1].(map[string]any)["text"]; got != "" {
		t.Errorf("empty text = %v, want empty", got)
	}
}

// --- stages 2-3: sending and speech-to-text ---

type fakeSender struct {
	chat, text string
	err        error
}

func (f *fakeSender) Send(_ context.Context, chatID, text string) error {
	f.chat, f.text = chatID, text
	return f.err
}

func doBody(t *testing.T, h http.Handler, method, path, contentType string, body []byte, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func replyHandler(token string, sender Sender, transcribe func(context.Context, []byte) (string, string, error)) http.Handler {
	return New(config.Config{Token: token, CORSOrigins: []string{"*"}}, Options{
		Version: "test", Now: func() time.Time { return fixedNow }, Location: time.UTC,
		Store: sampleStore(), Sender: sender, Transcribe: transcribe,
	})
}

func TestSendDeliversTheExactTextToTheChat(t *testing.T) {
	sender := &fakeSender{}
	rec := doBody(t, replyHandler("", sender, nil), http.MethodPost, "/chats/40711@s.whatsapp.net/send",
		"application/json", []byte(`{"text":"Ajung în zece minute 👍"}`), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	// Unlike what the glasses display, the text that is sent keeps its diacritics.
	if sender.chat != "40711@s.whatsapp.net" || sender.text != "Ajung în zece minute 👍" {
		t.Errorf("sent %q to %q", sender.text, sender.chat)
	}
}

func TestSendRejectsWhatItShouldNotSend(t *testing.T) {
	cases := []struct {
		name, path, body string
		want             int
	}{
		{"empty text", "/chats/40711@s.whatsapp.net/send", `{"text":"   "}`, http.StatusBadRequest},
		{"not JSON", "/chats/40711@s.whatsapp.net/send", `text=hi`, http.StatusBadRequest},
		{"too long", "/chats/40711@s.whatsapp.net/send", `{"text":"` + strings.Repeat("x", 4001) + `"}`, http.StatusBadRequest},
		// Only chats that already exist can be answered: no messages to arbitrary numbers.
		{"unknown chat", "/chats/40799999999@s.whatsapp.net/send", `{"text":"hi"}`, http.StatusNotFound},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			sender := &fakeSender{}
			rec := doBody(t, replyHandler("", sender, nil), http.MethodPost, c.path, "application/json", []byte(c.body), nil)
			if rec.Code != c.want || sender.text != "" {
				t.Errorf("status = %d (want %d), sent %q", rec.Code, c.want, sender.text)
			}
		})
	}
}

func TestSendRequiresToken(t *testing.T) {
	sender := &fakeSender{}
	rec := doBody(t, replyHandler("s3cret", sender, nil), http.MethodPost, "/chats/40711@s.whatsapp.net/send",
		"application/json", []byte(`{"text":"hi"}`), nil)
	if rec.Code != http.StatusUnauthorized || sender.text != "" {
		t.Errorf("status = %d, sent %q", rec.Code, sender.text)
	}
}

func TestSendReportsFailureAndMissingSender(t *testing.T) {
	failing := &fakeSender{err: errors.New("not connected")}
	if rec := doBody(t, replyHandler("", failing, nil), http.MethodPost, "/chats/40711@s.whatsapp.net/send", "application/json", []byte(`{"text":"hi"}`), nil); rec.Code != http.StatusBadGateway {
		t.Errorf("send failure: status = %d, want 502", rec.Code)
	}
	if rec := doBody(t, replyHandler("", nil, nil), http.MethodPost, "/chats/40711@s.whatsapp.net/send", "application/json", []byte(`{"text":"hi"}`), nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("no sender: status = %d, want 503", rec.Code)
	}
}

func TestTranscribeReturnsTextToSendAndTextToDisplay(t *testing.T) {
	var got []byte
	transcribe := func(_ context.Context, pcm []byte) (string, string, error) {
		got = pcm
		return "Ajung în zece minute", "ro", nil
	}
	pcm := bytes.Repeat([]byte{1, 2}, 16000) // one second
	rec := doBody(t, replyHandler("", nil, transcribe), http.MethodPost, "/transcribe", "application/octet-stream", pcm, nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["text"] != "Ajung în zece minute" || body["display"] != "Ajung in zece minute" || body["lang"] != "ro" {
		t.Errorf("body = %v", body)
	}
	if !bytes.Equal(got, pcm) {
		t.Error("the recording did not reach the transcriber unchanged")
	}
}

func TestTranscribeRejectsBadRecordings(t *testing.T) {
	called := false
	transcribe := func(context.Context, []byte) (string, string, error) { called = true; return "x", "ro", nil }
	h := replyHandler("", nil, transcribe)
	if rec := doBody(t, h, http.MethodPost, "/transcribe", "application/octet-stream", nil, nil); rec.Code != http.StatusBadRequest {
		t.Errorf("empty: status = %d, want 400", rec.Code)
	}
	tooLong := make([]byte, 16000*2*121)
	if rec := doBody(t, h, http.MethodPost, "/transcribe", "application/octet-stream", tooLong, nil); rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("too long: status = %d, want 413", rec.Code)
	}
	if called {
		t.Error("transcriber was called for a rejected recording")
	}
}

func TestTranscribeFailureAndMissingTranscriber(t *testing.T) {
	failing := func(context.Context, []byte) (string, string, error) { return "", "", errors.New("gpu busy") }
	pcm := []byte{1, 2, 3, 4}
	if rec := doBody(t, replyHandler("", nil, failing), http.MethodPost, "/transcribe", "application/octet-stream", pcm, nil); rec.Code != http.StatusBadGateway {
		t.Errorf("failure: status = %d, want 502", rec.Code)
	}
	if rec := doBody(t, replyHandler("", nil, nil), http.MethodPost, "/transcribe", "application/octet-stream", pcm, nil); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("no transcriber: status = %d, want 503", rec.Code)
	}
	if rec := doBody(t, replyHandler("s3cret", nil, failing), http.MethodPost, "/transcribe", "application/octet-stream", pcm, nil); rec.Code != http.StatusUnauthorized {
		t.Errorf("no token: status = %d, want 401", rec.Code)
	}
}

func (f *fakeStore) Counts(context.Context) (store.Counts, error) {
	return store.Counts{Unread: 1, Unanswered: 12, All: 437}, nil
}

func TestCountsReportsTheSizeOfEachBox(t *testing.T) {
	h := newStoreHandler(config.Config{Token: "s3cret"}, sampleStore(), nil)
	if rec := do(t, h, http.MethodGet, "/counts", nil); rec.Code != http.StatusUnauthorized {
		t.Fatalf("without token: status = %d, want 401", rec.Code)
	}
	rec := do(t, h, http.MethodGet, "/counts", map[string]string{"Authorization": "Bearer s3cret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}
	body := decode(t, rec)
	if body["unread"] != float64(1) || body["unanswered"] != float64(12) || body["all"] != float64(437) {
		t.Errorf("body = %v", body)
	}
}

func TestChatsReportsWhoWroteTheNewestMessage(t *testing.T) {
	st := &fakeStore{chats: []store.Chat{
		{ID: "a@s.whatsapp.net", Name: "Ana", LastTime: fixedNow, Preview: "pong", LastFromMe: true},
		{ID: "b@s.whatsapp.net", Name: "Dan", LastTime: fixedNow, Preview: "ping"},
	}}
	chats := decode(t, do(t, newStoreHandler(config.Config{}, st, nil), http.MethodGet, "/chats", nil))["chats"].([]any)
	if chats[0].(map[string]any)["last_from_me"] != true || chats[1].(map[string]any)["last_from_me"] != false {
		t.Errorf("last_from_me = %v, %v; want true, false", chats[0].(map[string]any)["last_from_me"], chats[1].(map[string]any)["last_from_me"])
	}
}

func TestChatsOffsetIsPassedToTheStore(t *testing.T) {
	st := sampleStore()
	h := newStoreHandler(config.Config{}, st, nil)
	do(t, h, http.MethodGet, "/chats?limit=20&offset=40", nil)
	if st.gotOffset != 40 || st.gotLimit != 20 {
		t.Errorf("offset=%d limit=%d, want 40 20", st.gotOffset, st.gotLimit)
	}
	do(t, h, http.MethodGet, "/chats", nil)
	if st.gotOffset != 0 {
		t.Errorf("default offset = %d, want 0", st.gotOffset)
	}
	for _, bad := range []string{"-1", "abc"} {
		if rec := do(t, h, http.MethodGet, "/chats?offset="+bad, nil); rec.Code != http.StatusBadRequest {
			t.Errorf("offset=%s: status = %d, want 400", bad, rec.Code)
		}
	}
}
