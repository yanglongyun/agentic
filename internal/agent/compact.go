package agent

import (
	"context"
	"strings"
)

func (a *Agent) Compact(ctx context.Context) error { return a.compactForce(ctx) }
func (a *Agent) compact(ctx context.Context) error {
	if a.History.Tokens() < a.Config.CompactAt {
		return nil
	}
	return a.compactForce(ctx)
}
func (a *Agent) compactForce(ctx context.Context) error {
	items, err := a.History.Items()
	if err != nil {
		return err
	}
	if len(items) <= a.Config.Keep+2 {
		return nil
	}
	start := len(items) - a.Config.Keep
	if start < 0 {
		start = 0
	}
	cut := -1
	for i := start; i < len(items); i++ {
		if isUser(items[i]) {
			cut = i
			break
		}
	}
	if cut < 1 {
		for i := start - 1; i > 0; i-- {
			if isUser(items[i]) {
				cut = i
				break
			}
		}
	}
	if cut < 1 {
		return nil
	}
	var source strings.Builder
	for _, v := range items[:cut] {
		source.WriteString(render(v))
		source.WriteByte('\n')
	}
	prompt := []map[string]any{message("user", "input_text", source.String())}
	resp, e := a.API.Call(ctx, prompt, nil, renderPrompt(a.Config.CompactSystem))
	summary := ""
	if e == nil {
		for _, v := range resp.Output {
			summary += outputText(v)
		}
	}
	if summary == "" {
		summary = short(source.String(), 4000)
	}
	head := message("user", "input_text", renderPrompt(a.Config.CompactPrefix)+summary)
	head["_kind"] = "compaction"
	return a.History.Compact(cut, head)
}
