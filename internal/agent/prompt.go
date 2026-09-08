package agent

import (
	"os"
	"os/user"
	"runtime"
	"strings"
	"time"
)

// renderPrompt expands runtime variables only; prompt text comes from config.
func renderPrompt(template string) string {
	host, _ := os.Hostname()
	who := "unknown"
	if u, err := user.Current(); err == nil {
		who = u.Username
	}
	wd, _ := os.Getwd()
	return strings.NewReplacer("{{os}}", runtime.GOOS, "{{arch}}", runtime.GOARCH, "{{host}}", host, "{{user}}", who, "{{workdir}}", wd, "{{time}}", time.Now().Format(time.RFC3339)).Replace(template)
}
