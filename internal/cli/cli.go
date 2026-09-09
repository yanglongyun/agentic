package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/yanglongyun/agentic/internal/agent"
	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/cli/render"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
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
		case "resume":
			if len(args) != 1 {
				return fmt.Errorf("%s 不接受额外参数", args[0])
			}
		default:
			return fmt.Errorf("未知命令 %q；运行 agent 开启新会话，agent help 查看命令", args[0])
		}
	}
	stat, err := os.Stdin.Stat()
	if err != nil {
		return err
	}
	if stat.Mode()&os.ModeCharDevice == 0 {
		return fmt.Errorf("请在终端运行 agent")
	}
	if err = c.Validate(); err != nil {
		return err
	}
	a := &agent.Agent{Config: c, API: &ai.Client{URL: c.URL, Key: c.Key, Model: c.Model}, Tools: tools.New(c.Timeout, c.MaxOutput), Emit: render.AgentEvent}
	return repl(a, p.DataDir, version, len(args) > 0)
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
	fmt.Printf(`agent %s

用法：
  agent                     开启新会话，同时启动 HTTP API
  agent config              配置 API
  agent config show         查看配置
  agent config set <项> <值> 修改配置
  agent resume              继续历史会话
  agent version             查看版本
  agent help                查看命令

工具：shell · read · write · edit · agent
配置：%s
数据：%s
`, v, p.Config, p.DataDir)
}
