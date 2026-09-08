package history

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func msg(text string) map[string]any {
	return map[string]any{"type": "message", "role": "user", "content": text}
}
func add(t *testing.T, s *Store, text string) {
	t.Helper()
	if err := s.Append(msg(text)); err != nil {
		t.Fatal(err)
	}
}
func contents(t *testing.T, s *Store) []map[string]any {
	t.Helper()
	v, err := s.Items()
	if err != nil {
		t.Fatal(err)
	}
	return v
}
func TestCompactionAndReopen(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range []string{"a", "b", "c", "d"} {
		add(t, s, v)
	}
	original, _ := os.ReadFile(s.Messages)
	if err = s.Compact(2, msg("summary-ab")); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(contents(t, s), []map[string]any{msg("summary-ab"), msg("c"), msg("d")}) {
		t.Fatal(contents(t, s))
	}
	add(t, s, "e")
	if err = s.Compact(2, msg("summary-abc")); err != nil {
		t.Fatal(err)
	}
	s, err = Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(contents(t, s), []map[string]any{msg("summary-abc"), msg("d"), msg("e")}) {
		t.Fatal(contents(t, s))
	}
	records, err := readLines[Compaction](s.Compactions)
	if err != nil || len(records) != 2 || records[1].Through <= records[0].Through {
		t.Fatal(records, err)
	}
	messages, _ := os.ReadFile(s.Messages)
	if string(messages[:len(original)]) != string(original) {
		t.Fatal("rewrote messages")
	}

}

func TestRestorePreservesLogAndPriorSummary(t *testing.T) {
	s, _ := Open(t.TempDir())
	add(t, s, "a")
	add(t, s, "b")
	s.Compact(1, msg("summary-a"))
	s.SetTokens(42)
	checkpoint, err := s.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	add(t, s, "failed-turn")
	s.Compact(2, msg("uncommitted-summary"))
	if err = s.Restore(checkpoint); err != nil {
		t.Fatal(err)
	}
	add(t, s, "next-turn")
	want := []map[string]any{msg("summary-a"), msg("b"), msg("next-turn")}
	if !reflect.DeepEqual(contents(t, s), want) || s.Tokens() != 42 {
		t.Fatal(contents(t, s), s.Tokens())
	}
	all, _ := readLines[map[string]any](s.Messages)
	if len(all) != 4 {
		t.Fatal("lost failed-turn audit")
	}
	if err = s.Compact(2, msg("summary-ab")); err != nil {
		t.Fatal(err)
	}
	s, err = Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(contents(t, s), []map[string]any{msg("summary-ab"), msg("next-turn")}) {
		t.Fatal(contents(t, s))
	}
}
func TestNoLegacyMigration(t *testing.T) {
	for _, name := range []string{"history.jsonl", "archive.jsonl", "state.json", "session.json"} {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, name)
			old := []byte(`{"tokens":25}`)
			os.WriteFile(p, old, 0600)
			if _, err := Open(dir); err == nil {
				t.Fatal("accepted legacy session")
			}
			b, _ := os.ReadFile(p)
			entries, _ := os.ReadDir(dir)
			if string(b) != string(old) || len(entries) != 1 {
				t.Fatal("changed legacy data")
			}
		})
	}
}
func TestCorruptMetadata(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "session.json"), []byte("broken"), 0600)
	if _, err := Open(dir); err == nil {
		t.Fatal("accepted corrupt metadata")
	}
}
