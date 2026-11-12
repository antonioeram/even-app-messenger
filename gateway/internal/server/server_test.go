package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/antonioeram/even-app-messenger/gateway/internal/config"
)

var fixedNow = time.Date(2026, 11, 12, 9, 41, 7, 0, time.UTC)

func newTestHandler(cfg config.Config) http.Handler {
	if cfg.CORSOrigins == nil {
		cfg.CORSOrigins = []string{"*"}
	}
	return New(cfg, Options{
		Version:  "test",
		Hostname: "homelab",
		Now:      func() time.Time { return fixedNow },
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

func TestHelloReturnsTextWithHostAndServerTime(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/hello", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	body := decode(t, rec)
	text, _ := body["text"].(string)
	for _, want := range []string{"Hello from the gateway", "homelab", "09:41:07"} {
		if !strings.Contains(text, want) {
			t.Errorf("text %q does not contain %q", text, want)
		}
	}
	// The glasses font is not guaranteed to have non-ASCII glyphs.
	for _, r := range text {
		if r > 127 {
			t.Errorf("text %q contains non-ASCII character %q", text, r)
		}
	}
	if body["time"] != "2026-11-12T09:41:07Z" {
		t.Errorf("time field = %v", body["time"])
	}
}

func TestResponsesAreNotCacheable(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/hello", nil)
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
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/hello",
		map[string]string{"Origin": "https://webview.example"})
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

func TestListedCORSOriginIsEchoedAndOthersAreNot(t *testing.T) {
	h := newTestHandler(config.Config{CORSOrigins: []string{"https://app.example"}})

	allowed := do(t, h, http.MethodGet, "/hello", map[string]string{"Origin": "https://app.example"})
	if got := allowed.Header().Get("Access-Control-Allow-Origin"); got != "https://app.example" {
		t.Errorf("allowed origin: Access-Control-Allow-Origin = %q", got)
	}
	if got := allowed.Header().Get("Vary"); !strings.Contains(got, "Origin") {
		t.Errorf("allowed origin: Vary = %q, want it to include Origin", got)
	}

	denied := do(t, h, http.MethodGet, "/hello", map[string]string{"Origin": "https://evil.example"})
	if got := denied.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Errorf("denied origin: Access-Control-Allow-Origin = %q, want empty", got)
	}
}

func TestPreflightIsAnsweredWithoutAuth(t *testing.T) {
	h := newTestHandler(config.Config{Token: "s3cret"})
	rec := do(t, h, http.MethodOptions, "/hello", map[string]string{
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
	h := newTestHandler(config.Config{Token: "s3cret"})

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
			rec := do(t, h, http.MethodGet, "/hello", headers)
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

func TestHelloIsOpenWhenNoTokenIsConfigured(t *testing.T) {
	rec := do(t, newTestHandler(config.Config{}), http.MethodGet, "/hello", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
}
