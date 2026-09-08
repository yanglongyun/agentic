package tools

import (
	"bytes"
	"os"
)

type limitedBuffer struct {
	bytes.Buffer
	max       int
	truncated bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	remaining := b.max - b.Len()
	if remaining > 0 {
		take := len(p)
		if take > remaining {
			take = remaining
		}
		_, _ = b.Buffer.Write(p[:take])
	}
	if len(p) > remaining {
		b.truncated = true
	}
	return n, nil
}
func (b *limitedBuffer) String() string {
	s := b.Buffer.String()
	if b.truncated {
		s += "\n...[输出已截断]"
	}
	return s
}
func truncate(v string, n int) string {
	if len(v) <= n {
		return v
	}
	return v[:n] + "\n...[输出已截断]"
}
func infoMode(p string) os.FileMode {
	if i, e := os.Stat(p); e == nil {
		return i.Mode().Perm()
	}
	return 0644
}
func intArg(a map[string]any, k string, d int) int {
	if v, ok := a[k].(float64); ok {
		return int(v)
	}
	return d
}
