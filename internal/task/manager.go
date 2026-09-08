package task

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/events"
)

type Options struct {
	Concurrency, MaxTasks, MaxDepth int
	Timeout                         time.Duration
}
type Request struct {
	Prompt    string `json:"prompt"`
	SessionID string `json:"session_id,omitempty"`
}
type Task struct {
	ID         string     `json:"id"`
	SessionID  string     `json:"session_id"`
	ParentID   string     `json:"parent_id,omitempty"`
	Depth      int        `json:"depth"`
	Status     string     `json:"status"`
	Result     string     `json:"result,omitempty"`
	Error      string     `json:"error,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	FinishedAt *time.Time `json:"finished_at,omitempty"`
	events     []events.Event
	next       int
	changed    chan struct{}
	cancel     context.CancelFunc
	ctx        context.Context
	done       chan struct{}
	prompt     string
}
type Manager struct {
	mu     sync.Mutex
	tasks  map[string]*Task
	busy   map[string]bool
	opts   Options
	config config.Config
	dir    string
	slots  chan struct{}
	ctx    context.Context
	cancel context.CancelFunc
}

var sessionPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

func New(c config.Config, dir string, o Options) (*Manager, error) {
	if o.Concurrency < 1 || o.MaxTasks < 1 || o.MaxDepth < 0 || o.Timeout <= 0 {
		return nil, errors.New("服务限制参数无效")
	}
	ctx, cancel := context.WithCancel(context.Background())
	return &Manager{tasks: map[string]*Task{}, busy: map[string]bool{}, opts: o, config: c, dir: filepath.Join(dir, "sessions"), slots: make(chan struct{}, o.Concurrency), ctx: ctx, cancel: cancel}, nil
}
func (s *Manager) Close() { s.cancel() }
func randomID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}
func terminal(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}
func (s *Manager) eventLocked(t *Task, e events.Event) {
	// Bound replay memory. IDs stay monotonic even when old events are discarded.
	if len(e.Text) > 8192 {
		e.Text = e.Text[:8192] + "…"
	}
	if len(e.Arguments) > 8192 {
		e.Arguments = e.Arguments[:8192] + "…"
	}
	t.next++
	e.ID = t.next
	if len(t.events) == 64 {
		copy(t.events, t.events[1:])
		t.events[63] = e
	} else {
		t.events = append(t.events, e)
	}
	if t.changed != nil {
		close(t.changed)
	}
	t.changed = make(chan struct{})
}
func (s *Manager) emit(t *Task, e events.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.eventLocked(t, e)
}
func (s *Manager) create(req Request, parent *Task) (*Task, Code, error) {
	if strings.TrimSpace(req.Prompt) == "" || len(req.Prompt) > 128*1024 {
		return nil, Invalid, errors.New("prompt 不能为空且不能超过 128 KiB")
	}
	if req.SessionID == "" {
		req.SessionID = randomID()
	}
	if !sessionPattern.MatchString(req.SessionID) {
		return nil, Invalid, errors.New("session_id 只能包含字母、数字、下划线和连字符，最多 64 字符")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx.Err() != nil {
		return nil, Closed, errors.New("服务正在关闭")
	}
	if parent != nil && (parent.Depth >= s.opts.MaxDepth || parent.ctx.Err() != nil) {
		return nil, Invalid, errors.New("子任务层级已达上限或父任务已取消")
	}
	if s.busy[req.SessionID] {
		return nil, Busy, errors.New("该会话已有未结束任务")
	}
	// Keep completed records for up to 24 hours, or evict the oldest at capacity.
	var oldest *Task
	for id, t := range s.tasks {
		if t.FinishedAt != nil {
			if time.Since(*t.FinishedAt) > 24*time.Hour {
				delete(s.tasks, id)
			} else if oldest == nil || t.FinishedAt.Before(*oldest.FinishedAt) {
				oldest = t
			}
		}
	}
	if len(s.tasks) >= s.opts.MaxTasks && oldest != nil {
		delete(s.tasks, oldest.ID)
	}
	if len(s.tasks) >= s.opts.MaxTasks {
		return nil, Capacity, errors.New("任务容量已满")
	}
	base := s.ctx
	depth := 0
	parentID := ""
	if parent != nil {
		base = parent.ctx
		depth = parent.Depth + 1
		parentID = parent.ID
	}
	ctx, cancel := context.WithTimeout(base, s.opts.Timeout)
	t := &Task{ID: randomID(), SessionID: req.SessionID, ParentID: parentID, Depth: depth, Status: "queued", CreatedAt: time.Now().UTC(), ctx: ctx, cancel: cancel, done: make(chan struct{}), prompt: req.Prompt}
	s.tasks[t.ID] = t
	s.busy[t.SessionID] = true
	s.eventLocked(t, events.Event{Type: events.Status, Text: "queued"})
	return t, Accepted, nil
}

type Code string

const (
	Invalid  Code = "invalid"
	Busy     Code = "busy"
	Capacity Code = "capacity"
	Closed   Code = "closed"
	Accepted Code = "accepted"
)

type Error struct {
	Code  Code
	Cause error
}

func (e *Error) Error() string { return e.Cause.Error() }
func (e *Error) Unwrap() error { return e.Cause }
func (s *Manager) Submit(req Request) (*Task, error) {
	t, code, err := s.create(req, nil)
	if err != nil {
		return nil, &Error{code, err}
	}
	go s.execute(t, false)
	return t, nil
}
func (s *Manager) Get(id string) *Task { s.mu.Lock(); defer s.mu.Unlock(); return s.tasks[id] }
func (s *Manager) Snapshot(t *Task) Task {
	s.mu.Lock()
	defer s.mu.Unlock()
	v := *t
	v.events = nil
	return v
}
func (s *Manager) Events(t *Task) ([]events.Event, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]events.Event(nil), t.events...), terminal(t.Status)
}
func (s *Manager) Done() <-chan struct{} { return s.ctx.Done() }
func (t *Task) Done() <-chan struct{}    { return t.done }
func (t *Task) Cancel()                  { t.cancel() }

// Watch takes event data and the wakeup channel under the same lock to avoid lost wakeups.
func (s *Manager) Watch(t *Task, after int) ([]events.Event, bool, <-chan struct{}, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	first := 0
	if len(t.events) > 0 {
		first = t.events[0].ID
	}
	start := len(t.events)
	for i, e := range t.events {
		if e.ID > after {
			start = i
			break
		}
	}
	return append([]events.Event(nil), t.events[start:]...), terminal(t.Status), t.changed, first
}
