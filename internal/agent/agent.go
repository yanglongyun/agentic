package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/user"
	"runtime"
	"strings"
	"time"

	"github.com/yanglongyun/agentic/internal/api"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

type Agent struct {
	Config    config.Config
	API       *api.Client
	History   *history.Store
	Tools     *tools.Set
	MaxRounds int
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
		if err := a.compact(ctx); err != nil {
			fmt.Fprintln(os.Stderr, "警告：上下文压缩失败：", err)
		}
		items, err := a.History.Items()
		if err != nil {
			return "", err
		}
		resp, err := a.API.Call(ctx, items, tools.Definitions(), systemPrompt(a.Config.System))
		if err != nil {
			return "", err
		}
		if resp.Usage.TotalTokens > 0 {
			_ = a.History.SetTokens(resp.Usage.TotalTokens)
		}
		hasCall := false
		for _, item := range resp.Output {
			if err := a.History.Append(item); err != nil {
				return "", err
			}
			switch item["type"] {
			case "message":
				final.WriteString(outputText(item))
			case "function_call":
				hasCall = true
				name, _ := item["name"].(string)
				args, _ := item["arguments"].(string)
				callID, _ := item["call_id"].(string)
				if callID == "" {
					callID, _ = item["id"].(string)
				}
				fmt.Fprintf(os.Stderr, "  %s %s\n", name, short(args, 160))
				r := a.Tools.Run(ctx, name, args)
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
	resp, e := a.API.Call(ctx, prompt, nil, "把下面对话压成中文交接摘要。保留目标、要求、完成事项、改过的文件、当前进度、待办和关键命令。不要开场白。")
	summary := ""
	if e == nil {
		for _, v := range resp.Output {
			summary += outputText(v)
		}
	}
	if summary == "" {
		summary = short(source.String(), 4000)
	}
	head := message("user", "input_text", "以下是历史上下文压缩摘要：\n\n"+summary)
	head["_kind"] = "compaction"
	kept := append([]map[string]any{head}, items[cut:]...)
	if err := a.History.Replace(kept); err != nil {
		return err
	}
	return a.History.SetTokens(0)
}

func systemPrompt(custom string) string {
	if custom != "" {
		return custom
	}
	host, _ := os.Hostname()
	u, _ := user.Current()
	who := "unknown"
	if u != nil {
		who = u.Username
	}
	wd, _ := os.Getwd()
	return fmt.Sprintf(`你是运行在用户终端里的 AI agent，可以通过工具操作当前机器。

环境：%s/%s，主机 %s，用户 %s，工作目录 %s，时间 %s。
工具：shell 执行终端命令；read 读取文本或图片；write 写完整文件；edit 精确修改文件。
	改文件前先读取。破坏性操作执行前说明目标。根据工具结果继续工作，不确定时检查，不要猜。回答简洁。`, runtime.GOOS, runtime.GOARCH, host, who, wd, time.Now().Format(time.RFC3339))
}
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
