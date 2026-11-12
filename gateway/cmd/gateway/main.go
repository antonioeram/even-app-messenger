// Command gateway is the home-server side of the Even G2 messenger.
//
// Without GATEWAY_DATA_DIR it serves /health and /hello only. With it, it
// keeps a WhatsApp session, stores chats and messages in SQLite and serves
// them at /chats, plus the pairing page at /admin. Stage 1 is read-only.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
	_ "time/tzdata" // the container image has no zoneinfo; TZ must still work

	"github.com/antonioeram/even-app-messenger/gateway/internal/config"
	"github.com/antonioeram/even-app-messenger/gateway/internal/server"
	"github.com/antonioeram/even-app-messenger/gateway/internal/store"
	"github.com/antonioeram/even-app-messenger/gateway/internal/whatsapp"
)

// version is set at build time with -ldflags "-X main.version=...".
var version = "dev"

func main() {
	healthcheck := flag.Bool("healthcheck", false, "query /health on the running gateway and exit 0 or 1")
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stdout, nil))

	cfg, err := config.Load(os.Getenv)
	if err != nil {
		logger.Error("invalid configuration", "error", err)
		os.Exit(2)
	}

	if *healthcheck {
		os.Exit(runHealthcheck(cfg.Addr))
	}

	if err := run(cfg, logger); err != nil {
		logger.Error("gateway stopped", "error", err)
		os.Exit(1)
	}
}

func run(cfg config.Config, logger *slog.Logger) error {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	opts := server.Options{Version: version, Hostname: hostname, Logger: logger}
	if cfg.DataDir != "" {
		messages, err := store.Open(ctx, filepath.Join(cfg.DataDir, "messages.db"))
		if err != nil {
			return err
		}
		defer messages.Close()
		opts.Store = messages

		if cfg.WhatsApp {
			wa, err := whatsapp.Open(ctx, filepath.Join(cfg.DataDir, "whatsapp.db"), messages, logger)
			if err != nil {
				return err
			}
			defer wa.Close()
			wa.Start(ctx)
			opts.Pair = wa.Pair
			opts.Link = func() server.LinkStatus {
				st := wa.Status()
				return server.LinkStatus{State: st.State, QR: st.QR, Account: st.Account}
			}
		}
	}

	srv := &http.Server{
		Addr:              cfg.Addr,
		Handler:           server.New(cfg, opts),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       30 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		logger.Info("gateway listening",
			"addr", cfg.Addr,
			"version", version,
			"token_required", cfg.Token != "",
			"cors_origins", cfg.CORSOrigins,
			"data_dir", cfg.DataDir,
			"whatsapp", cfg.WhatsApp,
		)
		errc <- srv.ListenAndServe()
	}()

	select {
	case err := <-errc:
		return err
	case <-ctx.Done():
	}

	logger.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// runHealthcheck backs the container HEALTHCHECK: the image has no shell or curl.
func runHealthcheck(addr string) int {
	url, err := healthURL(addr)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := checkHealth(ctx, url); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// healthURL turns a listen address into the loopback URL of /health.
func healthURL(addr string) (string, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", fmt.Errorf("invalid listen address %q: %w", addr, err)
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/health", nil
}

// checkHealth returns nil when url answers 200.
func checkHealth(ctx context.Context, url string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("health check: %s returned %d", url, resp.StatusCode)
	}
	return nil
}
