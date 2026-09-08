// Package storage owns the on-disk layout and global session selection.
package storage

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
)

type State struct {
	CurrentSession string `json:"current_session"`
}

var validID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)

// WriteJSON replaces a file atomically without exposing a partially written file.
func WriteJSON(path string, value any) error {
	b, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	return Write(path, append(b, '\n'))
}
func Write(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".agentic-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path)
}

func LoadState(root string) (State, error) {
	var state State
	b, err := os.ReadFile(filepath.Join(root, "state.json"))
	if err != nil {
		return state, err
	}
	if err = json.Unmarshal(b, &state); err != nil {
		return state, err
	}
	if !validID.MatchString(state.CurrentSession) {
		return state, errors.New("state.json 的 current_session 无效")
	}
	return state, nil
}
func SessionDir(root, id string) (string, error) {
	if !validID.MatchString(id) {
		return "", errors.New("会话 ID 无效")
	}
	return filepath.Join(root, "sessions", id), nil
}

// Prepare initializes only the selected root. No legacy paths are read or migrated.
func Prepare(root string) error {
	for _, name := range []string{"history.jsonl", "archive.jsonl"} {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			return fmt.Errorf("旧数据目录 %s 不支持迁移，请指定新的 AGENT_HOME", root)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if _, err := os.Stat(filepath.Join(root, "state.json")); err == nil {
		_, err = LoadState(root)
		return err
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "sessions"), 0700); err != nil {
		return err
	}
	return WriteJSON(filepath.Join(root, "state.json"), State{CurrentSession: "cli"})
}
