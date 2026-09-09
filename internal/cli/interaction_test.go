package cli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/storage"
)

func TestEscapeAndArrowDecoding(t *testing.T) {
	now := time.Now()
	var d keyDecoder
	if got := d.feed([]byte{27}, now); len(got) != 0 {
		t.Fatal(got)
	}
	if got := d.feed(nil, now.Add(60*time.Millisecond)); !reflect.DeepEqual(got, []rune{27}) {
		t.Fatal(got)
	}
	for _, seq := range []string{"\x1b[A", "\x1b[B", "\x1b[3~", "\x1bOP"} {
		if got := d.feed([]byte(seq), now); len(got) != 0 {
			t.Fatal("arrow treated as Esc", got)
		}
	}
	b := []byte("你好")
	if got := d.feed(b[:1], now); len(got) != 0 {
		t.Fatal(got)
	}
	if got := d.feed(b[1:], now); string(got) != "你好" {
		t.Fatal(got)
	}
}
func TestCancelRestoresContextAndAllowsNextTurn(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req map[string]any
		json.NewDecoder(r.Body).Decode(&req)
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()
	root := t.TempDir()
	storage.Prepare(root)
	h, _ := newSession(root)
	h.Append(map[string]any{"type": "message", "role": "user", "content": "keep"})
	before, _ := h.Items()
	c := config.Default()
	a := &agent.Agent{History: h, Config: c, API: &ai.Client{URL: srv.URL, Key: "fake", Model: "fake"}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan operationResult, 1)
	go func() { done <- runOperation(ctx, a, "cancel-me") }()
	<-started
	cancel()
	select {
	case result := <-done:
		if !errors.Is(result.err, context.Canceled) {
			t.Fatal(result.err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("cancel stuck")
	}
	after, _ := h.Items()
	if !reflect.DeepEqual(before, after) {
		t.Fatal(after)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "next"})
	after, _ = h.Items()
	if len(after) != 2 {
		t.Fatal(after)
	}
	b, _ := os.ReadFile(h.Messages)
	if len(b) == 0 {
		t.Fatal("erased audit")
	}
}
func TestSelectSessionPreservesBothAndUpdatesState(t *testing.T) {
	root := t.TempDir()
	storage.Prepare(root)
	first, _ := newSession(root)
	second, _ := newSession(root)
	first.Append(map[string]any{"type": "message", "content": "old"})
	before, _ := os.ReadFile(first.Messages)
	a := &agent.Agent{History: second}
	if err := selectSession(a, root, filepath.Base(first.Dir)); err != nil {
		t.Fatal(err)
	}
	state, _ := storage.LoadState(root)
	if state.CurrentSession != filepath.Base(first.Dir) || a.History.Dir != first.Dir {
		t.Fatal(state)
	}
	after, _ := os.ReadFile(first.Messages)
	if string(before) != string(after) {
		t.Fatal("modified selected session")
	}
	if err := selectSession(a, root, "../bad"); err == nil {
		t.Fatal("allowed invalid session")
	}
	if a.History.Dir != first.Dir {
		t.Fatal("failed selection changed session")
	}
}
