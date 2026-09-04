package ui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Banner 渲染进入 REPL 时的欢迎块。
func Banner(version, model string) string {
	host, _ := os.Hostname()
	cwd, _ := os.Getwd()
	if home, e := os.UserHomeDir(); e == nil {
		if r, ex := filepath.Rel(home, cwd); ex == nil && !strings.HasPrefix(r, "..") {
			cwd = "~" + string(filepath.Separator) + r
		}
	}
	cwd = filepath.ToSlash(cwd)
	var b strings.Builder
	line := Dim("  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500")
	b.WriteString(line + "\n")
	b.WriteString("  " + Bold(Cyan("agent")) + "  " + Bold(version) + "  " + Dim("\u00b7") + "  " + Green(model) + "\n")
	b.WriteString("  " + Dim("目录 ") + cwd + "  " + Dim("\u00b7 主机 ") + host + "\n")
	b.WriteString("  " + Dim("/help 命令 \u00b7 /status 状态 \u00b7 /exit 退出") + "\n")
	b.WriteString(line + "\n\n")
	return b.String()
}

// Help 渲染分组后的命令说明。
func Help() string {
	cmd := func(name, desc string) string {
		return "  " + Bold(Yellow(name)) + "  " + desc
	}
	group := func(title string) string { return "\n  " + Bold(Magenta(title)) + "\n" }
	var b strings.Builder
	b.WriteString(group("会话"))
	b.WriteString(cmd("/exit, /quit", "退出") + "\n")
	b.WriteString(cmd("/history", "查看当前对话") + "\n")
	b.WriteString(cmd("/compact", "压缩早期上下文") + "\n")
	b.WriteString(cmd("/reset", "清空对话（归档保留）") + "\n")
	b.WriteString(group("状态与配置"))
	b.WriteString(cmd("/status", "模型 / 目录 / token 用量") + "\n")
	b.WriteString(cmd("/help", "本帮助") + "\n")
	b.WriteString("\n  " + Dim("直接输入内容即可与 agent 对话；工具执行过程会以灰色显示在上方。") + "\n\n")
	return b.String()
}

// Footer 渲染单轮结束后的耗时与 token 概况。
func Footer(d time.Duration, tokens, compactAt int) string {
	t := fmt.Sprintf("%.1fs", d.Seconds())
	if d < time.Second {
		t = d.Round(10 * time.Millisecond).String()
	}
	s := "  \u00b7 用时 " + t
	if tokens > 0 {
		s += "  \u00b7 上下文 " + fmtK(tokens)
		if compactAt > 0 {
			s += "/" + fmtK(compactAt)
		}
		s += " tokens"
	}
	return Dim(s + "\n")
}

// StatusLine 渲染 /status 的输出。
func StatusLine(model, url, cwd string, tokens, compactAt int) string {
	if home, e := os.UserHomeDir(); e == nil {
		if r, ex := filepath.Rel(home, cwd); ex == nil && !strings.HasPrefix(r, "..") {
			cwd = "~" + string(filepath.Separator) + r
		}
	}
	row := func(k, v string) string {
		return "  " + Dim(padKey(k)) + v + "\n"
	}
	var b strings.Builder
	b.WriteString("\n")
	b.WriteString(row("模型", Green(model)))
	b.WriteString(row("端点", Cyan(cleanURL(url))))
	b.WriteString(row("目录", cwd))
	usage := fmtK(tokens) + " tokens"
	if compactAt > 0 {
		pct := tokens * 100 / compactAt
		usage += Dim(fmt.Sprintf("（到 %d%% 触发压缩，阈值 %s）", pct, fmtK(compactAt)))
	}
	b.WriteString(row("用量", usage))
	b.WriteString("\n")
	return b.String()
}

func cleanURL(u string) string {
	u = strings.TrimPrefix(u, "https://")
	u = strings.TrimPrefix(u, "http://")
	u = strings.TrimSuffix(u, "/")
	return u
}

func padKey(k string) string {
	// 让中文键名对齐（按显示宽度补到 6 列）
	const w = 6
	dw := displayWidth(k)
	if dw >= w {
		return k + " "
	}
	return k + strings.Repeat(" ", w-dw)
}

func fmtK(n int) string {
	if n < 1000 {
		return fmt.Sprint(n)
	}
	s := fmt.Sprintf("%.1f", float64(n)/1000)
	s = strings.TrimSuffix(s, ".0")
	return s + "k"
}
