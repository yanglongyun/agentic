package render

import (
	"fmt"
	"strings"
	"unicode"
)

const userBackground = "\x1b[48;5;237m\x1b[38;5;252m"

func cellWidth(r rune) int {
	if unicode.Is(unicode.Mn, r) || unicode.Is(unicode.Me, r) || r == 0x200d || unicode.IsControl(r) {
		return 0
	}
	if isWide(r) {
		return 2
	}
	return 1
}

// UserMessage uses erase-to-end background, not width-dependent spaces or hard wraps.
// Soft wrapping is left to the terminal so resizing does not reflow padding as text.
func UserMessage(text string) string {
	text = strings.ReplaceAll(text, "\t", "    ")
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' {
			return -1
		}
		return r
	}, text)
	if !Enabled() {
		return "> " + strings.ReplaceAll(text, "\n", "\n  ") + "\n\n"
	}
	var out strings.Builder
	row := func(line string) { out.WriteString(userBackground + "\x1b[K" + line + " \x1b[K" + sReset + "\n") }
	row("")
	for i, line := range strings.Split(text, "\n") {
		prefix := "    "
		if i == 0 {
			prefix = "  › "
		}
		row(prefix + line)
	}
	row("")
	out.WriteByte('\n')
	return out.String()
}

// ClearInput erases the editable prompt before drawing the submitted message block.
func ClearInput(text string, columns int) string {
	if !Enabled() {
		return "\n"
	}
	if columns < 1 {
		columns = 80
	}
	rows := 1
	col := 0
	for _, r := range text {
		n := cellWidth(r)
		if col+n > columns {
			rows++
			col = 0
		}
		col += n
	}
	var b strings.Builder
	b.WriteString("\r\x1b[2K")
	for i := 1; i < rows; i++ {
		fmt.Fprint(&b, "\x1b[1A\r\x1b[2K")
	}
	return b.String()
}
