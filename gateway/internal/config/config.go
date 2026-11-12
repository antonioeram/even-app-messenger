// Package config loads the gateway configuration from environment variables.
package config

import (
	"fmt"
	"net/url"
	"strings"
)

// Config holds everything the gateway needs to start.
type Config struct {
	// Addr is the listen address, e.g. ":8080".
	Addr string
	// Token is the bearer token required on API calls. Empty disables the check.
	Token string
	// CORSOrigins lists the origins allowed to call the API from a browser
	// or WebView. A single "*" allows every origin.
	CORSOrigins []string
}

// Load reads the configuration through getenv (os.Getenv in production).
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		Addr:        valueOr(getenv("GATEWAY_ADDR"), ":8080"),
		Token:       getenv("GATEWAY_TOKEN"),
		CORSOrigins: splitList(valueOr(getenv("GATEWAY_CORS_ORIGINS"), "*")),
	}
	for _, origin := range cfg.CORSOrigins {
		if err := validateOrigin(origin); err != nil {
			return Config{}, fmt.Errorf("GATEWAY_CORS_ORIGINS: %w", err)
		}
	}
	return cfg, nil
}

func valueOr(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func splitList(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

// validateOrigin accepts "*" or a bare origin: scheme://host[:port].
func validateOrigin(origin string) error {
	if origin == "*" {
		return nil
	}
	u, err := url.Parse(origin)
	if err != nil {
		return fmt.Errorf("invalid origin %q: %w", origin, err)
	}
	if u.Scheme == "" || u.Host == "" || u.Path != "" || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Host, "*") {
		return fmt.Errorf("invalid origin %q: want scheme://host[:port] without path or wildcard", origin)
	}
	return nil
}
