package cli

import (
	"errors"
	"time"
	"unicode/utf8"
)

var errKeyboardClosed = errors.New("终端输入已关闭")

type key struct {
	r   rune
	err error
}
type keyDecoder struct {
	pending []byte
	escape  int
	since   time.Time
}

func (d *keyDecoder) feed(b []byte, now time.Time) []rune {
	var out []rune
	if d.escape == 1 && now.Sub(d.since) >= 50*time.Millisecond {
		out = append(out, 27)
		d.escape = 0
	}
	if d.escape > 1 && now.Sub(d.since) > time.Second {
		d.escape = 0
	}
	for _, c := range b {
		if d.escape == 1 {
			if c == '[' || c == 'O' {
				d.escape = 2
				continue
			}
			out = append(out, 27)
			d.escape = 0
		} else if d.escape == 2 {
			if c >= 0x40 && c <= 0x7e {
				d.escape = 0
			}
			continue
		}
		if c == 27 {
			d.escape = 1
			d.since = now
			continue
		}
		d.pending = append(d.pending, c)
		for utf8.FullRune(d.pending) {
			r, n := utf8.DecodeRune(d.pending)
			out = append(out, r)
			d.pending = d.pending[n:]
		}
	}
	return out
}
func startKeyboard() (<-chan key, func(), error) {
	poll, restore, err := terminalKeyboard()
	if err != nil {
		return nil, nil, err
	}
	out := make(chan key, 256)
	stop := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer close(out)
		var decoder keyDecoder
		for {
			select {
			case <-stop:
				return
			default:
			}
			b, err := poll()
			if err != nil {
				select {
				case out <- key{err: err}:
				case <-stop:
				}
				return
			}
			for _, r := range decoder.feed(b, time.Now()) {
				select {
				case out <- key{r: r}:
				case <-stop:
					return
				}
			}
		}
	}()
	return out, func() { close(stop); <-done; restore() }, nil
}
