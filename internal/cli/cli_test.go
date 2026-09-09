package cli

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yanglongyun/agentic/internal/storage"
)

func TestNewSessionsKeepPriorMessages(t *testing.T) {
	root := t.TempDir()
	if err := storage.Prepare(root); err != nil {
		t.Fatal(err)
	}
	first, err := newSession(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = first.Append(map[string]any{"type": "message", "role": "user", "content": "keep me"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(first.Messages)
	second, err := newSession(root)
	if err != nil {
		t.Fatal(err)
	}
	if first.Dir == second.Dir {
		t.Fatal("reused session")
	}
	items, err := second.Items()
	if err != nil || len(items) != 0 {
		t.Fatal(items, err)
	}
	after, _ := os.ReadFile(first.Messages)
	if string(before) != string(after) {
		t.Fatal("modified old session")
	}
	state, err := storage.LoadState(root)
	if err != nil || state.CurrentSession != filepath.Base(second.Dir) {
		t.Fatal(state, err)
	}
}
func TestRemovedCommandsDoNotCreateSession(t *testing.T) {
	root := t.TempDir()
	t.Setenv("AGENT_HOME", root)
	for _, args := range [][]string{{"compact"}, {"serve"}, {"reset"}, {"-p", "hello"}, {"hello"}} {
		if err := Run(args, "test"); err == nil {
			t.Fatal("accepted", args)
		}
	}
	dirs, err := os.ReadDir(filepath.Join(root, "sessions"))
	if err != nil || len(dirs) != 0 {
		t.Fatal(dirs, err)
	}
}
