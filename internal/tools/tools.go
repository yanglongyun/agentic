package tools

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
	"unicode/utf8"
)

type Result struct {
	Text         string
	ImageDataURL string
	ImageName    string
}
type Set struct {
	Timeout   time.Duration
	MaxOutput int
	ImageMax  int64
	EditMax   int64
}

func New(timeoutSeconds, maxOutput int) *Set {
	return &Set{Timeout: time.Duration(timeoutSeconds) * time.Second, MaxOutput: maxOutput, ImageMax: 5 << 20, EditMax: 2 << 20}
}

func Definitions() []map[string]any {
	return []map[string]any{
		def("shell", "执行终端命令并返回合并输出和退出码。Linux/macOS 使用 shell，Windows 使用 PowerShell。", map[string]any{"command": prop("string", "要执行的命令"), "workdir": prop("string", "可选工作目录")}, []string{"command"}),
		def("read", "读取文本文件并带行号返回；png/jpg/gif/webp 图片会直接提供给模型。", map[string]any{"path": prop("string", "文件路径"), "offset": prop("integer", "起始行，默认 1"), "limit": prop("integer", "最多行数，默认 2000")}, []string{"path"}),
		def("write", "完整写入文件，自动创建父目录。", map[string]any{"path": prop("string", "文件路径"), "content": prop("string", "完整内容")}, []string{"path", "content"}),
		def("edit", "精确替换文件文本；默认要求仅匹配一次。", map[string]any{"path": prop("string", "文件路径"), "old_string": prop("string", "原文"), "new_string": prop("string", "新内容"), "replace_all": prop("boolean", "替换全部，默认 false")}, []string{"path", "old_string", "new_string"}),
	}
}

func (s *Set) Run(ctx context.Context, name, raw string) Result {
	var a map[string]any
	if err := json.Unmarshal([]byte(raw), &a); err != nil {
		return Result{Text: "错误：工具参数不是合法 JSON：" + err.Error()}
	}
	switch name {
	case "shell":
		return s.shell(ctx, a)
	case "read":
		return s.read(a)
	case "write":
		return s.write(a)
	case "edit":
		return s.edit(a)
	default:
		return Result{Text: "错误：没有这个工具：" + name}
	}
}

func (s *Set) shell(parent context.Context, a map[string]any) Result {
	command, _ := a["command"].(string)
	if command == "" {
		return Result{Text: "错误：缺少 command 参数"}
	}
	ctx, cancel := context.WithTimeout(parent, s.Timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		exe := "powershell.exe"
		if _, e := exec.LookPath("pwsh"); e == nil {
			exe = "pwsh"
		}
		cmd = exec.CommandContext(ctx, exe, "-NoProfile", "-NonInteractive", "-Command", command)
	} else {
		exe := "/bin/sh"
		if _, e := os.Stat("/bin/bash"); e == nil {
			exe = "/bin/bash"
		}
		cmd = exec.CommandContext(ctx, exe, "-c", command)
	}
	if wd, _ := a["workdir"].(string); wd != "" {
		cmd.Dir = wd
	}
	var out limitedBuffer
	out.max = s.MaxOutput
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	code := 0
	if err != nil {
		code = -1
		if e, ok := err.(*exec.ExitError); ok {
			code = e.ExitCode()
		}
	}
	text := out.String()
	if text == "" {
		text = "(无输出)"
	}
	if ctx.Err() == context.DeadlineExceeded {
		text += fmt.Sprintf("\n[超时：命令超过 %s 被终止]", s.Timeout)
	}
	return Result{Text: fmt.Sprintf("%s\n\n[退出码 %d]", text, code)}
}

func (s *Set) read(a map[string]any) Result {
	p, _ := a["path"].(string)
	if p == "" {
		return Result{Text: "错误：缺少 path 参数"}
	}
	info, err := os.Stat(p)
	if err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	if info.IsDir() {
		return Result{Text: "错误：这是个目录，请用 shell 查看：" + p}
	}
	ext := strings.ToLower(filepath.Ext(p))
	if ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" {
		if info.Size() > s.ImageMax {
			return Result{Text: "错误：图片超过 5MB"}
		}
		b, e := os.ReadFile(p)
		if e != nil {
			return Result{Text: "错误：" + e.Error()}
		}
		mt := mime.TypeByExtension(ext)
		if mt == "" {
			mt = "application/octet-stream"
		}
		return Result{Text: fmt.Sprintf("已读取图片 %s（%d 字节）", p, len(b)), ImageName: p, ImageDataURL: "data:" + mt + ";base64," + base64.StdEncoding.EncodeToString(b)}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	if bytes.IndexByte(b, 0) >= 0 || !utf8.Valid(b) {
		return Result{Text: "错误：这看起来是二进制文件：" + p}
	}
	offset := intArg(a, "offset", 1)
	limit := intArg(a, "limit", 2000)
	if offset < 1 {
		offset = 1
	}
	if limit < 1 {
		limit = 2000
	}
	lines := strings.Split(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	total := len(lines)
	start := offset - 1
	if start > total {
		start = total
	}
	end := start + limit
	if end > total {
		end = total
	}
	var out strings.Builder
	for i := start; i < end; i++ {
		fmt.Fprintf(&out, "%6d\t%s\n", i+1, lines[i])
	}
	text := strings.TrimSuffix(out.String(), "\n")
	if text == "" {
		text = "(文件为空，或 offset 超出末尾)"
	}
	return Result{Text: truncate(text+fmt.Sprintf("\n\n[共 %d 行]", total), s.MaxOutput)}
}

func (s *Set) write(a map[string]any) Result {
	p, _ := a["path"].(string)
	c, ok := a["content"].(string)
	if p == "" || !ok {
		return Result{Text: "错误：缺少 path 或 content 参数"}
	}
	_, statErr := os.Stat(p)
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	if err := os.WriteFile(p, []byte(c), 0644); err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	verb := "已创建"
	if statErr == nil {
		verb = "已覆盖"
	}
	return Result{Text: fmt.Sprintf("%s %s（%d 字节）", verb, p, len([]byte(c)))}
}

func (s *Set) edit(a map[string]any) Result {
	p, _ := a["path"].(string)
	old, ok1 := a["old_string"].(string)
	newText, ok2 := a["new_string"].(string)
	all, _ := a["replace_all"].(bool)
	if p == "" || !ok1 || !ok2 || old == "" {
		return Result{Text: "错误：缺少参数或 old_string 为空"}
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	if int64(len(b)) > s.EditMax {
		return Result{Text: "错误：文件超过 2MB，请用 shell 处理"}
	}
	content := string(b)
	n := strings.Count(content, old)
	if n == 0 {
		return Result{Text: "错误：没有找到 old_string"}
	}
	if n > 1 && !all {
		return Result{Text: fmt.Sprintf("错误：old_string 匹配到 %d 处，请增加上下文或设 replace_all=true", n)}
	}
	limit := 1
	if all {
		limit = -1
	}
	result := strings.Replace(content, old, newText, limit)
	if err := os.WriteFile(p, []byte(result), infoMode(p)); err != nil {
		return Result{Text: "错误：" + err.Error()}
	}
	changed := 1
	if all {
		changed = n
	}
	return Result{Text: fmt.Sprintf("已修改 %s（替换了 %d 处）", p, changed)}
}

type limitedBuffer struct {
	bytes.Buffer
	max       int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.max - b.Len()
	if remaining > 0 {
		take := len(p)
		if take > remaining {
			take = remaining
		}
		_, _ = b.Buffer.Write(p[:take])
	}
	if len(p) > remaining {
		b.truncated = true
	}
	return n, nil
}
func (b *limitedBuffer) String() string {
	s := b.Buffer.String()
	if b.truncated {
		s += "\n...[输出已截断]"
	}
	return s
}
func truncate(v string, n int) string {
	if len(v) <= n {
		return v
	}
	return v[:n] + "\n...[输出已截断]"
}
func infoMode(p string) os.FileMode {
	if i, e := os.Stat(p); e == nil {
		return i.Mode().Perm()
	}
	return 0644
}
func intArg(a map[string]any, k string, d int) int {
	if v, ok := a[k].(float64); ok {
		return int(v)
	}
	return d
}
func prop(t, d string) map[string]any { return map[string]any{"type": t, "description": d} }
func def(name, description string, properties map[string]any, required []string) map[string]any {
	return map[string]any{"type": "function", "name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required}}
}
