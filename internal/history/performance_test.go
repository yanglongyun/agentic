package history

import (
	"github.com/yanglongyun/agentic/internal/storage"
	"os"
	"testing"
)

// The skipped prefix deliberately is not JSON: decoding it would fail the test.
func largeStore(tb testing.TB, size int64) *Store {
	tb.Helper()
	s, err := Open(tb.TempDir())
	if err != nil {
		tb.Fatal(err)
	}
	f, err := os.OpenFile(s.Messages, os.O_WRONLY, 0600)
	if err != nil {
		tb.Fatal(err)
	}
	if err = f.Truncate(size); err != nil {
		tb.Fatal(err)
	}
	f.Close()
	if err = s.Append(msg("tail")); err != nil {
		tb.Fatal(err)
	}
	// Also prove that old compression records are not scanned.
	os.WriteFile(s.Compactions, []byte("not-json\n"), 0600)
	if err = appendLine(s.Compactions, Compaction{From: 0, Through: size, Summary: msg("summary")}); err != nil {
		tb.Fatal(err)
	}
	state, _ := s.load()
	state.Compaction = int64(len("not-json\n"))
	if err = storage.WriteJSON(s.State, state); err != nil {
		tb.Fatal(err)
	}
	return s
}
func TestReadsOnlyActiveTail(t *testing.T) {
	s := largeStore(t, 64<<20)
	reopened, err := Open(s.Dir)
	if err != nil {
		t.Fatal(err)
	}
	items, err := reopened.Items()
	if err != nil || len(items) != 2 {
		t.Fatal(items, err)
	}
	checkpoint, err := s.Checkpoint()
	if err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(s.Messages, os.O_APPEND|os.O_WRONLY, 0600)
	f.WriteString("failed unreadable record\n")
	f.Close()
	if err = s.Restore(checkpoint); err != nil {
		t.Fatal(err)
	}
	if err = s.Append(msg("next")); err != nil {
		t.Fatal(err)
	}
	items, err = s.Items()
	if err != nil || len(items) != 3 {
		t.Fatal(items, err)
	}
	if err = s.Compact(2, msg("updated-summary")); err != nil {
		t.Fatal(err)
	}
	items, err = s.Items()
	if err != nil || len(items) != 2 {
		t.Fatal(items, err)
	}
}
func BenchmarkActiveContext(b *testing.B) {
	for _, v := range []struct {
		name string
		size int64
	}{{"1MiB", 1 << 20}, {"64MiB", 64 << 20}} {
		b.Run(v.name, func(b *testing.B) {
			s := largeStore(b, v.size)
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, err := s.Items(); err != nil {
					b.Fatal(err)
				}
			}
		})
	}
}
