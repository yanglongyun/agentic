package history

import (
	"os"
	"strings"
	"testing"
)

func TestRecentIncludesCompressedMessagesAndPreservesContext(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"one", "two", "three", "four", "five", "six"} {
		if err := h.Append(map[string]any{"type": "message", "role": "user", "content": text}); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.Compact(4, map[string]any{"type": "message", "role": "user", "content": "summary", "_kind": "compaction"}); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(h.State)
	if err := h.Append(map[string]any{"type": "function_call_output", "output": "do not display"}); err != nil {
		t.Fatal(err)
	}
	got, err := h.Recent(3)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Text != "four" || got[2].Text != "six" {
		t.Fatal(got)
	}
	after, _ := os.ReadFile(h.State)
	if string(before) != string(after) {
		t.Fatal("replay changed active context")
	}
}

func TestRecentSkipsUnreadPrefixAndPartialRecords(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// Invalid old bytes are outside the bounded tail and must never be parsed.
	if err := os.WriteFile(h.Messages, []byte(strings.Repeat("x", 2<<20)+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := h.Append(map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "你好\x1b"}}}); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(h.Messages, os.O_APPEND|os.O_WRONLY, 0600)
	_, err = f.WriteString(`{"type":"message","content":"partial`)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	got, err := h.Recent(20)
	if err != nil || len(got) != 1 || got[0].Text != "你好" {
		t.Fatal(got, err)
	}
}

func TestRecentDisplayBudgetKeepsNewestMessages(t *testing.T) {
	h, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 8; i++ {
		if err := h.Append(map[string]any{"type": "message", "role": "user", "content": strings.Repeat(string(rune('a'+i)), 5000)}); err != nil {
			t.Fatal(err)
		}
	}
	got, err := h.Recent(200)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 || !strings.HasPrefix(got[0].Text, "d") || !strings.HasPrefix(got[4].Text, "h") {
		t.Fatal("wrong recent messages")
	}
	total := 0
	for _, message := range got {
		n := len([]rune(message.Text))
		total += n
		if n > 4000 || !strings.HasSuffix(message.Text, "…") {
			t.Fatal("message not bounded")
		}
	}
	if total > 20000 {
		t.Fatal("replay exceeds display budget")
	}
}
