package cli

import (
	"encoding/binary"
	"os"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

func terminalKeyboard() (func() ([]byte, error), func(), error) {
	h := windows.Handle(os.Stdin.Fd())
	var saved uint32
	if err := windows.GetConsoleMode(h, &saved); err != nil {
		return nil, nil, err
	}
	if err := windows.SetConsoleMode(h, saved&^(windows.ENABLE_LINE_INPUT|windows.ENABLE_ECHO_INPUT|windows.ENABLE_PROCESSED_INPUT)); err != nil {
		return nil, nil, err
	}
	read := windows.NewLazySystemDLL("kernel32.dll").NewProc("ReadConsoleInputW")
	var high uint16
	poll := func() ([]byte, error) {
		result, err := windows.WaitForSingleObject(h, 50)
		if err != nil {
			return nil, err
		}
		if result == uint32(windows.WAIT_TIMEOUT) {
			return nil, nil
		}
		var record struct {
			Kind uint16
			Pad  uint16
			Data [16]byte
		}
		var n uint32
		ok, _, e := read.Call(uintptr(h), uintptr(unsafe.Pointer(&record)), 1, uintptr(unsafe.Pointer(&n)))
		if ok == 0 {
			return nil, e
		}
		if n == 0 || record.Kind != 1 || binary.LittleEndian.Uint32(record.Data[:4]) == 0 {
			return nil, nil
		}
		c := binary.LittleEndian.Uint16(record.Data[10:12])
		if c == 0 {
			return nil, nil
		}
		if c >= 0xD800 && c <= 0xDBFF {
			high = c
			return nil, nil
		}
		r := rune(c)
		if high != 0 {
			r = utf16.DecodeRune(rune(high), r)
			high = 0
		}
		if r == '\r' {
			r = '\n'
		}
		return []byte(string(r)), nil
	}
	return poll, func() { _ = windows.SetConsoleMode(h, saved) }, nil
}

func terminalColumns() int {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(os.Stdout.Fd()), &info); err == nil {
		return int(info.Window.Right-info.Window.Left) + 1
	}
	return 80
}
