package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

func (s *Set) shell(parent context.Context, a map[string]any) Result {
	command, _ := a["command"].(string)
	if command == "" {
		return Result{Text: "错误：缺少 command 参数"}
	}
	ctx, cancel := context.WithTimeout(parent, s.Timeout)
	defer cancel()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		exe := "powershell.exe"
		if _, e := exec.LookPath("pwsh"); e == nil {
			exe = "pwsh"
		}
		cmd = exec.CommandContext(ctx, exe, "-NoProfile", "-NonInteractive", "-Command", command)
	} else {
		exe := "/bin/sh"
		if _, e := os.Stat("/bin/bash"); e == nil {
			exe = "/bin/bash"
		}
		cmd = exec.CommandContext(ctx, exe, "-c", command)
	}
	configureCancellation(cmd)
	if wd, _ := a["workdir"].(string); wd != "" {
		cmd.Dir = wd
	}
	var out limitedBuffer
	out.max = s.MaxOutput
	cmd.Stdout = &out
	cmd.Stderr = &out
	err := cmd.Run()
	code := 0
	if err != nil {
		code = -1
		if e, ok := err.(*exec.ExitError); ok {
			code = e.ExitCode()
		}
	}
	text := out.String()
	if text == "" {
		text = "(无输出)"
	}
	if ctx.Err() == context.DeadlineExceeded {
		text += fmt.Sprintf("\n[超时：命令超过 %s 被终止]", s.Timeout)
	}
	return Result{Text: fmt.Sprintf("%s\n\n[退出码 %d]", text, code)}
}
