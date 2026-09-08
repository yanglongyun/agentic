package storage

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPrepareFreshAndRepeated(t *testing.T) {
	root := t.TempDir()
	if err := Prepare(root); err != nil {
		t.Fatal(err)
	}
	state, err := LoadState(root)
	if err != nil || state.CurrentSession != "cli" {
		t.Fatal(state, err)
	}
	state.CurrentSession = "another"
	WriteJSON(filepath.Join(root, "state.json"), state)
	if err = Prepare(root); err != nil {
		t.Fatal(err)
	}
	state, _ = LoadState(root)
	if state.CurrentSession != "another" {
		t.Fatal("reset global state")
	}
}
func TestPrepareDoesNotMigrate(t *testing.T) {
	for _, name := range []string{"history.jsonl", "archive.jsonl", "state.json"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			p := filepath.Join(root, name)
			os.WriteFile(p, []byte(`{"tokens":3}`), 0600)
			if err := Prepare(root); err == nil {
				t.Fatal("accepted legacy root")
			}
			b, _ := os.ReadFile(p)
			entries, _ := os.ReadDir(root)
			if string(b) != `{"tokens":3}` || len(entries) != 1 {
				t.Fatal("changed legacy data")
			}
		})
	}
}
func TestInvalidSession(t *testing.T) {
	if _, err := SessionDir(t.TempDir(), "../bad"); err == nil {
		t.Fatal("accepted traversal")
	}
}
