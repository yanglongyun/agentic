package ui

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Markdown 把模型输出的 markdown 渲染成带样式的终端文本。
// 采用逐行块级解析 + 行内解析的轻量实现，只处理终端里最常见、最有用的语法，
// 未识别的行按原样输出，保证不吞内容。
func Markdown(src string) string {
	src = strings.ReplaceAll(src, "\r\n", "\n")
	lines := strings.Split(src, "\n")

	var b strings.Builder
	inFence := false
	tableBuf := []string{}

	flushTable := func() {
		if len(tableBuf) > 0 {
			b.WriteString(renderTable(tableBuf))
			tableBuf = tableBuf[:0]
		}
	}

	for _, raw := range lines {
		line := strings.TrimRight(raw, " \t")
		trimmed := strings.TrimSpace(line)

		// 代码围栏 ``` / ~~~
		if strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			if inFence {
				flushTable()
				inFence = false
				b.WriteString(Dim("  \u2500\u2500\u2500")) // 收尾
				b.WriteString("\n")
			} else {
				flushTable()
				inFence = true
				lang := strings.TrimSpace(trimmed[3:])
				if lang != "" {
					b.WriteString(Dim("  \u256d\u2500 " + lang))
				} else {
					b.WriteString(Dim("  \u256d\u2500\u2500"))
				}
				b.WriteString("\n")
			}
			continue
		}
		if inFence {
			b.WriteString(Green("  \u2502 ") + paint(line, sGray) + "\n")
			continue
		}

		// 收集表格行（含 | 的行），其它内容先冲刷表格
		if isTableRow(trimmed) {
			tableBuf = append(tableBuf, trimmed)
			continue
		}
		flushTable()

		switch {
		case trimmed == "":
			b.WriteString("\n")
		case strings.HasPrefix(trimmed, "#"):
			if level, text, ok := parseHeading(trimmed); ok {
				b.WriteString(renderHeading(text, level))
				b.WriteString("\n")
			} else {
				b.WriteString(inline(line) + "\n")
			}
		case isHR(trimmed):
			b.WriteString(Dim(strings.Repeat("\u2500", 42)) + "\n")
		case strings.HasPrefix(trimmed, ">"):
			b.WriteString(Cyan("\u2502 ") + Dim(inline(strings.TrimSpace(strings.TrimPrefix(trimmed, ">")))) + "\n")
		case isListItem(trimmed):
			indent := leadingSpaces(line)
			marker, content := splitListItem(trimmed)
			b.WriteString(strings.Repeat(" ", indent) + Yellow(marker) + "  " + inline(content) + "\n")
		default:
			b.WriteString(inline(line) + "\n")
		}
	}
	// 结尾若仍在围栏里，补一个收尾
	if inFence {
		b.WriteString(Dim("  \u2500\u2500\u2500") + "\n")
	}
	flushTable()

	out := b.String()
	out = strings.TrimRight(out, "\n") + "\n"
	return out
}

// --- 块级辅助 ---

func parseHeading(s string) (level int, text string, ok bool) {
	for i := 0; i < len(s) && s[i] == '#'; i++ {
		level++
	}
	if level == 0 || level > 6 {
		return 0, "", false
	}
	rest := s[level:]
	if rest == "" {
		return level, "", true
	}
	if rest[0] != ' ' && rest[0] != '\t' {
		return 0, "", false
	}
	return level, strings.TrimSpace(rest), true
}

func renderHeading(text string, level int) string {
	t := inline(text)
	switch level {
	case 1:
		return Bold(Magenta(t)) + "\n"
	case 2:
		return Bold(Blue(t)) + "\n"
	case 3:
		return Bold(t) + "\n"
	default:
		return Bold(Dim(t)) + "\n"
	}
}

func isHR(s string) bool {
	s = strings.ReplaceAll(s, " ", "")
	if len(s) < 3 {
		return false
	}
	c := s[0]
	if c != '-' && c != '*' && c != '_' {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] != c {
			return false
		}
	}
	return true
}

func isListItem(s string) bool {
	if len(s) < 2 {
		return false
	}
	switch s[0] {
	case '-', '*':
		return s[1] == ' '
	}
	// 有序列表：数字. 或 数字)
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	if i > 0 && i < len(s) && (s[i] == '.' || s[i] == ')') && i+1 < len(s) && s[i+1] == ' ' {
		return true
	}
	return false
}

func splitListItem(s string) (marker, content string) {
	if s[0] == '-' || s[0] == '*' {
		return "\u2022", strings.TrimSpace(s[1:])
	}
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i+1], strings.TrimSpace(s[i+1:])
}

func leadingSpaces(s string) int {
	n := 0
	for n < len(s) && (s[n] == ' ' || s[n] == '\t') {
		n++
	}
	return n
}

// --- 表格 ---

func isTableRow(s string) bool {
	return strings.Contains(s, "|") && (strings.HasPrefix(s, "|") || strings.Count(s, "|") >= 2)
}

func isTableSep(s string) bool {
	t := strings.ReplaceAll(s, " ", "")
	if !strings.Contains(t, "-") {
		return false
	}
	for _, c := range t {
		if c != '|' && c != '-' && c != ':' {
			return false
		}
	}
	return true
}

func splitCells(s string) []string {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "|")
	s = strings.TrimSuffix(s, "|")
	parts := strings.Split(s, "|")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func renderTable(rows []string) string {
	// 拆出表头 / 分隔行 / 数据行
	var header []string
	var data [][]string
	aligns := []byte{}
	for _, r := range rows {
		if isTableSep(r) {
			for _, c := range splitCells(r) {
				var a byte = 'l'
				l := strings.HasPrefix(c, ":")
				rr := strings.HasSuffix(c, ":")
				switch {
				case l && rr:
					a = 'c'
				case rr:
					a = 'r'
				}
				aligns = append(aligns, a)
			}
			continue
		}
		if header == nil {
			header = splitCells(r)
		} else {
			data = append(data, splitCells(r))
		}
	}
	cols := len(header)
	for _, d := range data {
		if len(d) > cols {
			cols = len(d)
		}
	}
	if cols == 0 {
		return ""
	}
	// 用可见宽度（CJK 记 2）算列宽
	widths := make([]int, cols)
	cellWidth := func(s string) int { return displayWidth(stripANSI(s)) }
	for i := 0; i < cols; i++ {
		if i < len(header) {
			widths[i] = cellWidth(header[i])
		}
	}
	for _, d := range data {
		for i := 0; i < cols; i++ {
			if i < len(d) && cellWidth(d[i]) > widths[i] {
				widths[i] = cellWidth(d[i])
			}
		}
	}
	var b strings.Builder
	writeRow := func(cells []string, sty func(string) string) {
		b.WriteString("  ")
		for i := 0; i < cols; i++ {
			v := ""
			if i < len(cells) {
				v = cells[i]
			}
			cell := pad(v, widths[i], alignOf(aligns, i))
			if sty != nil {
				cell = sty(cell)
			}
			b.WriteString(cell)
			if i < cols-1 {
				b.WriteString(" \u2502 ")
			}
		}
		b.WriteString("\n")
	}
	// 表头 + 分隔
	writeRow(header, func(s string) string { return Bold(Cyan(s)) })
	b.WriteString("  ")
	for i := 0; i < cols; i++ {
		b.WriteString(Dim(strings.Repeat("\u2500", widths[i])))
		if i < cols-1 {
			b.WriteString("\u2500\u2534\u2500")
		}
	}
	b.WriteString("\n")
	for _, d := range data {
		writeRow(d, nil)
	}
	return b.String()
}

func alignOf(aligns []byte, i int) byte {
	if i < len(aligns) {
		return aligns[i]
	}
	return 'l'
}

func pad(s string, w int, align byte) string {
	dw := displayWidth(s)
	padN := w - dw
	if padN < 0 {
		padN = 0
	}
	switch align {
	case 'r':
		return strings.Repeat(" ", padN) + s
	case 'c':
		left := padN / 2
		return strings.Repeat(" ", left) + s + strings.Repeat(" ", padN-left)
	default:
		return s + strings.Repeat(" ", padN)
	}
}

// --- 行内解析 ---

func inline(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); {
		c := s[i]
		switch {
		case c == '\\' && i+1 < len(s) && isPunct(s[i+1]):
			r, sz := utf8.DecodeRuneInString(s[i+1:])
			b.WriteRune(r)
			i += 1 + sz
		case c == '`':
			if j := strings.IndexByte(s[i+1:], '`'); j >= 0 {
				b.WriteString(codeSpan(s[i+1 : i+1+j]))
				i += j + 2
				continue
			}
			b.WriteString(styleCode(c))
			i++
		case c == '*' || c == '_':
			if end, text, strong := matchEmph(s, i); end > i {
				if strong {
					b.WriteString(Bold(inline(text)))
				} else {
					b.WriteString(Italic(inline(text)))
				}
				i = end
				continue
			}
			b.WriteString(styleCode(c))
			i++
		case c == '[':
			if end, label, url := matchLink(s, i); end > i {
				b.WriteString(linkStyle(label, url))
				i = end
				continue
			}
			b.WriteString(styleCode(c))
			i++
		default:
			r, sz := utf8.DecodeRuneInString(s[i:])
			b.WriteRune(r)
			i += sz
		}
	}
	return b.String()
}

// matchEmph 从 s[start]（'*' 或 '_'）尝试匹配一段强调文本。
// 返回结束下标、内部文本、是否 strong。返回 end<=start 表示不构成强调。
func matchEmph(s string, start int) (end int, text string, strong bool) {
	delim := s[start]
	if start+1 < len(s) && s[start+1] == delim { // strong：** 或 __
		if close := closingDelim(s, start+2, delim, 2); close >= 0 {
			return close + 2, s[start+2 : close], true
		}
		return -1, "", false
	}
	if close := closingDelim(s, start+1, delim, 1); close >= 0 {
		return close + 1, s[start+1 : close], false
	}
	return -1, "", false
}

// closingDelim 在 s[from:] 找单个（或强匹配的）闭合分隔符，返回其起始下标。
// 闭合要求：delim 前一个字符非空白，且后一个字符非数字；并避开 CJK 标点粘连。
func closingDelim(s string, from int, delim byte, width int) int {
	for k := from; k+width <= len(s); k++ {
		if s[k] == delim {
			prev := s[k-1]
			if isSpaceByte(prev) {
				continue
			}
			// 单下划线强调基本不与中文标点冲突，星号需注意后面紧跟数字的情况
			if k+width < len(s) && s[k+width] >= '0' && s[k+width] <= '9' {
				continue
			}
			return k
		}
	}
	return -1
}

func matchLink(s string, start int) (end int, label, url string) {
	closeB := strings.IndexByte(s[start+1:], ']')
	if closeB < 0 {
		return -1, "", ""
	}
	labelEnd := start + 1 + closeB
	if labelEnd+1 >= len(s) || s[labelEnd+1] != '(' {
		return -1, "", ""
	}
	closeP := strings.IndexByte(s[labelEnd+2:], ')')
	if closeP < 0 {
		return -1, "", ""
	}
	urlEnd := labelEnd + 2 + closeP
	return urlEnd + 1, s[start+1 : labelEnd], s[labelEnd+2 : urlEnd]
}

func linkStyle(label, url string) string {
	if label == "" {
		label = url
	}
	text := Underline(Cyan(label))
	if url != "" && url != label {
		return text + Dim(" ("+url+")")
	}
	return text
}

func codeSpan(s string) string {
	if Enabled() {
		return "\x1b[48;5;236m" + Yellow(s) + sReset
	}
	return s
}

func isSpaceByte(c byte) bool {
	return c == ' ' || c == '\t' || c == '\n' || c == '\r'
}

func isPunct(c byte) bool {
	return c != 0 && !('a' <= c && c <= 'z') && !('A' <= c && c <= 'Z') && !(c >= '0' && c <= '9')
}

// --- 宽度 / 工具 ---

// displayWidth 估算终端列宽：全角/CJK/emoji 记 2，其它记 1。
func displayWidth(s string) int {
	w := 0
	for _, r := range s {
		if r < 0x20 {
			continue
		}
		if isWide(r) {
			w += 2
		} else {
			w++
		}
	}
	return w
}

func isWide(r rune) bool {
	switch {
	case r >= 0x1100 && r <= 0x115F, // 韩文字母
		r >= 0x2E80 && r <= 0xA4CF,   // CJK 部首、假名、汉字等
		r >= 0xAC00 && r <= 0xD7A3,   // 韩文音节
		r >= 0xF900 && r <= 0xFAFF,   // CJK 兼容汉字
		r >= 0xFE30 && r <= 0xFE6F,   // CJK 兼容标点
		r >= 0xFF00 && r <= 0xFF60,   // 全角标点
		r >= 0xFFE0 && r <= 0xFFE6,   // 全角符号
		r >= 0x1F300 && r <= 0x1FAFF, // emoji
		r >= 0x20000 && r <= 0x3FFFD:
		return true
	}
	return unicode.Is(unicode.Han, r)
}

// stripANSI 去掉 ANSI 转义，用于按可见文本计算列宽。
func stripANSI(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); {
		if s[i] == 0x1b && i+1 < len(s) && s[i+1] == '[' {
			j := i + 2
			for j < len(s) && (s[j] == ';' || (s[j] >= '0' && s[j] <= '9')) {
				j++
			}
			if j < len(s) {
				j++ // 结尾字母
			}
			i = j
			continue
		}
		b.WriteByte(s[i])
		i++
	}
	return b.String()
}

// styleCode 返回字符本身（占位函数，集中处理以便将来扩展逐字样式）。
func styleCode(c byte) string { return string(c) }
