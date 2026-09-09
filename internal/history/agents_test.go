package history

import (
	"path/filepath"
	"testing"
)

func TestInterruptedDeliveryRestoresContextOnOpen(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "original"})
	if err := h.BeginDelivery([]string{"child"}); err != nil {
		t.Fatal(err)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "agent result"})
	h.Append(map[string]any{"type": "message", "role": "assistant", "content": "uncommitted reply"})
	h, err = Open(h.Dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := h.Items()
	if err != nil || len(items) != 1 {
		t.Fatal(items, err)
	}
	if done, _ := h.Delivered("child"); done {
		t.Fatal("interrupted delivery acknowledged")
	}
	if err := h.BeginDelivery([]string{"child"}); err != nil {
		t.Fatal(err)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "agent result"})
	h.Append(map[string]any{"type": "message", "role": "assistant", "content": "committed reply"})
	if err := h.CommitDelivery(); err != nil {
		t.Fatal(err)
	}
	h, err = Open(h.Dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err = h.Items()
	if err != nil || len(items) != 3 {
		t.Fatal(items, err)
	}
	if done, _ := h.Delivered("child"); !done {
		t.Fatal("missing receipt")
	}
	child, err := OpenAgent(filepath.Join(h.Dir, "agents", "child"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(child.State) != "state.json" {
		t.Fatal(child.State)
	}
}
