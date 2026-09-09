// Package history stores immutable messages and compression records.
package history

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/yanglongyun/agentic/internal/storage"
)

type Store struct{ Dir, Messages, Compactions, State string }
type Range struct {
	From int64 `json:"from"`
	To   int64 `json:"to"`
}
type State struct {
	Format     int                 `json:"format"`
	Tokens     int                 `json:"tokens"`
	ID         string              `json:"id"`
	CreatedAt  time.Time           `json:"created_at"`
	Start      int64               `json:"start"`
	Compaction int64               `json:"compaction"`
	Excluded   []Range             `json:"excluded,omitempty"`
	Agent      *AgentRecord        `json:"agent,omitempty"`
	Delivered  map[string]bool     `json:"delivered_agents,omitempty"`
	Delivery   *DeliveryCheckpoint `json:"delivery,omitempty"`
}
type Compaction struct {
	CreatedAt time.Time      `json:"created_at"`
	From      int64          `json:"from"`
	Through   int64          `json:"through"`
	Summary   map[string]any `json:"summary"`
}
type Checkpoint struct {
	state State
	count int64
}

func Open(dir string) (*Store, error)      { return open(dir, "session.json") }
func OpenAgent(dir string) (*Store, error) { return open(dir, "state.json") }
func open(dir, stateName string) (*Store, error) {
	for _, name := range []string{"history.jsonl", "archive.jsonl", "state.json"} {
		if stateName == "state.json" && name == "state.json" {
			continue
		}
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return nil, fmt.Errorf("检测到旧格式文件 %s，不支持迁移；请使用新的 AGENT_HOME 或会话 ID", filepath.Join(dir, name))
		} else if !errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
	}
	s := &Store{Dir: dir, Messages: filepath.Join(dir, "messages.jsonl"), Compactions: filepath.Join(dir, "compactions.jsonl"), State: filepath.Join(dir, stateName)}
	state, err := s.load()
	if errors.Is(err, os.ErrNotExist) {
		for _, p := range []string{s.Messages, s.Compactions} {
			if _, e := os.Stat(p); e == nil {
				return nil, errors.New("消息文件缺少 session.json，未修改数据")
			} else if !errors.Is(e, os.ErrNotExist) {
				return nil, e
			}
		}
		state = State{Format: 3, Compaction: -1, ID: filepath.Base(dir), CreatedAt: time.Now().UTC()}
		if err = storage.WriteJSON(s.State, state); err != nil {
			return nil, err
		}
	} else if err != nil {
		return nil, err
	}
	for _, p := range []string{s.Messages, s.Compactions} {
		f, e := os.OpenFile(p, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if e != nil {
			return nil, e
		}
		if e = f.Close(); e != nil {
			return nil, e
		}
	}
	if state.Delivery != nil {
		if err := s.AbortDelivery(); err != nil {
			return nil, err
		}
	}
	return s, nil
}
func (s *Store) load() (State, error) {
	var v State
	b, err := os.ReadFile(s.State)
	if err != nil {
		return v, err
	}
	if err = json.Unmarshal(b, &v); err != nil {
		return v, err
	}
	if v.Format != 3 {
		return v, errors.New("旧版或未知 session.json 格式，不支持迁移；请使用新的会话目录")
	}
	if v.Start < 0 || v.Compaction < -1 {
		return v, errors.New("会话游标无效")
	}
	return v, nil
}
func appendLine(path string, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err = f.Write(append(b, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

// readRecord reads a single bounded JSONL record and reports its exact byte size.
func readRecord(r *bufio.Reader) ([]byte, int64, error) {
	var line []byte
	for {
		part, err := r.ReadSlice('\n')
		if len(line)+len(part) > 16*1024*1024 {
			return nil, 0, errors.New("JSONL 记录超过 16 MiB")
		}
		line = append(line, part...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err == io.EOF && len(line) > 0 {
			return nil, 0, errors.New("JSONL 尾部记录不完整")
		}
		return line, int64(len(line)), err
	}
}
func fileSize(path string) (int64, error) {
	v, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return v.Size(), nil
}
func (s *Store) view() ([]map[string]any, []int64, error) {
	state, err := s.load()
	if err != nil {
		return nil, nil, err
	}
	f, err := os.Open(s.Messages)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	size := info.Size()
	if state.Start > size {
		return nil, nil, errors.New("会话起点超出消息文件")
	}
	for i, r := range state.Excluded {
		if r.From < 0 || r.To < r.From || r.To > size || (i > 0 && state.Excluded[i-1].To > r.From) {
			return nil, nil, errors.New("排除范围无效")
		}
	}
	offset := state.Start
	var items []map[string]any
	var ends []int64
	if state.Compaction >= 0 {
		log, e := os.Open(s.Compactions)
		if e != nil {
			return nil, nil, e
		}
		_, e = log.Seek(state.Compaction, io.SeekStart)
		var line []byte
		if e == nil {
			line, _, e = readRecord(bufio.NewReader(log))
		}
		log.Close()
		if e != nil {
			return nil, nil, e
		}
		var c Compaction
		if e = json.Unmarshal(line, &c); e != nil {
			return nil, nil, e
		}
		if c.From != state.Start || c.Through < offset || c.Through > size || c.Summary == nil {
			return nil, nil, errors.New("压缩范围无效")
		}
		items = append(items, c.Summary)
		ends = append(ends, c.Through)
		offset = c.Through
	}
	if _, err = f.Seek(offset, io.SeekStart); err != nil {
		return nil, nil, err
	}
	reader := bufio.NewReader(f)
	excluded := 0
	for offset < size {
		for excluded < len(state.Excluded) && state.Excluded[excluded].To <= offset {
			excluded++
		}
		if excluded < len(state.Excluded) && state.Excluded[excluded].From <= offset {
			offset = state.Excluded[excluded].To
			if _, err = f.Seek(offset, io.SeekStart); err != nil {
				return nil, nil, err
			}
			reader.Reset(f)
			continue
		}
		line, n, e := readRecord(reader)
		if e != nil {
			return nil, nil, e
		}
		var item map[string]any
		if e = json.Unmarshal(line, &item); e != nil {
			return nil, nil, fmt.Errorf("消息偏移 %d: %w", offset, e)
		}
		offset += n
		items = append(items, item)
		ends = append(ends, offset)
	}
	return items, ends, nil
}
func (s *Store) Items() ([]map[string]any, error) { items, _, err := s.view(); return items, err }
func (s *Store) Append(item map[string]any) error { return appendLine(s.Messages, item) }

// Compact replaces a prefix of the active context by an append-only summary.
func (s *Store) Compact(cut int, summary map[string]any) error {
	items, indices, err := s.view()
	if err != nil {
		return err
	}
	if cut < 1 || cut > len(items) || summary == nil {
		return errors.New("压缩边界或摘要无效")
	}
	state, err := s.load()
	if err != nil {
		return err
	}
	recordOffset, err := fileSize(s.Compactions)
	if err != nil {
		return err
	}
	record := Compaction{CreatedAt: time.Now().UTC(), From: state.Start, Through: indices[cut-1], Summary: summary}
	if err = appendLine(s.Compactions, record); err != nil {
		return err
	}
	state.Compaction = recordOffset
	// Exclusions covered by the new summary no longer need checking.
	kept := state.Excluded[:0]
	for _, r := range state.Excluded {
		if r.To > record.Through {
			kept = append(kept, r)
		}
	}
	state.Excluded = kept
	state.Tokens = 0
	return storage.WriteJSON(s.State, state)
}
func (s *Store) Checkpoint() (Checkpoint, error) {
	state, err := s.load()
	if err != nil {
		return Checkpoint{}, err
	}
	size, err := fileSize(s.Messages)
	return Checkpoint{state: state, count: size}, err
}

// Restore hides failed-turn messages from context without erasing audit records.
func (s *Store) Restore(c Checkpoint) error {
	size, err := fileSize(s.Messages)
	if err != nil {
		return err
	}
	if c.count > size {
		return errors.New("消息检查点无效")
	}
	state := c.state
	if size > c.count {
		n := len(state.Excluded)
		if n > 0 && state.Excluded[n-1].To == c.count {
			state.Excluded[n-1].To = size
		} else {
			state.Excluded = append(state.Excluded, Range{c.count, size})
		}
	}
	return storage.WriteJSON(s.State, state)
}
func (s *Store) Tokens() int { v, _ := s.load(); return v.Tokens }
func (s *Store) SetTokens(n int) error {
	v, err := s.load()
	if err != nil {
		return err
	}
	v.Tokens = n
	return storage.WriteJSON(s.State, v)
}
