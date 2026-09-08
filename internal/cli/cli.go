package cli

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/cli/render"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/server"
	"github.com/yanglongyun/agentic/internal/storage"
	"github.com/yanglongyun/agentic/internal/tools"
)

func Run(args []string, version string) error {
	p, err := config.DefaultPaths()
	if err != nil {
		return err
	}
	if err := storage.Prepare(p.DataDir); err != nil {
		return err
	}
	c, err := config.Load(p)
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "serve" {
		return server.Run(args[1:], c, p.DataDir)
	}
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
		case "history", "compact":
			if len(args) != 1 {
				return fmt.Errorf("%s 不接受额外参数", args[0])
			}
		default:
			return fmt.Errorf("未知命令 %q；运行 agent 开启新会话，agent help 查看命令", args[0])
		}
	}
	var h *history.Store
	if len(args) == 0 {
		stat, e := os.Stdin.Stat()
		if e != nil {
			return e
		}
		if stat.Mode()&os.ModeCharDevice == 0 {
			return fmt.Errorf("不支持管道或文件提问，请在终端运行 agent 开启新会话")
		}
		if err = c.Validate(); err != nil {
			return err
		}
		h, err = newSession(p.DataDir)
	} else {
		state, e := storage.LoadState(p.DataDir)
		if e != nil {
			return e
		}
		dir, e := storage.SessionDir(p.DataDir, state.CurrentSession)
		if e != nil {
			return e
		}
		if _, e = os.Stat(dir); os.IsNotExist(e) {
			return fmt.Errorf("还没有 CLI 会话，请运行 agent")
		} else if e != nil {
			return e
		}
		h, err = history.Open(dir)
	}
	if err != nil {
		return err
	}
	a := &agent.Agent{Config: c, API: &ai.Client{URL: c.URL, Key: c.Key, Model: c.Model}, History: h, Tools: tools.New(c.Timeout, c.MaxOutput), Emit: render.AgentEvent}
	if len(args) > 0 {
		if args[0] == "history" {
			return printHistory(h)
		}
		if err = c.Validate(); err != nil {
			return err
		}
		return a.Compact(context.Background())
	}
	return repl(a, version)
}

func newSession(root string) (*history.Store, error) {
	dir, err := os.MkdirTemp(filepath.Join(root, "sessions"), "cli-")
	if err != nil {
		return nil, err
	}
	h, err := history.Open(dir)
	if err != nil {
		return nil, err
	}
	if err = storage.WriteJSON(filepath.Join(root, "state.json"), storage.State{CurrentSession: filepath.Base(dir)}); err != nil {
		return nil, err
	}
	return h, nil
}

func usage(v string, p config.Paths) {
	fmt.Printf(`agent %s —— 跨平台终端 AI agent

用法：
  agent                      开启新会话
  agent serve               启动 HTTP API（agent serve -h 查看参数）
  agent config              配置 API
  agent config show
  agent config set <项> <值>
  agent history | compact | version

工具：shell · read · write · edit
配置：%s
数据：%s
`, v, p.Config, p.DataDir)
}
