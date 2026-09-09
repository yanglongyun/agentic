package history

import (
	"errors"
	"path/filepath"
	"time"

	"github.com/yanglongyun/agentic/internal/storage"
)

type AgentRecord struct {
	Prompt    string    `json:"prompt,omitempty"`
	ID        string    `json:"id"`
	ParentID  string    `json:"parent_id"`
	Status    string    `json:"status"`
	Result    string    `json:"result,omitempty"`
	Error     string    `json:"error,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	Handled   bool      `json:"handled"`
}

type DeliveryCheckpoint struct {
	IDs    []string `json:"ids"`
	Before State    `json:"before"`
	Count  int64    `json:"count"`
}

func ReadAgent(dir string) (*AgentRecord, error) {
	h := &Store{State: filepath.Join(dir, "state.json")}
	state, err := h.load()
	if err != nil {
		return nil, err
	}
	if state.Agent == nil {
		return nil, errors.New("缺少 agent 状态")
	}
	return state.Agent, nil
}
func (s *Store) SetAgent(record AgentRecord) error {
	state, err := s.load()
	if err != nil {
		return err
	}
	state.Agent = &record
	return storage.WriteJSON(s.State, state)
}
func (s *Store) Delivered(id string) (bool, error) {
	state, err := s.load()
	return state.Delivered[id], err
}
func (s *Store) BeginDelivery(ids []string) error {
	before, err := s.Checkpoint()
	if err != nil {
		return err
	}
	if before.state.Delivery != nil {
		return errors.New("已有 agent 结果正在处理")
	}
	state := before.state
	state.Delivery = &DeliveryCheckpoint{IDs: ids, Before: before.state, Count: before.count}
	return storage.WriteJSON(s.State, state)
}
func (s *Store) CommitDelivery() error {
	state, err := s.load()
	if err != nil {
		return err
	}
	if state.Delivery == nil {
		return errors.New("缺少 agent 结果处理记录")
	}
	if state.Delivered == nil {
		state.Delivered = map[string]bool{}
	}
	for _, id := range state.Delivery.IDs {
		state.Delivered[id] = true
	}
	state.Delivery = nil
	return storage.WriteJSON(s.State, state)
}
func (s *Store) AbortDelivery() error {
	state, err := s.load()
	if err != nil {
		return err
	}
	if state.Delivery == nil {
		return nil
	}
	return s.Restore(Checkpoint{state: state.Delivery.Before, count: state.Delivery.Count})
}

func (s *Store) AgentReceipts() (map[string]bool, error) {
	state, err := s.load()
	return state.Delivered, err
}
