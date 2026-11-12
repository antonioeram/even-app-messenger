package config

import (
	"reflect"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestLoadUsesDefaultsWhenEnvIsEmpty(t *testing.T) {
	cfg, err := Load(env(nil))
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Addr != ":8080" {
		t.Errorf("Addr = %q, want %q", cfg.Addr, ":8080")
	}
	if !reflect.DeepEqual(cfg.CORSOrigins, []string{"*"}) {
		t.Errorf("CORSOrigins = %v, want [*]", cfg.CORSOrigins)
	}
	if cfg.Token != "" {
		t.Errorf("Token = %q, want empty", cfg.Token)
	}
}

func TestLoadReadsOverridesFromEnv(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"GATEWAY_ADDR":         "127.0.0.1:9000",
		"GATEWAY_TOKEN":        "s3cret",
		"GATEWAY_CORS_ORIGINS": "https://a.example, https://b.example ,",
	}))
	if err != nil {
		t.Fatalf("Load returned error: %v", err)
	}
	if cfg.Addr != "127.0.0.1:9000" {
		t.Errorf("Addr = %q", cfg.Addr)
	}
	if cfg.Token != "s3cret" {
		t.Errorf("Token = %q", cfg.Token)
	}
	want := []string{"https://a.example", "https://b.example"}
	if !reflect.DeepEqual(cfg.CORSOrigins, want) {
		t.Errorf("CORSOrigins = %v, want %v", cfg.CORSOrigins, want)
	}
}

func TestLoadRejectsOriginThatIsNotAnOrigin(t *testing.T) {
	for _, bad := range []string{"example.com", "https://a.example/path", "https://*.example"} {
		if _, err := Load(env(map[string]string{"GATEWAY_CORS_ORIGINS": bad})); err == nil {
			t.Errorf("Load accepted invalid origin %q", bad)
		}
	}
}

func TestLoadDataDirAndWhatsApp(t *testing.T) {
	cases := []struct {
		name         string
		env          map[string]string
		wantDir      string
		wantWhatsApp bool
	}{
		{"no data dir disables storage and whatsapp", map[string]string{}, "", false},
		{"data dir enables whatsapp", map[string]string{"GATEWAY_DATA_DIR": "/data"}, "/data", true},
		{"whatsapp can be switched off", map[string]string{"GATEWAY_DATA_DIR": "/data", "GATEWAY_WHATSAPP": "off"}, "/data", false},
		{"whatsapp needs a data dir", map[string]string{"GATEWAY_WHATSAPP": "on"}, "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cfg, err := Load(func(key string) string { return c.env[key] })
			if err != nil {
				t.Fatal(err)
			}
			if cfg.DataDir != c.wantDir || cfg.WhatsApp != c.wantWhatsApp {
				t.Errorf("DataDir=%q WhatsApp=%v, want %q %v", cfg.DataDir, cfg.WhatsApp, c.wantDir, c.wantWhatsApp)
			}
		})
	}
}

func TestLoadSpeechToText(t *testing.T) {
	cfg, err := Load(env(map[string]string{"GATEWAY_STT_URL": "http://10.0.10.42:8770/stt"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.STTURL != "http://10.0.10.42:8770/stt" || !reflect.DeepEqual(cfg.STTLanguages, []string{"ro", "en"}) {
		t.Errorf("STTURL=%q STTLanguages=%v", cfg.STTURL, cfg.STTLanguages)
	}
	if cfg, _ := Load(env(nil)); cfg.STTURL != "" {
		t.Errorf("default STTURL = %q, want empty", cfg.STTURL)
	}
	if _, err := Load(env(map[string]string{"GATEWAY_STT_URL": "10.0.10.42:8770"})); err == nil {
		t.Error("a URL without scheme was accepted")
	}
}
