package config

import (
	"path/filepath"
	"testing"
)

func TestPlatformDirs(t *testing.T) {
	home := filepath.Join("", "Users", "alice")
	empty := func(string) string { return "" }
	cfg, data := platformDirs("darwin", home, empty)
	base := filepath.Join(home, "Library", "Application Support", "agentic")
	if cfg != base || data != filepath.Join(base, "data") {
		t.Fatalf("mac paths: config=%q data=%q", cfg, data)
	}
	cfg, data = platformDirs("linux", home, empty)
	if cfg != filepath.Join(home, ".config", "agentic") || data != filepath.Join(home, ".local", "share", "agentic") {
		t.Fatalf("linux paths: config=%q data=%q", cfg, data)
	}
}

func TestUnifiedPaths(t *testing.T) {
	t.Setenv("AGENT_HOME", t.TempDir())
	t.Setenv("AGENT_CONFIG_DIR", t.TempDir())
	t.Setenv("AGENT_DATA_DIR", t.TempDir())
	p, err := DefaultPaths()
	if err != nil {
		t.Fatal(err)
	}
	if p.ConfigDir != p.DataDir || p.Config != filepath.Join(p.DataDir, "config.json") {
		t.Fatal(p)
	}
}

func TestPromptConfigRoundTrip(t *testing.T) {
	root := t.TempDir()
	p := Paths{ConfigDir: root, DataDir: root, Config: filepath.Join(root, "config.json")}
	t.Setenv("AGENT_SYSTEM", "")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	if c.System == "" || c.CompactSystem == "" || c.URL != "https://api.openai.com/v1/responses" {
		t.Fatal("invalid defaults")
	}
	for key, value := range map[string]string{"system": "custom-main", "compact-system": "custom-summary", "compact-prefix": "prefix:"} {
		if err = Set(&c, key, value); err != nil {
			t.Fatal(err)
		}
	}
	if err = Save(p, c); err != nil {
		t.Fatal(err)
	}
	c, err = Load(p)
	if err != nil || c.System != "custom-main" || c.CompactSystem != "custom-summary" || c.CompactPrefix != "prefix:" {
		t.Fatal(c, err)
	}
}

func TestAPITokenPersistsAndEnvironmentDoesNotOverwriteIt(t *testing.T) {
	root := t.TempDir()
	p := Paths{ConfigDir: root, DataDir: root, Config: filepath.Join(root, "config.json")}
	t.Setenv("AGENT_SERVER_TOKEN", "")
	c, err := Load(p)
	if err != nil {
		t.Fatal(err)
	}
	token := c.API.Token
	if len(token) != 64 || c.API.Listen != "127.0.0.1:9528" {
		t.Fatal("invalid API defaults")
	}
	c, err = Load(p)
	if err != nil || c.API.Token != token {
		t.Fatal("token changed on reload", err)
	}
	t.Setenv("AGENT_SERVER_TOKEN", "environment-token-override")
	c, err = Load(p)
	if err != nil || c.API.Token != "environment-token-override" {
		t.Fatal("override failed", err)
	}
	t.Setenv("AGENT_SERVER_TOKEN", "")
	c, err = Load(p)
	if err != nil || c.API.Token != token {
		t.Fatal("environment overwrote saved token", err)
	}
}
