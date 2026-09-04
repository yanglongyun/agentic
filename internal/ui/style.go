// Package ui 提供纯标准库实现的终端样式与 markdown 渲染。
// 不依赖任何第三方库；是否输出 ANSI 由终端能力自动判定，也可用环境变量强制。
package ui

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	once    sync.Once
	enabled bool
)

// Enabled 报告是否应当输出 ANSI 转义序列。
// 判定顺序：AGENT_COLOR 强制 > NO_COLOR/TERM=dumb 关闭 > 非 TTY 关闭 > 默认开启。
func Enabled() bool {
	once.Do(func() {
		if v, ok := os.LookupEnv("AGENT_COLOR"); ok {
			enabled = v == "1" || strings.EqualFold(v, "true")
			return
		}
		if v, ok := os.LookupEnv("NO_COLOR"); ok && v != "" {
			enabled = false
			return
		}
		if os.Getenv("TERM") == "dumb" {
			enabled = false
			return
		}
		if fi, err := os.Stdout.Stat(); err == nil {
			enabled = fi.Mode()&os.ModeCharDevice != 0
		}
	})
	return enabled
}

const (
	sReset   = "\x1b[0m"
	sBold    = "\x1b[1m"
	sFaint   = "\x1b[2m"
	sItalic  = "\x1b[3m"
	sUnder   = "\x1b[4m"
	sRed     = "\x1b[31m"
	sGreen   = "\x1b[32m"
	sYellow  = "\x1b[33m"
	sBlue    = "\x1b[34m"
	sMagenta = "\x1b[35m"
	sCyan    = "\x1b[36m"
	sGray    = "\x1b[90m"
)

// paint 在开启样式时用给定码包裹文本；否则原样返回。
func paint(s string, codes ...string) string {
	if !Enabled() || s == "" {
		return s
	}
	return strings.Join(codes, "") + s + sReset
}

func Bold(s string) string      { return paint(s, sBold) }
func Dim(s string) string       { return paint(s, sFaint) }
func Italic(s string) string    { return paint(s, sItalic) }
func Underline(s string) string { return paint(s, sUnder) }
func Red(s string) string       { return paint(s, sRed) }
func Green(s string) string     { return paint(s, sGreen) }
func Yellow(s string) string    { return paint(s, sYellow) }
func Blue(s string) string      { return paint(s, sBlue) }
func Magenta(s string) string   { return paint(s, sMagenta) }
func Cyan(s string) string      { return paint(s, sCyan) }
func Gray(s string) string      { return paint(s, sGray) }

// 角色标签用的语义色，集中在这里方便统一换主题。

func LabelUser(s string) string      { return paint(s, sBold, sGreen) }
func LabelAssistant(s string) string { return paint(s, sBold, sCyan) }
func LabelSystem(s string) string    { return paint(s, sFaint) }
func Prompt(s string) string         { return paint(s, sBold, sMagenta) }

// ToolCall 打印一次工具调用（灰色，前缀 ▸）。
func ToolCall(name, args string, max int) {
	msg := "  \u25b8 " + name
	if a := shorten(args, max); a != "" {
		msg += "  " + a
	}
	fprintlnStderr(Dim(msg))
}

// ToolResult 打印一次工具调用的结果状态与耗时。
func ToolResult(d time.Duration, output string) {
	sym := Green("\u2713")
	if strings.HasPrefix(strings.TrimSpace(output), "错误") {
		sym = Red("\u2717")
	}
	fprintlnStderr("    " + sym + Dim(" "+fmtDuration(d)))
}

func fmtDuration(d time.Duration) string {
	switch {
	case d < time.Second:
		return d.Round(10 * time.Millisecond).String()
	case d < time.Minute:
		return fmt.Sprintf("%.1fs", d.Seconds())
	default:
		return fmt.Sprintf("%.1fmin", d.Minutes())
	}
}

func shorten(s string, n int) string {
	s = strings.ReplaceAll(strings.TrimSpace(s), "\n", " ")
	if n <= 0 || len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// fprintlnStderr 把一行文本写到 stderr（工具调用/耗时这类过程信息走这里，
// 保证 `agent "..." | grep` 这种管道调用时 stdout 仍是干净的正文）。
func fprintlnStderr(s string) {
	fmt.Fprintln(os.Stderr, s)
}
