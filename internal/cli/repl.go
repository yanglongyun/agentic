package cli

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/cli/render"
)

func repl(a *agent.Agent, version string) error {
	fmt.Fprint(os.Stdout, render.Banner(version, a.Config.Model))
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for {
		fmt.Print(render.Prompt("你 › "))
		if !in.Scan() {
			fmt.Println()
			return in.Err()
		}
		s := strings.TrimSpace(in.Text())
		switch s {
		case "":
			continue
		case "/exit", "/quit":
			fmt.Println(render.Dim("再见。"))
			return nil
		case "/help":
			fmt.Print(render.Help())
			continue
		case "/status":
			printStatus(a)
			continue
		case "/history":
			if e := printHistory(a.History); e != nil {
				printErr(e)
			}
			continue
		case "/compact":
			if e := a.Compact(context.Background()); e != nil {
				printErr(e)
				continue
			}
			fmt.Println(render.Green("✓ ") + "已压缩上下文")
			continue
		}
		if s == "/reset" {
			printErr(fmt.Errorf("该命令已取消，请退出后运行 agent 开启新会话"))
			continue
		}
		started := time.Now()
		out, e := a.Turn(context.Background(), s)
		if out != "" {
			fmt.Print(render.LabelAssistant("\n助理 › ") + "\n" + render.Markdown(out))
		}
		if e != nil {
			printErr(e)
			continue
		}
		fmt.Print(render.Footer(time.Since(started), a.History.Tokens(), a.Config.CompactAt))
	}
}

func printStatus(a *agent.Agent) {
	pwd, _ := os.Getwd()
	fmt.Print(render.StatusLine(a.Config.Model, a.Config.URL, pwd, a.History.Tokens(), a.Config.CompactAt))
}

func printErr(e error) {
	fmt.Fprintln(os.Stderr, render.Red("错误：")+fmt.Sprint(e))
}
