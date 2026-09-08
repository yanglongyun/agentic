package events

import (
	"time"
)

const (
	Message    = "message"
	ToolCall   = "tool_call"
	ToolResult = "tool_result"
	Warning    = "warning"
	Status     = "status"
	Child      = "child"
)

type Event struct {
	ID        int           `json:"id,omitempty"`
	Type      string        `json:"type"`
	Text      string        `json:"text"`
	Name      string        `json:"name,omitempty"`
	Arguments string        `json:"arguments,omitempty"`
	CallID    string        `json:"call_id,omitempty"`
	Duration  time.Duration `json:"duration_ns,omitempty"`
}
type Sink func(Event)
