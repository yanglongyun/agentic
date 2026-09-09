package task

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/events"
	"github.com/yanglongyun/agentic/internal/history"
)

func (s *Manager) Changes() <-chan struct{} {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.changed
}
func (s *Manager) notify() {
	s.mu.Lock()
	defer s.mu.Unlock()
	close(s.changed)
	s.changed = make(chan struct{})
}
func (s *Manager) spawner(parent *Task) func(context.Context, string) (string, error) {
	return func(ctx context.Context, prompt string) (string, error) {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		child, code, err := s.create(Request{Prompt: prompt}, parent)
		if err != nil {
			return "", &Error{code, err}
		}
		if s.Get(parent.ID) != nil {
			s.emit(parent, events.Event{Type: events.Child, Text: child.ID})
		}
		go s.execute(child)
		data, _ := json.Marshal(map[string]string{"agent_id": child.ID, "status": "queued"})
		return string(data), nil
	}
}
func (s *Manager) Spawn(ctx context.Context, h *history.Store, prompt string) (string, error) {
	if h == nil {
		return "", errors.New("缺少父会话")
	}
	return s.spawner(&Task{ID: filepath.Base(h.Dir), SessionID: filepath.Base(h.Dir), dir: h.Dir, ctx: s.ctx})(ctx, prompt)
}

// Pending reads durable child results; the parent receipt wins if a crash happened
// after committing the reply but before marking the child handled.
func (s *Manager) Pending(h *history.Store) ([]history.AgentRecord, error) {
	entries, err := os.ReadDir(filepath.Join(h.Dir, "agents"))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	receipts, err := h.AgentReceipts()
	if err != nil {
		return nil, err
	}
	var records []history.AgentRecord
	for _, entry := range entries {
		if !entry.IsDir() || !sessionPattern.MatchString(entry.Name()) {
			continue
		}
		dir := filepath.Join(h.Dir, "agents", entry.Name())
		record, err := history.ReadAgent(dir)
		if err != nil {
			return nil, err
		}
		if record.ID != entry.Name() {
			return nil, errors.New("agent ID 与目录不匹配")
		}
		s.mu.Lock()
		live := s.tasks[record.ID]
		var ended *history.AgentRecord
		if live != nil && terminal(live.Status) {
			ended = &history.AgentRecord{Prompt: live.prompt, ID: live.ID, ParentID: live.ParentID, Status: live.Status, Result: live.Result, Error: live.Error, CreatedAt: live.CreatedAt}
		}
		s.mu.Unlock()
		if !terminal(record.Status) {
			if live != nil && ended == nil {
				continue
			}
			if ended != nil {
				record = ended
			} else {
				record.Status = "cancelled"
				record.Error = "运行进程已退出"
			}
			child, err := history.OpenAgent(dir)
			if err != nil {
				return nil, err
			}
			if err := child.SetAgent(*record); err != nil {
				return nil, err
			}
		}
		if record.Handled {
			continue
		}
		if receipts[record.ID] {
			child, err := history.OpenAgent(dir)
			if err != nil {
				return nil, err
			}
			record.Handled = true
			if err := child.SetAgent(*record); err != nil {
				return nil, err
			}
			continue
		}
		records = append(records, *record)
	}
	sort.Slice(records, func(i, j int) bool { return records[i].CreatedAt.Before(records[j].CreatedAt) })
	if len(records) > 4 {
		records = records[:4]
	}
	return records, nil
}

func (s *Manager) Deliver(ctx context.Context, a *agent.Agent, records []history.AgentRecord) (string, error) {
	if len(records) == 0 {
		return "", nil
	}
	ids := make([]string, len(records))
	for i, r := range records {
		ids[i] = r.ID
	}
	if err := a.History.BeginDelivery(ids); err != nil {
		return "", err
	}
	payload := append([]history.AgentRecord(nil), records...)
	for i := range payload {
		payload[i].Prompt = ""
		if runes := []rune(payload[i].Error); len(runes) > 2000 {
			payload[i].Error = string(runes[:2000]) + "…"
		}
		runes := []rune(payload[i].Result)
		if len(runes) > 12000 {
			payload[i].Result = string(runes[:12000]) + "…（完整结果保存在子 agent 消息中）"
		}
	}
	data, _ := json.Marshal(map[string]any{"source": "agent", "results": payload})
	text, err := a.AgentResults(ctx, string(data))
	if ctx.Err() != nil {
		err = ctx.Err()
	}
	if err == nil {
		err = a.History.CommitDelivery()
	}
	if err != nil {
		if restore := a.History.AbortDelivery(); restore != nil {
			return "", fmt.Errorf("%w；恢复失败：%v", err, restore)
		}
		return "", err
	}
	for _, record := range records {
		child, err := history.OpenAgent(filepath.Join(a.History.Dir, "agents", record.ID))
		if err != nil {
			return text, err
		}
		record.Handled = true
		if err := child.SetAgent(record); err != nil {
			return text, err
		}
	}
	return text, nil
}
func (s *Manager) activeChildren(dir string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, t := range s.tasks {
		if t.parentDir == dir && !terminal(t.Status) {
			return true
		}
	}
	return false
}

// An unselected CLI conversation processes its results without writing to the
// foreground terminal. Selected conversations are driven by the REPL instead.
func (s *Manager) kick(dir string) {
	s.notify()
	if filepath.Dir(dir) != s.dir {
		return
	}
	id := filepath.Base(dir)
	s.mu.Lock()
	available := s.interactive[id] && !s.busy[id] && s.ctx.Err() == nil
	s.mu.Unlock()
	if !available {
		return
	}
	h := &history.Store{Dir: dir, State: filepath.Join(dir, "session.json")}
	records, err := s.Pending(h)
	if err != nil || len(records) == 0 {
		return
	}
	t, _, err := s.create(Request{SessionID: id, delivery: true}, nil)
	if err == nil {
		go s.execute(t)
	}
}

func (s *Manager) withSlot(ctx context.Context, fn func() (string, error)) (string, error) {
	select {
	case s.slots <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-s.slots }()
	return fn()
}
func (s *Manager) finish(t *Task, result string, runErr error) {
	t.cancel()
	status := "completed"
	errorText := ""
	if runErr != nil {
		status = "failed"
		errorText = runErr.Error()
		if errors.Is(runErr, context.Canceled) {
			status = "cancelled"
		}
	}
	// Persist before publishing completion or notifying the parent.
	if t.parentDir != "" {
		record := history.AgentRecord{Prompt: t.prompt, ID: t.ID, ParentID: t.ParentID, Status: status, Result: result, Error: errorText, CreatedAt: t.CreatedAt}
		if err := t.store.SetAgent(record); err != nil {
			status = "failed"
			errorText = fmt.Sprintf("保存 agent 结果失败：%v", err)
		}
	}
	s.mu.Lock()
	t.Status, t.Result, t.Error = status, result, errorText
	now := time.Now().UTC()
	t.FinishedAt = &now
	delete(s.busy, t.SessionID)
	s.eventLocked(t, events.Event{Type: events.Status, Text: status})
	close(t.done)
	s.mu.Unlock()
	if t.parentDir != "" {
		s.kick(t.parentDir)
	} else {
		s.notify()
	}
}
