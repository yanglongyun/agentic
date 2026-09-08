package tools

import (
	"fmt"
	"os"
	"path/filepath"
)

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
