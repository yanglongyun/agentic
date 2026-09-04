package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func args(v map[string]any) string { b, _ := json.Marshal(v); return string(b) }

func TestWriteEditRead(t *testing.T) {
	s := New(5, 30000)
	p := filepath.Join(t.TempDir(), "nested", "demo.txt")
	if got := s.Run(context.Background(), "write", args(map[string]any{"path": p, "content": "alpha\nbeta\n"})).Text; !strings.Contains(got, "已创建") {
		t.Fatal(got)
	}
	if got := s.Run(context.Background(), "edit", args(map[string]any{"path": p, "old_string": "beta\n", "new_string": "BETA\n"})).Text; !strings.Contains(got, "替换了 1 处") {
		t.Fatal(got)
	}
	b, _ := os.ReadFile(p)
	if string(b) != "alpha\nBETA\n" {
		t.Fatalf("content=%q", b)
	}
	got := s.Run(context.Background(), "read", args(map[string]any{"path": p})).Text
	if !strings.Contains(got, "     1\talpha") || !strings.Contains(got, "     2\tBETA") {
		t.Fatal(got)
	}
}

func TestEditRejectsAmbiguousMatch(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.txt")
	_ = os.WriteFile(p, []byte("x\nx\n"), 0600)
	got := New(5, 30000).Run(context.Background(), "edit", args(map[string]any{"path": p, "old_string": "x", "new_string": "y"})).Text
	if !strings.Contains(got, "匹配到 2 处") {
		t.Fatal(got)
	}
}

func TestDefinitionsUseShell(t *testing.T) {
	d := Definitions()
	if d[0]["name"] != "shell" {
		t.Fatalf("first tool=%v", d[0]["name"])
	}
}
