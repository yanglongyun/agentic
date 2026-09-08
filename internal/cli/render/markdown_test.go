package render

import (
	"os"
	"strings"
	"sync"
	"testing"
)

// plain 关闭颜色，返回纯文本渲染结果，便于稳定断言。
func plain(s string) string {
	os.Setenv("AGENT_COLOR", "0")
	once = sync.Once{}
	return Markdown(s)
}

func TestMarkdownStripsMarkers(t *testing.T) {
	in := "## 标题\n有 **加粗** 和 `代码` 与 [链接](http://x)。\n"
	out := plain(in)
	for _, bad := range []string{"##", "**", "`", "[链接]("} {
		if strings.Contains(out, bad) {
			t.Errorf("输出仍含 markdown 标记 %q：%q", bad, out)
		}
	}
	for _, want := range []string{"标题", "加粗", "代码", "链接", "http://x"} {
		if !strings.Contains(out, want) {
			t.Errorf("输出缺少内容 %q：%q", want, out)
		}
	}
}

func TestMarkdownCodeBlockAndList(t *testing.T) {
	in := "- 项目一\n```go\nfmt.Println(\"hi\") // 中文\n```\n"
	out := plain(in)
	if !strings.Contains(out, "•") {
		t.Errorf("列表项未渲染成圆点：%q", out)
	}
	if !strings.Contains(out, "go") { // 语言标注保留
		t.Errorf("代码块语言标注丢失：%q", out)
	}
	if !strings.Contains(out, "fmt.Println") || !strings.Contains(out, "中文") {
		t.Errorf("代码块内容被吞：%q", out)
	}
}

func TestMarkdownTable(t *testing.T) {
	in := "| a | 名称 |\n|---|---|\n| 1 | 值 |\n"
	out := plain(in)
	if !strings.Contains(out, "a") || !strings.Contains(out, "名称") || !strings.Contains(out, "值") {
		t.Errorf("表格单元格内容丢失：%q", out)
	}
	if !strings.Contains(out, "│") {
		t.Errorf("表格未渲染分隔线：%q", out)
	}
}

func TestDisplayWidthCJK(t *testing.T) {
	if got := displayWidth("中文"); got != 4 {
		t.Errorf("中文应为 4 列，实际 %d", got)
	}
	if got := displayWidth("ab中"); got != 4 {
		t.Errorf("ab中应为 4 列，实际 %d", got)
	}
}
