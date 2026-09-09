package task

import (
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

func childID(t *testing.T, raw string) string {
	t.Helper()
	var value struct {
		ID string `json:"agent_id"`
	}
	if err := json.Unmarshal([]byte(raw), &value); err != nil || value.ID == "" {
		t.Fatal(raw, err)
	}
	return value.ID
}
func TestSpawnReturnsBeforeChildAndDurableDelivery(t *testing.T) {
	started := make(chan struct{})
	finish := make(chan struct{})
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "child-result") {
			answer(w, "parent-followup")
			return
		}
		close(started)
		select {
		case <-finish:
			answer(w, "child-result")
		case <-r.Context().Done():
		}
	}, 1)
	h, err := history.Open(filepath.Join(s.dir, "parent"))
	if err != nil {
		t.Fatal(err)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "original"})
	release, err := s.ReserveSession("parent")
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	before := time.Now()
	raw, err := s.Spawn(context.Background(), h, "work")
	if err != nil {
		t.Fatal(err)
	}
	if time.Since(before) > time.Second {
		t.Fatal("spawn blocked")
	}
	job := s.Get(childID(t, raw))
	<-started
	select {
	case <-job.Done():
		t.Fatal("child returned before release")
	default:
	}
	if pending, err := s.Pending(h); err != nil || len(pending) != 0 {
		t.Fatal(pending, err)
	}
	close(finish)
	wait(t, job)
	pending, err := s.Pending(h)
	if err != nil || len(pending) != 1 {
		t.Fatal(pending, err)
	}
	a := &agent.Agent{Config: s.config, API: &ai.Client{URL: s.config.URL, Key: "fake", Model: "fake"}, History: h, Tools: tools.New(1, 1000)}
	text, err := s.Deliver(context.Background(), a, pending)
	if err != nil || text != "parent-followup" {
		t.Fatal(text, err)
	}
	if p, err := s.Pending(h); err != nil || len(p) != 0 {
		t.Fatal(p, err)
	}
	// Simulate a crash after the parent receipt and before updating the child.
	pending[0].Handled = false
	job.store.SetAgent(pending[0])
	if p, err := s.Pending(h); err != nil || len(p) != 0 {
		t.Fatal("duplicate delivery", p, err)
	}
	record, err := history.ReadAgent(job.dir)
	if err != nil || !record.Handled {
		t.Fatal(record, err)
	}
	sessions, err := history.List(filepath.Dir(s.dir))
	if err != nil || len(sessions) != 1 {
		t.Fatal(sessions, err)
	}
}

func TestUnselectedSessionProcessesItsOwnResult(t *testing.T) {
	finish := make(chan struct{})
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		raw, _ := json.Marshal(body)
		if strings.Contains(string(raw), "child-result") {
			answer(w, "old-session-followup")
			return
		}
		select {
		case <-finish:
			answer(w, "child-result")
		case <-r.Context().Done():
		}
	}, 1)
	h, err := history.Open(filepath.Join(s.dir, "old"))
	if err != nil {
		t.Fatal(err)
	}
	h.Append(map[string]any{"type": "message", "role": "user", "content": "old prompt"})
	release, _ := s.ReserveSession("old")
	raw, err := s.Spawn(context.Background(), h, "child work")
	if err != nil {
		t.Fatal(err)
	}
	id := childID(t, raw)
	release()
	close(finish)
	deadline := time.After(5 * time.Second)
	for {
		changed := s.Changes()
		if done, _ := h.Delivered(id); done {
			break
		}
		select {
		case <-changed:
		case <-deadline:
			t.Fatal("offscreen result not delivered")
		}
	}
	items, err := h.Items()
	if err != nil {
		t.Fatal(err)
	}
	rawItems, _ := json.Marshal(items)
	if !strings.Contains(string(rawItems), "old-session-followup") {
		t.Fatal(string(rawItems))
	}
}

func TestShutdownPersistsCancelledChild(t *testing.T) {
	started := make(chan struct{})
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		close(started)
		<-r.Context().Done()
	}, 1)
	h, err := history.Open(filepath.Join(s.dir, "parent"))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := s.Spawn(context.Background(), h, "wait")
	if err != nil {
		t.Fatal(err)
	}
	<-started
	s.Close()
	record, err := history.ReadAgent(filepath.Join(h.Dir, "agents", childID(t, raw)))
	if err != nil || record.Status != "cancelled" || record.Handled {
		t.Fatal(record, err)
	}
}
