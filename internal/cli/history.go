package cli

import (
	"fmt"
	"strings"

	"github.com/yanglongyun/agentic/internal/history"
)

func printHistory(h *history.Store) error {
	items, err := h.Items()
	if err != nil {
		return err
	}
	if len(items) == 0 {
		fmt.Println("（对话为空）")
		return nil
	}
	for _, v := range items {
		if v["type"] != "message" {
			continue
		}
		role, _ := v["role"].(string)
		tag := "助理"
		if role == "user" {
			tag = "你"
		}
		if v["_kind"] == "compaction" {
			tag = "摘要"
		}
		fmt.Printf("%s: %s\n", tag, messageText(v))
	}
	return nil
}

func messageText(v map[string]any) string {
	content, _ := v["content"].([]any)
	var parts []string
	for _, item := range content {
		m, _ := item.(map[string]any)
		if text, ok := m["text"].(string); ok {
			parts = append(parts, text)
		}
		if m["type"] == "input_image" {
			parts = append(parts, "[图片]")
		}
	}
	return strings.Join(parts, "\n")
}
