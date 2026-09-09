package history

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestListSessionsBoundedPreview(t *testing.T) {
	root := t.TempDir()
	for _, id := range []string{"one", "two"} {
		s, err := Open(filepath.Join(root, "sessions", id))
		if err != nil {
			t.Fatal(err)
		}
		s.Append(map[string]any{"type": "message", "content": []any{map[string]any{"text": "hello\x1b[31m"}}})
	}
	if _, err := Open(filepath.Join(root, "sessions", "empty")); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(root, "sessions", "old")
	os.MkdirAll(old, 0700)
	os.WriteFile(filepath.Join(old, "session.json"), []byte(`{"tokens":3}`), 0600)
	sessions, err := List(root)
	if err != nil || len(sessions) != 2 {
		t.Fatal(sessions, err)
	}
	for _, s := range sessions {
		if strings.ContainsRune(s.Preview, 27) {
			t.Fatal("terminal escape in preview")
		}
	}
}
