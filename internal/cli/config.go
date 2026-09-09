package cli

import (
	"fmt"
	"strings"

	"github.com/yanglongyun/agentic/internal/config"
)

func configCommand(args []string, p config.Paths, c *config.Config) error {
	if len(args) == 0 {
		return config.Wizard(p, c)
	}
	switch args[0] {
	case "show":
		fmt.Printf("resume-messages %d\n", c.ResumeMessages)
		fmt.Printf("api-listen %s\napi-token %s\napi-concurrency %d\napi-max-tasks %d\napi-max-depth %d\napi-task-timeout %d 秒\n", c.API.Listen, config.MaskedKey(c.API.Token), c.API.Concurrency, c.API.MaxTasks, c.API.MaxDepth, c.API.TaskTimeout)
		fmt.Printf("配置文件  %s\n数据目录  %s\nurl       %s\nkey       %s\nmodel     %s\ncompact-at %d\nkeep      %d\ntimeout   %d\nmax-output %d\n", p.Config, p.DataDir, c.URL, config.MaskedKey(c.Key), c.Model, c.CompactAt, c.Keep, c.Timeout, c.MaxOutput)
		fmt.Printf("agent-result-prefix\n%s\n", c.AgentResultPrefix)
		fmt.Printf("system\n%s\ncompact-system\n%s\ncompact-prefix\n%s\n", c.System, c.CompactSystem, c.CompactPrefix)
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
