package tools

import (
	"context"
	"encoding/json"
	"time"
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

func prop(t, d string) map[string]any { return map[string]any{"type": t, "description": d} }
func def(name, description string, properties map[string]any, required []string) map[string]any {
	return map[string]any{"type": "function", "name": name, "description": description, "parameters": map[string]any{"type": "object", "properties": properties, "required": required}}
}
