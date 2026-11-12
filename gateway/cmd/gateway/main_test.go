package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestHealthURLPointsAtLoopbackForWildcardAddr(t *testing.T) {
	cases := map[string]string{
		":8080":          "http://127.0.0.1:8080/health",
		"0.0.0.0:9000":   "http://127.0.0.1:9000/health",
		"127.0.0.1:8081": "http://127.0.0.1:8081/health",
		"[::]:8082":      "http://127.0.0.1:8082/health",
	}
	for addr, want := range cases {
		got, err := healthURL(addr)
		if err != nil {
			t.Errorf("healthURL(%q) error: %v", addr, err)
			continue
		}
		if got != want {
			t.Errorf("healthURL(%q) = %q, want %q", addr, got, want)
		}
	}
}

func TestCheckHealthSucceedsOn200(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()
	if err := checkHealth(context.Background(), srv.URL); err != nil {
		t.Errorf("checkHealth returned error for 200: %v", err)
	}
}

func TestCheckHealthFailsOnServerError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	if err := checkHealth(context.Background(), srv.URL); err == nil {
		t.Errorf("checkHealth returned nil for 500")
	}
}

func TestCheckHealthFailsWhenNothingListens(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	if err := checkHealth(context.Background(), url); err == nil {
		t.Errorf("checkHealth returned nil for a closed server")
	}
}
