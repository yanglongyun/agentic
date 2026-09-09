package task

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/events"
	"github.com/yanglongyun/agentic/internal/history"
)

const testToken = "test-token-for-server"

func setup(t *testing.T, handler http.HandlerFunc, depth int) *Manager {
	t.Helper()
	up := httptest.NewServer(handler)
	t.Cleanup(up.Close)
	c := config.Default()
	c.URL = up.URL
	c.Key = "fake"
	s, err := New(c, t.TempDir(), Options{Concurrency: 1, MaxTasks: 10, MaxDepth: depth, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}
func answer(w http.ResponseWriter, text string) {
	_ = json.NewEncoder(w).Encode(map[string]any{"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}}}})
}
func wait(t *testing.T, task *Task) {
	t.Helper()
	select {
	case <-task.done:
	case <-time.After(5 * time.Second):
		t.Fatal("task stuck")
	}
}
func TestAsyncAgentOneWorker(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Input []map[string]any `json:"input"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body.Input)
		switch {
		case strings.Contains(string(raw), "child done"):
			answer(w, "parent integrated")
		case strings.Contains(string(raw), "function_call_output"):
			answer(w, "parent continues")
		case strings.Contains(string(raw), "child prompt"):
			answer(w, "child done")
		default:
			json.NewEncoder(w).Encode(map[string]any{"output": []any{map[string]any{"type": "function_call", "name": "agent", "call_id": "c1", "arguments": `{"prompt":"child prompt"}`}}})
		}
	}, 1)
	root, err := s.Submit(Request{Prompt: "parent", SessionID: "root"})
	if err != nil {
		t.Fatal(err)
	}
	wait(t, root)
	snapshot := s.Snapshot(root)
	if snapshot.Status != "completed" || snapshot.Result != "parent continues\n\nparent integrated" {
		t.Fatal(snapshot.Status, snapshot.Result, snapshot.Error)
	}
	sessions, err := history.List(filepath.Dir(s.dir))
	if err != nil || len(sessions) != 1 {
		t.Fatal(sessions, err)
	}
	for _, child := range s.tasks {
		if child.ParentID != root.ID {
			continue
		}
		if child.dir != filepath.Join(root.dir, "agents", child.ID) {
			t.Fatal(child.dir)
		}
		record, err := history.ReadAgent(child.dir)
		if err != nil || !record.Handled || record.Result != "child done" {
			t.Fatal(record, err)
		}
		files, err := os.ReadDir(child.dir)
		if err != nil || len(files) != 3 {
			t.Fatal(files, err)
		}
	}
}
func TestLimitsCancelAndRollback(t *testing.T) {
	started := make(chan struct{}, 1)
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		started <- struct{}{}
		<-r.Context().Done()
	}, 0)
	root, _, _ := s.create(Request{Prompt: "hang", SessionID: "one"}, nil)
	if _, code, _ := s.create(Request{Prompt: "busy", SessionID: "one"}, nil); code != Busy {
		t.Fatal(code)
	}
	if _, _, err := s.create(Request{Prompt: "child"}, root); err == nil {
		t.Fatal("depth limit bypass")
	}
	go s.execute(root)
	<-started
	queued, _, _ := s.create(Request{Prompt: "queued"}, nil)
	go s.execute(queued)
	queued.cancel()
	wait(t, queued)
	root.cancel()
	wait(t, root)
	s.mu.Lock()
	if root.Status != "cancelled" || queued.Status != "cancelled" {
		t.Fatal(root.Status, queued.Status)
	}
	s.mu.Unlock()
	h, _ := history.Open(filepath.Join(s.dir, "one"))
	items, err := h.Items()
	if err != nil || len(items) != 0 {
		t.Fatal(items, err)
	}
	s.mu.Lock()
	s.tasks = map[string]*Task{}
	s.mu.Unlock()
	s.opts.MaxTasks = 1
	a, _, err := s.create(Request{Prompt: "a"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, code, _ := s.create(Request{Prompt: "b"}, nil); code != Capacity {
		t.Fatal(code)
	}
	a.cancel()
	s.execute(a)
}
func TestTimeout(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); <-r.Context().Done() }, 1)
	s.opts.Timeout = 20 * time.Millisecond
	task, _, _ := s.create(Request{Prompt: "timeout"}, nil)
	go s.execute(task)
	wait(t, task)
	if task.Status != "failed" || !strings.Contains(task.Error, context.DeadlineExceeded.Error()) {
		t.Fatal(task.Status, task.Error)
	}
}

func TestAsyncAgentDepthAndCascade(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body any
		_ = json.NewDecoder(r.Body).Decode(&body)
		b, _ := json.Marshal(body)
		if strings.Contains(string(b), "function_call_output") {
			answer(w, "done")
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"output": []any{map[string]any{"type": "function_call", "name": "agent", "call_id": "nested", "arguments": `{"prompt":"agent again"}`}}})
	}, 1)
	root, _, _ := s.create(Request{Prompt: "agent"}, nil)
	go s.execute(root)
	wait(t, root)
	s.mu.Lock()
	count := len(s.tasks)
	s.mu.Unlock()
	if count != 2 {
		t.Fatalf("depth limit allowed %d tasks", count)
	}
	parent, _, _ := s.create(Request{Prompt: "parent"}, nil)
	child, _, err := s.create(Request{Prompt: "child"}, parent)
	if err != nil {
		t.Fatal(err)
	}
	parent.cancel()
	if child.ctx.Err() != context.Canceled {
		t.Fatal("cancellation did not propagate")
	}
	s.execute(child)
	s.execute(parent)
}

func TestSessionIsolation(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) { answer(w, "hello") }, 1)
	for _, id := range []string{"one", "two"} {
		running, err := s.Submit(Request{Prompt: id, SessionID: id})
		if err != nil {
			t.Fatal(err)
		}
		wait(t, running)
		h, err := history.Open(filepath.Join(s.dir, id))
		if err != nil {
			t.Fatal(err)
		}
		items, err := h.Items()
		if err != nil || len(items) != 2 {
			t.Fatal(id, len(items), err)
		}
		b, _ := json.Marshal(items[0])
		if !strings.Contains(string(b), id) {
			t.Fatal("mixed sessions", string(b))
		}
	}
}

func TestWatchNotificationAndBoundedReplay(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) { answer(w, "hello") }, 1)
	job, _, _ := s.create(Request{Prompt: "watch"}, nil)
	initial, _, changed, _ := s.Watch(job, 0)
	if len(initial) != 1 {
		t.Fatal(initial)
	}
	for i := 0; i < 70; i++ {
		s.emit(job, events.Event{Type: events.Message, Text: "delta"})
	}
	select {
	case <-changed:
	default:
		t.Fatal("subscriber not notified")
	}
	got, done, next, first := s.Watch(job, 1)
	if len(got) != 64 || done || first != 8 {
		t.Fatal(len(got), done, first)
	}
	empty, _, _, _ := s.Watch(job, got[len(got)-1].ID)
	if len(empty) != 0 {
		t.Fatal("replayed old events")
	}
	select {
	case <-next:
		t.Fatal("idle channel already closed")
	default:
	}
	job.cancel()
	s.execute(job)
	select {
	case <-next:
	default:
		t.Fatal("completion not notified")
	}
}
