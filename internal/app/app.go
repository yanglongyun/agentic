package app

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/api"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
	"github.com/yanglongyun/agentic/internal/ui"
)

func Run(args []string, version string) error {
	p, err := config.DefaultPaths()
	if err != nil {
		return err
	}
	c, err := config.Load(p)
	if err != nil {
		return err
	}
	h, err := history.Open(p.DataDir)
	if err != nil {
		return err
	}
	a := &agent.Agent{Config: c, API: &api.Client{URL: c.URL, Key: c.Key, Model: c.Model}, History: h, Tools: tools.New(c.Timeout, c.MaxOutput)}
	if len(args) > 0 {
		switch args[0] {
		case "help", "-h", "--help":
			usage(version, p)
			return nil
		case "version", "-v", "--version":
			fmt.Println("agent", version)
			return nil
		case "config":
			return configCommand(args[1:], p, &c)
		case "reset":
			if err := h.Reset(); err != nil {
				return err
			}
			fmt.Println("对话已清空，归档仍保留在", h.Archive)
			return nil
		case "history":
			return printHistory(h)
		case "compact":
			if err := c.Validate(); err != nil {
				return err
			}
			return a.Compact(context.Background())
		case "-p":
			if len(args) < 2 {
				return fmt.Errorf("用法：agent -p \"你的问题\"")
			}
			return one(a, strings.Join(args[1:], " "))
		default:
			return one(a, strings.Join(args, " "))
		}
	}
	if stat, _ := os.Stdin.Stat(); stat.Mode()&os.ModeCharDevice == 0 {
		b, e := io.ReadAll(os.Stdin)
		if e != nil {
			return e
		}
		if s := strings.TrimSpace(string(b)); s != "" {
			return one(a, s)
		}
	}
	if err := c.Validate(); err != nil {
		return err
	}
	return repl(a, version)
}

func one(a *agent.Agent, text string) error {
	if err := a.Config.Validate(); err != nil {
		return err
	}
	out, err := a.Turn(context.Background(), text)
	if out != "" {
		fmt.Print(ui.Markdown(out))
	}
	return err
}

func repl(a *agent.Agent, version string) error {
	fmt.Fprint(os.Stdout, ui.Banner(version, a.Config.Model))
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for {
		fmt.Print(ui.Prompt("你 › "))
		if !in.Scan() {
			fmt.Println()
			return in.Err()
		}
		s := strings.TrimSpace(in.Text())
		switch s {
		case "":
			continue
		case "/exit", "/quit":
			fmt.Println(ui.Dim("再见。"))
			return nil
		case "/help":
			fmt.Print(ui.Help())
			continue
		case "/status":
			printStatus(a)
			continue
		case "/reset":
			if e := a.History.Reset(); e != nil {
				printErr(e)
				continue
			}
			fmt.Println(ui.Green("✓ ") + "对话已清空")
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
			fmt.Println(ui.Green("✓ ") + "已压缩上下文")
			continue
		}
		started := time.Now()
		out, e := a.Turn(context.Background(), s)
		if out != "" {
			fmt.Print(ui.LabelAssistant("\n助理 › ") + "\n" + ui.Markdown(out))
		}
		if e != nil {
			printErr(e)
			continue
		}
		fmt.Print(ui.Footer(time.Since(started), a.History.Tokens(), a.Config.CompactAt))
	}
}

func printStatus(a *agent.Agent) {
	pwd, _ := os.Getwd()
	fmt.Print(ui.StatusLine(a.Config.Model, a.Config.URL, pwd, a.History.Tokens(), a.Config.CompactAt))
}

func printErr(e error) {
	fmt.Fprintln(os.Stderr, ui.Red("错误：")+fmt.Sprint(e))
}
func configCommand(args []string, p config.Paths, c *config.Config) error {
	if len(args) == 0 {
		return config.Wizard(p, c)
	}
	switch args[0] {
	case "show":
		fmt.Printf("配置文件  %s\n数据目录  %s\nurl       %s\nkey       %s\nmodel     %s\ncompact-at %d\nkeep      %d\ntimeout   %d\nmax-output %d\n", p.Config, p.DataDir, c.URL, config.MaskedKey(c.Key), c.Model, c.CompactAt, c.Keep, c.Timeout, c.MaxOutput)
		return nil
	case "set":
		if len(args) < 3 {
			return fmt.Errorf("用法：agent config set <项> <值>")
		}
		if err := config.Set(c, args[1], strings.Join(args[2:], " ")); err != nil {
			return err
		}
		return config.Save(p, *c)
	default:
		return fmt.Errorf("用法：agent config [show|set <项> <值>]")
	}
}
func printHistory(h *history.Store) error {
	items, err := h.Items()
	if err != nil {
		return err
	}
	if len(items) == 0 {
		fmt.Println("（对话为空）")
		return nil
	}
	for _, v := range items {
		if v["type"] != "message" {
			continue
		}
		role, _ := v["role"].(string)
		tag := "助理"
		if role == "user" {
			tag = "你"
		}
		if v["_kind"] == "compaction" {
			tag = "摘要"
		}
		fmt.Printf("%s: %s\n", tag, messageText(v))
	}
	return nil
}

func messageText(v map[string]any) string {
	content, _ := v["content"].([]any)
	var parts []string
	for _, item := range content {
		m, _ := item.(map[string]any)
		if text, ok := m["text"].(string); ok {
			parts = append(parts, text)
		}
		if m["type"] == "input_image" {
			parts = append(parts, "[图片]")
		}
	}
	return strings.Join(parts, "\n")
}
func usage(v string, p config.Paths) {
	fmt.Printf(`agent %s —— 跨平台终端 AI agent

用法：
  agent                      进入对话
  agent "检查当前目录"       单次提问
  agent config              配置 API
  agent config show
  agent config set <项> <值>
  agent history | compact | reset | version

工具：shell · read · write · edit
配置：%s
数据：%s
`, v, p.Config, p.DataDir)
}
