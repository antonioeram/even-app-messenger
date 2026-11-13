// Package server builds the gateway HTTP API.
package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/antonioeram/even-app-messenger/gateway/internal/config"
)

// Options carries the values that differ between production and tests.
type Options struct {
	Version string
	Now     func() time.Time
	Logger  *slog.Logger
	// Store backs the chat endpoints; nil answers 503.
	Store ChatStore
	// Link reports the WhatsApp session state for the admin page.
	Link func() LinkStatus
	// Pair asks for fresh WhatsApp pairing codes after the first ones expired.
	Pair func()
	// Sender delivers a reply; nil answers 503.
	Sender Sender
	// Transcribe turns a recording (16 kHz, 16 bit, mono PCM) into text and
	// its language; nil answers 503.
	Transcribe func(ctx context.Context, pcm []byte) (text, lang string, err error)
	// Location is the time zone of the clock strings; nil means time.Local.
	Location *time.Location
	// ChangeWait is how long /changes holds a call with nothing to report;
	// zero means 25 seconds, which stays under the usual proxy timeouts.
	ChangeWait time.Duration
}

// New returns the gateway handler: routes wrapped in logging and CORS.
func New(cfg config.Config, opts Options) http.Handler {
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logger == nil {
		opts.Logger = slog.New(slog.DiscardHandler)
	}
	if opts.Location == nil {
		opts.Location = time.Local
	}
	if opts.ChangeWait == 0 {
		opts.ChangeWait = 25 * time.Second
	}
	auth := requireToken(cfg.Token)
	a := &api{
		store: opts.Store, link: opts.Link, pair: opts.Pair, sender: opts.Sender, transcribe: opts.Transcribe,
		now: opts.Now, loc: opts.Location, log: opts.Logger,
		replies: cfg.QuickReplies, changeWait: opts.ChangeWait,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": opts.Version})
	})
	mux.Handle("GET /chats", auth(http.HandlerFunc(a.chats)))
	mux.Handle("GET /counts", auth(http.HandlerFunc(a.counts)))
	mux.Handle("GET /changes", auth(http.HandlerFunc(a.changes)))
	mux.Handle("GET /replies", auth(http.HandlerFunc(a.quickReplies)))
	mux.Handle("GET /chats/{id}/messages", auth(http.HandlerFunc(a.messages)))
	mux.Handle("POST /chats/{id}/read", auth(http.HandlerFunc(a.markRead)))
	mux.Handle("POST /chats/{id}/send", auth(http.HandlerFunc(a.send)))
	mux.Handle("POST /transcribe", auth(http.HandlerFunc(a.transcribeAudio)))
	mux.HandleFunc("GET /admin", a.adminPage)
	mux.Handle("GET /admin/status", auth(http.HandlerFunc(a.adminStatus)))
	mux.Handle("POST /admin/pair", auth(http.HandlerFunc(a.adminPair)))

	return logRequests(opts.Logger, cors(cfg.CORSOrigins, jsonErrors(mux)))
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

// requireToken rejects requests without the configured bearer token.
// An empty token disables the check.
func requireToken(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		if token == "" {
			return next
		}
		want := []byte("Bearer " + token)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := []byte(r.Header.Get("Authorization"))
			if subtle.ConstantTimeCompare(got, want) != 1 {
				w.Header().Set("WWW-Authenticate", "Bearer")
				writeError(w, http.StatusUnauthorized, "missing or invalid token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// cors adds the CORS headers the Even app WebView needs and answers
// preflight requests. The Even Hub whitelist does not replace CORS.
func cors(origins []string, next http.Handler) http.Handler {
	allowAll := slices.Contains(origins, "*")
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		switch {
		case allowAll:
			w.Header().Set("Access-Control-Allow-Origin", "*")
		case origin != "" && slices.Contains(origins, origin):
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Add("Vary", "Origin")
		}
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			w.Header().Set("Access-Control-Max-Age", "86400")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// jsonErrors answers requests that match no route with a JSON body instead
// of the plain-text 404 or 405 that ServeMux writes.
func jsonErrors(mux *http.ServeMux) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, pattern := mux.Handler(r); pattern != "" {
			mux.ServeHTTP(w, r)
			return
		}
		// Let the mux choose between 404 and 405, then reuse its verdict.
		probe := &statusRecorder{ResponseWriter: discardWriter{header: http.Header{}}}
		mux.ServeHTTP(probe, r)
		if allow := probe.Header().Get("Allow"); allow != "" {
			w.Header().Set("Allow", allow)
		}
		writeError(w, probe.status, strings.ToLower(http.StatusText(probe.status)))
	})
}

// discardWriter is a ResponseWriter that keeps headers and drops the body.
type discardWriter struct{ header http.Header }

func (d discardWriter) Header() http.Header         { return d.header }
func (d discardWriter) Write(b []byte) (int, error) { return len(b), nil }
func (d discardWriter) WriteHeader(int)             {}

// statusRecorder remembers the status code for the request log.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// logRequests writes one line per request, with the Origin header: it shows
// which origin the Even app WebView calls from. Query strings and bodies are
// left out.
func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		logger.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"origin", r.Header.Get("Origin"),
			"remote", r.RemoteAddr,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}
