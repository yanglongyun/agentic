package history

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

type Store struct{ Dir, Current, Archive, State string }
type State struct {
	Tokens int `json:"tokens"`
}

func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	s := &Store{Dir: dir, Current: filepath.Join(dir, "history.jsonl"), Archive: filepath.Join(dir, "archive.jsonl"), State: filepath.Join(dir, "state.json")}
	for _, p := range []string{s.Current, s.Archive} {
		f, err := os.OpenFile(p, os.O_CREATE, 0600)
		if err != nil {
			return nil, err
		}
		f.Close()
	}
	if _, err := os.Stat(s.State); errors.Is(err, os.ErrNotExist) {
		if err := s.SetTokens(0); err != nil {
			return nil, err
		}
	}
	return s, nil
}

func (s *Store) Items() ([]map[string]any, error) {
	f, err := os.Open(s.Current)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	var out []map[string]any
	scan := bufio.NewScanner(f)
	scan.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for scan.Scan() {
		var v map[string]any
		if err := json.Unmarshal(scan.Bytes(), &v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, scan.Err()
}

func (s *Store) Append(item map[string]any) error {
	b, err := json.Marshal(item)
	if err != nil {
		return err
	}
	for _, p := range []string{s.Current, s.Archive} {
		f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		_, e := fmt.Fprintln(f, string(b))
		c := f.Close()
		if e != nil {
			return e
		}
		if c != nil {
			return c
		}
	}
	return nil
}

func (s *Store) Replace(items []map[string]any) error {
	tmp := s.Current + ".tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	enc := json.NewEncoder(f)
	for _, v := range items {
		if err := enc.Encode(v); err != nil {
			f.Close()
			return err
		}
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, s.Current)
}

func (s *Store) Reset() error {
	if err := os.Truncate(s.Current, 0); err != nil {
		return err
	}
	return s.SetTokens(0)
}
func (s *Store) Tokens() int {
	b, _ := os.ReadFile(s.State)
	var v State
	_ = json.Unmarshal(b, &v)
	return v.Tokens
}
func (s *Store) SetTokens(n int) error {
	b, _ := json.Marshal(State{Tokens: n})
	return os.WriteFile(s.State, append(b, '\n'), 0600)
}
