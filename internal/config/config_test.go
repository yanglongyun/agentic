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
