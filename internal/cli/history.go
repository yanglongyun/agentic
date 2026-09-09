package cli

import (
	"fmt"

	"github.com/yanglongyun/agentic/internal/cli/render"
	"github.com/yanglongyun/agentic/internal/history"
)

func printHistory(h *history.Store, limit int) error {
	messages, err := h.Recent(limit)
	if err != nil {
		return err
	}
	if len(messages) == 0 {
		fmt.Println("（暂无可显示消息）")
		return nil
	}
	for _, message := range messages {
		if message.Role == "user" {
			fmt.Print(render.UserMessage(message.Text))
		} else {
			fmt.Print(render.Markdown(message.Text) + "\n")
		}
	}
	return nil
}
