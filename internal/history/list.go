package history

import (
	"bufio"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"

	"github.com/yanglongyun/agentic/internal/storage"
)

type Session struct {
	ID, Preview string
	Updated     time.Time
}

// List reads metadata and a bounded first-message preview, never the full log.
func List(root string) ([]Session, error) {
	entries, err := os.ReadDir(filepath.Join(root, "sessions"))
	if err != nil {
		return nil, err
	}
	var out []Session
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir, e := storage.SessionDir(root, entry.Name())
		if e != nil {
			continue
		}
		b, e := os.ReadFile(filepath.Join(dir, "session.json"))
		if e != nil {
			continue
		}
		var state State
		if json.Unmarshal(b, &state) != nil || state.Format != 3 {
			continue
		}
		info, e := os.Stat(filepath.Join(dir, "messages.jsonl"))
		if e != nil {
			continue
		}
		if info.Size() == 0 {
			continue
		}
		preview := "（已有消息）"
		if info.Size() > 0 {
			preview = "（已有消息）"
			if f, e := os.Open(filepath.Join(dir, "messages.jsonl")); e == nil {
				line, _ := bufio.NewReader(io.LimitReader(f, 8192)).ReadBytes('\n')
				f.Close()
				var item struct {
					Content json.RawMessage `json:"content"`
				}
				if json.Unmarshal(line, &item) == nil {
					var text string
					if json.Unmarshal(item.Content, &text) != nil {
						var parts []struct {
							Text string `json:"text"`
						}
						if json.Unmarshal(item.Content, &parts) == nil {
							for _, p := range parts {
								text += p.Text
							}
						}
					}
					text = strings.Map(func(r rune) rune {
						if unicode.IsControl(r) {
							return ' '
						}
						return r
					}, text)
					text = strings.Join(strings.Fields(text), " ")
					r := []rune(text)
					if len(r) > 60 {
						text = string(r[:60]) + "…"
					}
					if text != "" {
						preview = text
					}
				}
			}
		}
		out = append(out, Session{ID: entry.Name(), Preview: preview, Updated: info.ModTime()})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Updated.Equal(out[j].Updated) {
			return out[i].ID < out[j].ID
		}
		return out[i].Updated.After(out[j].Updated)
	})
	return out, nil
}
