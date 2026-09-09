package history

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode"
)

type Message struct {
	Role string
	Text string
}

// Recent reads a bounded tail of the original messages, including compressed history.
// It never changes the active context or reads embedded images into the display.
func (s *Store) Recent(limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 200 {
		limit = 200
	}
	f, err := os.Open(s.Messages)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	stat, err := f.Stat()
	if err != nil {
		return nil, err
	}
	const maxBytes = 1 << 20
	start := stat.Size() - maxBytes
	if start < 0 {
		start = 0
	}
	// Include one extra byte to determine whether the first record is complete.
	readStart := start
	if readStart > 0 {
		readStart--
	}
	data := make([]byte, int(stat.Size()-readStart))
	if len(data) == 0 {
		return nil, nil
	}
	if _, err := f.ReadAt(data, readStart); err != nil {
		return nil, err
	}
	if start > 0 {
		if data[0] == '\n' {
			data = data[1:]
		} else {
			next := bytes.IndexByte(data, '\n')
			if next < 0 {
				return nil, nil
			}
			data = data[next+1:]
		}
	}
	// Ignore a partial append at EOF; only complete JSONL records are replayed.
	end := bytes.LastIndexByte(data, '\n')
	if end < 0 {
		return nil, nil
	}
	data = data[:end]
	var messages []Message
	budget := 20000
	for len(data) > 0 && len(messages) < limit && budget > 0 {
		previous := bytes.LastIndexByte(data, '\n')
		line := data[previous+1:]
		if previous < 0 {
			data = nil
		} else {
			data = data[:previous]
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var item struct {
			Type    string          `json:"type"`
			Role    string          `json:"role"`
			Kind    string          `json:"_kind"`
			Content json.RawMessage `json:"content"`
		}
		if err := json.Unmarshal(line, &item); err != nil {
			return nil, fmt.Errorf("读取历史消息：%w", err)
		}
		if item.Type != "message" || (item.Kind == "compaction" || item.Kind == "agent_result") || (item.Role != "user" && item.Role != "assistant") {
			continue
		}
		var text string
		if json.Unmarshal(item.Content, &text) != nil {
			var parts []struct {
				Type    string `json:"type"`
				Text    string `json:"text"`
				Refusal string `json:"refusal"`
			}
			if json.Unmarshal(item.Content, &parts) != nil {
				continue
			}
			var values []string
			for _, part := range parts {
				if part.Text != "" {
					values = append(values, part.Text)
				}
				if part.Refusal != "" {
					values = append(values, part.Refusal)
				}
				if part.Type == "input_image" {
					values = append(values, "[图片]")
				}
			}
			text = strings.Join(values, "\n")
		}
		text = strings.Map(func(r rune) rune {
			if unicode.IsControl(r) && r != '\n' && r != '\t' {
				return -1
			}
			return r
		}, text)
		if strings.TrimSpace(text) == "" {
			continue
		}
		runes := []rune(text)
		max := 4000
		if budget < max {
			max = budget
		}
		if len(runes) > max {
			runes = append(runes[:max-1], '…')
		}
		budget -= len(runes)
		messages = append(messages, Message{Role: item.Role, Text: string(runes)})
	}
	for i, j := 0, len(messages)-1; i < j; i, j = i+1, j-1 {
		messages[i], messages[j] = messages[j], messages[i]
	}
	return messages, nil
}
