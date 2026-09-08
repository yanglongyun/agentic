package tools

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

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
