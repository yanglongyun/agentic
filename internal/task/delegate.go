package task

import (
	"context"
	"fmt"

	"github.com/yanglongyun/agentic/internal/events"
)

func (s *Manager) delegator(t *Task) func(context.Context, string) (string, error) {
	return func(ctx context.Context, prompt string) (string, error) {
		child, _, err := s.create(Request{Prompt: prompt}, t)
		if err != nil {
			return "", err
		}
		s.emit(t, events.Event{Type: events.Child, Text: child.ID})
		// Execute on the parent's worker while the parent is suspended: no extra slot.
		s.execute(child, true)
		s.mu.Lock()
		defer s.mu.Unlock()
		if child.Status != "completed" {
			return "", fmt.Errorf("子任务 %s: %s", child.ID, child.Error)
		}
		return child.Result, nil
	}
}
