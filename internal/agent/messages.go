package agent

import (
	"encoding/json"
	"strings"
)

func message(role, kind, text string) map[string]any {
	return map[string]any{"type": "message", "role": role, "content": []any{map[string]any{"type": kind, "text": text}}}
}
func isUser(v map[string]any) bool { return v["type"] == "message" && v["role"] == "user" }
func outputText(v map[string]any) string {
	content, ok := v["content"].([]any)
	if !ok {
		return ""
	}
	var b strings.Builder
	for _, x := range content {
		m, ok := x.(map[string]any)
		if ok && m["type"] == "output_text" {
			if s, ok := m["text"].(string); ok {
				b.WriteString(s)
			}
		}
	}
	return b.String()
}
func render(v map[string]any) string { b, _ := json.Marshal(v); return string(b) }
func short(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
