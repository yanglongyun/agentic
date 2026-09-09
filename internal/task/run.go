package task

import (
	"fmt"
	"strings"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/events"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

func (s *Manager) execute(t *Task) {
	defer s.workers.Done()
	var result string
	var runErr error
	defer func() { s.finish(t, result, runErr) }()
	if runErr = t.ctx.Err(); runErr != nil {
		return
	}
	h := t.store
	if h == nil {
		h, runErr = history.Open(t.dir)
		if runErr != nil {
			return
		}
	}
	start := func() error {
		s.mu.Lock()
		t.Status = "running"
		s.eventLocked(t, events.Event{Type: events.Status, Text: "running"})
		s.mu.Unlock()
		if t.parentDir != "" {
			return h.SetAgent(history.AgentRecord{Prompt: t.prompt, ID: t.ID, ParentID: t.ParentID, Status: "running", CreatedAt: t.CreatedAt})
		}
		return nil
	}
	a := &agent.Agent{Config: s.config, API: &ai.Client{URL: s.config.URL, Key: s.config.Key, Model: s.config.Model}, History: h, Tools: tools.New(s.config.Timeout, s.config.MaxOutput), Emit: func(e events.Event) { s.emit(t, e) }, Spawn: s.spawner(t)}
	if !t.delivery {
		result, runErr = s.withSlot(t.ctx, func() (string, error) {
			if err := start(); err != nil {
				return "", err
			}
			before, err := h.Checkpoint()
			if err != nil {
				return "", err
			}
			text, err := a.Turn(t.ctx, t.prompt)
			if t.ctx.Err() != nil {
				err = t.ctx.Err()
			}
			if err != nil {
				if restore := h.Restore(before); restore != nil {
					err = fmt.Errorf("%w；恢复历史失败：%v", err, restore)
				}
			}
			return text, err
		})
		if runErr != nil {
			return
		}
	}
	for {
		changed := s.Changes()
		if runErr = t.ctx.Err(); runErr != nil {
			return
		}
		records, err := s.Pending(h)
		if err != nil {
			runErr = err
			return
		}
		if len(records) > 0 {
			var reply string
			reply, runErr = s.withSlot(t.ctx, func() (string, error) {
				if err := start(); err != nil {
					return "", err
				}
				return s.Deliver(t.ctx, a, records)
			})
			if runErr != nil {
				return
			}
			result = strings.TrimSpace(result + "\n\n" + reply)
			continue
		}
		if !s.activeChildren(t.dir) {
			// A child can finish between the first Pending scan and this check.
			last, err := s.Pending(h)
			if err != nil {
				runErr = err
				return
			}
			if len(last) > 0 {
				continue
			}
			return
		}
		s.mu.Lock()
		t.Status = "waiting"
		s.eventLocked(t, events.Event{Type: events.Status, Text: "waiting"})
		s.mu.Unlock()
		// Waiting parents do not consume a worker, including when concurrency is 1.
		select {
		case <-changed:
		case <-t.ctx.Done():
			runErr = t.ctx.Err()
			return
		}
	}
}
