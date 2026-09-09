package render

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Banner 渲染进入 REPL 时的欢迎块。
func Banner(version, model, apiURL string) string {
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
	b.WriteString("  " + Bold(Cyan("agent")) + "\n")
	b.WriteString("  " + Dim("版本 ") + Bold(version) + "\n")
	b.WriteString("  " + Dim("模型 ") + Green(model) + "\n")
	b.WriteString("  " + Dim("目录 ") + cwd + "\n")
	b.WriteString("  " + Dim("主机 ") + host + "\n")
	b.WriteString("  " + Dim("API  ") + Cyan(apiURL) + "\n")
	b.WriteString("  " + Dim("/help   命令") + "\n")
	b.WriteString("  " + Dim("/status 状态") + "\n")
	b.WriteString("  " + Dim("/resume 历史会话") + "\n")
	b.WriteString("  " + Dim("/exit   退出") + "\n")
	b.WriteString(line + "\n\n")
	return b.String()
}

// Help 每行显示一条命令或快捷键。
func Help() string {
	rows := []struct{ name, desc string }{
		{"/help", "查看命令"},
		{"/resume", "继续历史会话"},
		{"/status", "查看状态"},
		{"/exit", "退出"},
		{"/quit", "退出"},
		{"Esc", "停止回复"},
		{"Ctrl+C", "停止回复或退出"},
	}
	var b strings.Builder
	b.WriteByte('\n')
	for _, row := range rows {
		b.WriteString("  " + Bold(Yellow(row.name)) + strings.Repeat(" ", 12-displayWidth(row.name)) + row.desc + "\n")
	}
	b.WriteByte('\n')
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
		usage += Dim(fmt.Sprintf(" / %s（%d%%）", fmtK(compactAt), pct))
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
