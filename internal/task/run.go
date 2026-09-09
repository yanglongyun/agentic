package task

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/events"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

func (s *Manager) execute(t *Task, inline bool) {
	defer s.workers.Done()
	var result string
	var runErr error
	defer func() {
		t.cancel()
		s.mu.Lock()
		defer s.mu.Unlock()
		t.Result = result
		if runErr != nil {
			t.Error = runErr.Error()
			t.Status = "failed"
			if errors.Is(runErr, context.Canceled) {
				t.Status = "cancelled"
			}
		} else {
			t.Status = "completed"
		}
		now := time.Now().UTC()
		t.FinishedAt = &now
		delete(s.busy, t.SessionID)
		s.eventLocked(t, events.Event{Type: events.Status, Text: t.Status})
		close(t.done)
	}()
	if !inline {
		select {
		case s.slots <- struct{}{}:
			defer func() { <-s.slots }()
		case <-t.ctx.Done():
			runErr = t.ctx.Err()
			return
		}
	}
	if runErr = t.ctx.Err(); runErr != nil {
		return
	}
	s.mu.Lock()
	t.Status = "running"
	s.eventLocked(t, events.Event{Type: events.Status, Text: "running"})
	s.mu.Unlock()
	h, err := history.Open(filepath.Join(s.dir, t.SessionID))
	if err != nil {
		runErr = err
		return
	}
	before, err := h.Checkpoint()
	if err != nil {
		runErr = err
		return
	}
	a := &agent.Agent{Config: s.config, API: &ai.Client{URL: s.config.URL, Key: s.config.Key, Model: s.config.Model}, History: h, Tools: tools.New(s.config.Timeout, s.config.MaxOutput), Emit: func(e events.Event) { s.emit(t, e) }}
	a.Delegate = s.delegator(t)
	result, runErr = a.Turn(t.ctx, t.prompt)
	if t.ctx.Err() != nil {
		runErr = t.ctx.Err()
	}
	if runErr != nil { // Avoid leaving unmatched tool calls in a reusable session.
		if err := h.Restore(before); err != nil {
			runErr = fmt.Errorf("%w; 恢复历史失败: %v", runErr, err)
		}
	}
}
