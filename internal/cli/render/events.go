package render

import (
	"fmt"
	"os"

	"github.com/yanglongyun/agentic/internal/events"
)

func AgentEvent(e events.Event) {
	switch e.Type {
	case events.ToolCall:
		ToolCall(e.Name, e.Arguments, 160)
	case events.ToolResult:
		ToolResult(e.Duration, e.Text)
	case events.Warning:
		fmt.Fprintln(os.Stderr, "警告：", e.Text)
	}
}
