//go:build linux || darwin

package cli

import (
	"os"

	"golang.org/x/sys/unix"
)

func terminalKeyboard() (func() ([]byte, error), func(), error) {
	fd := int(os.Stdin.Fd())
	saved, err := unix.IoctlGetTermios(fd, termGet)
	if err != nil {
		return nil, nil, err
	}
	mode := *saved
	// Keep output processing enabled so existing terminal rendering retains CR/LF behavior.
	mode.Lflag &^= unix.ICANON | unix.ECHO | unix.ISIG | unix.IEXTEN
	mode.Iflag &^= unix.IXON
	mode.Cc[unix.VMIN] = 1
	mode.Cc[unix.VTIME] = 0
	if err = unix.IoctlSetTermios(fd, termSet, &mode); err != nil {
		return nil, nil, err
	}
	restore := func() { _ = unix.IoctlSetTermios(fd, termSet, saved) }
	poll := func() ([]byte, error) {
		fds := []unix.PollFd{{Fd: int32(fd), Events: unix.POLLIN}}
		n, err := unix.Poll(fds, 50)
		if err == unix.EINTR {
			return nil, nil
		}
		if err != nil || n == 0 {
			return nil, err
		}
		b := make([]byte, 256)
		n, err = unix.Read(fd, b)
		if err != nil {
			return nil, err
		}
		if n == 0 {
			return nil, errKeyboardClosed
		}
		return b[:n], nil
	}
	return poll, restore, nil
}

func terminalColumns() int {
	size, err := unix.IoctlGetWinsize(int(os.Stdout.Fd()), unix.TIOCGWINSZ)
	if err == nil && size.Col > 0 {
		return int(size.Col)
	}
	return 80
}
