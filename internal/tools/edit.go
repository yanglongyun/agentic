package tools

import (
	"fmt"
	"os"
	"strings"
)

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
