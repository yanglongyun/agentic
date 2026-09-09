package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/events"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

type Agent struct {
	Config    config.Config
	API       *ai.Client
	History   *history.Store
	Tools     *tools.Set
	MaxRounds int
	Emit      events.Sink
	Delegate  func(context.Context, string) (string, error)
}

func (a *Agent) Turn(ctx context.Context, text string) (string, error) {
	if err := a.History.Append(message("user", "input_text", text)); err != nil {
		return "", err
	}
	max := a.MaxRounds
	if max == 0 {
		max = 50
	}
	var final strings.Builder
	for round := 0; round < max; round++ {
		if err := ctx.Err(); err != nil {
			return final.String(), err
		}
		if err := a.compact(ctx); err != nil {
			a.emit(events.Event{Type: events.Warning, Text: "上下文压缩失败：" + err.Error()})
		}
		items, err := a.History.Items()
		if err != nil {
			return "", err
		}
		defs := tools.Definitions()
		if a.Delegate != nil {
			defs = append(defs, map[string]any{"type": "function", "name": "delegate", "description": "创建独立子任务并等待结果。子任务不会继承对话；请给出完整上下文。", "parameters": map[string]any{"type": "object", "properties": map[string]any{"prompt": map[string]any{"type": "string"}}, "required": []string{"prompt"}}})
		}
		resp, err := a.API.Call(ctx, items, defs, renderPrompt(a.Config.System))
		if err != nil {
			return "", err
		}
		if resp.Usage.TotalTokens > 0 {
			_ = a.History.SetTokens(resp.Usage.TotalTokens)
		}
		hasCall := false
		for _, item := range resp.Output {
			if err := ctx.Err(); err != nil {
				return final.String(), err
			}
			if err := a.History.Append(item); err != nil {
				return "", err
			}
			switch item["type"] {
			case "message":
				final.WriteString(outputText(item))
				a.emit(events.Event{Type: events.Message, Text: outputText(item)})
			case "function_call":
				hasCall = true
				name, _ := item["name"].(string)
				args, _ := item["arguments"].(string)
				callID, _ := item["call_id"].(string)
				if callID == "" {
					callID, _ = item["id"].(string)
				}
				a.emit(events.Event{Type: events.ToolCall, Text: name + ": " + args, Name: name, Arguments: args, CallID: callID})
				started := time.Now()
				var r tools.Result
				if name == "delegate" && a.Delegate != nil {
					var input struct {
						Prompt string `json:"prompt"`
					}
					e := json.Unmarshal([]byte(args), &input)
					if e == nil {
						r.Text, e = a.Delegate(ctx, input.Prompt)
					}
					if e != nil {
						r.Text = "错误：" + e.Error()
					}
				} else {
					r = a.Tools.Run(ctx, name, args)
				}
				a.emit(events.Event{Type: events.ToolResult, Text: r.Text, Name: name, CallID: callID, Duration: time.Since(started)})
				if err := a.History.Append(map[string]any{"type": "function_call_output", "call_id": callID, "output": r.Text}); err != nil {
					return "", err
				}
				if r.ImageDataURL != "" {
					if err := a.History.Append(map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "图片内容（" + r.ImageName + "）："}, map[string]any{"type": "input_image", "image_url": r.ImageDataURL, "detail": "auto"}}}); err != nil {
						return "", err
					}
				}
			}
		}
		if !hasCall {
			return final.String(), nil
		}
	}
	return final.String(), fmt.Errorf("达到最大工具轮数 %d", max)
}

func (a *Agent) emit(e events.Event) {
	if a.Emit != nil {
		a.Emit(e)
	}
}
