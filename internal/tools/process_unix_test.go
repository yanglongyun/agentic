//go:build linux || darwin

package tools

import (
	"context"
	"testing"
	"time"
)

func TestShellCancellationStopsProcessGroup(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	New(30, 1000).Run(ctx, "shell", `{"command":"sleep 30 & wait"}`)
	if time.Since(started) > 3*time.Second {
		t.Fatal("shell descendants kept the command alive")
	}
}
