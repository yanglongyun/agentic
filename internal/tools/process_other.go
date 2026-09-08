//go:build !linux && !darwin

package tools

import (
	"os/exec"
	"time"
)

func configureCancellation(cmd *exec.Cmd) { cmd.WaitDelay = time.Second }
