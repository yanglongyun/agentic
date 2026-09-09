package config

import (
	"bufio"
	"crypto/rand"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type APIConfig struct {
	Listen      string `json:"listen"`
	Token       string `json:"token"`
	Concurrency int    `json:"concurrency"`
	MaxTasks    int    `json:"max_tasks"`
	MaxDepth    int    `json:"max_depth"`
	TaskTimeout int    `json:"task_timeout"` // seconds
}

type Config struct {
	ResumeMessages int       `json:"resume_messages"`
	API            APIConfig `json:"api"`
	URL            string    `json:"url"`
	Key            string    `json:"key"`
	Model          string    `json:"model"`
	CompactAt      int       `json:"compact_at"`
	Keep           int       `json:"keep"`
	Timeout        int       `json:"timeout"`
	MaxOutput      int       `json:"max_output"`
	System         string    `json:"system"`
	CompactSystem  string    `json:"compact_system"`
	CompactPrefix  string    `json:"compact_prefix"`
}

type Paths struct {
	ConfigDir string
	DataDir   string
	Config    string
}

//go:embed defaults.json
var defaultsJSON []byte

func Default() Config {
	var c Config
	if err := json.Unmarshal(defaultsJSON, &c); err != nil {
		panic(err)
	}
	return c
}

func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	configDir, _ := platformDirs(runtime.GOOS, home, os.Getenv)
	if v := os.Getenv("AGENT_CONFIG_DIR"); v != "" {
		configDir = v
	}
	root := configDir
	if v := os.Getenv("AGENT_DATA_DIR"); v != "" {
		root = v
	}
	if v := os.Getenv("AGENT_HOME"); v != "" {
		root = v
	}
	return Paths{ConfigDir: root, DataDir: root, Config: filepath.Join(root, "config.json")}, nil
}

func platformDirs(goos, home string, getenv func(string) string) (string, string) {
	first := func(k, fallback string) string {
		if v := getenv(k); v != "" {
			return v
		}
		return fallback
	}
	switch goos {
	case "windows":
		return filepath.Join(first("APPDATA", home), "agentic"), filepath.Join(first("LOCALAPPDATA", home), "agentic")
	case "darwin":
		base := filepath.Join(home, "Library", "Application Support", "agentic")
		return base, filepath.Join(base, "data")
	default:
		return filepath.Join(first("XDG_CONFIG_HOME", filepath.Join(home, ".config")), "agentic"), filepath.Join(first("XDG_DATA_HOME", filepath.Join(home, ".local", "share")), "agentic")
	}
}

func Load(p Paths) (Config, error) {
	c := Default()
	b, err := os.ReadFile(p.Config)
	if err == nil {
		if err := json.Unmarshal(b, &c); err != nil {
			return c, fmt.Errorf("配置文件格式错误：%w", err)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return c, err
	}
	if errors.Is(err, os.ErrNotExist) || c.API.Token == "" {
		if c.API.Token == "" {
			var token [32]byte
			if _, err := rand.Read(token[:]); err != nil {
				return c, err
			}
			c.API.Token = hex.EncodeToString(token[:])
		}
		if err := Save(p, c); err != nil {
			return c, err
		}
	}
	applyEnv(&c)
	return c, nil
}

func Save(p Paths, c Config) error {
	if err := os.MkdirAll(p.ConfigDir, 0700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	tmp := p.Config + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0600); err != nil {
		return err
	}
	if err := os.Chmod(tmp, 0600); err != nil && runtime.GOOS != "windows" {
		return err
	}
	return os.Rename(tmp, p.Config)
}

func Set(c *Config, key, value string) error {
	intValue := func() (int, error) {
		n, err := strconv.Atoi(value)
		if err != nil || n <= 0 {
			return 0, fmt.Errorf("%s 必须是正整数", key)
		}
		return n, nil
	}
	switch key {
	case "resume-messages":
		n, err := intValue()
		if err != nil {
			return err
		}
		if n > 200 {
			return errors.New("resume-messages 不能超过 200")
		}
		c.ResumeMessages = n
	case "api-listen":
		c.API.Listen = value
	case "api-token":
		if len(value) < 16 {
			return errors.New("API 令牌至少需要 16 个字符")
		}
		c.API.Token = value
	case "api-concurrency", "api-max-tasks", "api-task-timeout":
		n, err := intValue()
		if err != nil {
			return err
		}
		switch key {
		case "api-concurrency":
			c.API.Concurrency = n
		case "api-max-tasks":
			c.API.MaxTasks = n
		case "api-task-timeout":
			c.API.TaskTimeout = n
		}
	case "api-max-depth":
		n, err := strconv.Atoi(value)
		if err != nil || n < 0 {
			return errors.New("api-max-depth 必须是非负整数")
		}
		c.API.MaxDepth = n
	case "url":
		c.URL = value
	case "key":
		c.Key = value
	case "model":
		c.Model = value
	case "system":
		c.System = value
	case "compact-system":
		c.CompactSystem = value
	case "compact-prefix":
		c.CompactPrefix = value
	case "compact-at":
		n, e := intValue()
		if e != nil {
			return e
		}
		c.CompactAt = n
	case "keep":
		n, e := intValue()
		if e != nil {
			return e
		}
		c.Keep = n
	case "timeout":
		n, e := intValue()
		if e != nil {
			return e
		}
		c.Timeout = n
	case "max-output":
		n, e := intValue()
		if e != nil {
			return e
		}
		c.MaxOutput = n
	default:
		return fmt.Errorf("未知配置项 %q", key)
	}
	return nil
}

func Wizard(p Paths, c *Config) error {
	in := bufio.NewReader(os.Stdin)
	fields := []struct {
		label string
		value *string
	}{{"API 地址", &c.URL}, {"API Key", &c.Key}, {"模型", &c.Model}}
	for _, f := range fields {
		shown := *f.value
		if f.label == "API Key" && shown != "" {
			shown = mask(shown)
		}
		fmt.Printf("%s [%s]: ", f.label, shown)
		s, err := in.ReadString('\n')
		if err != nil && len(s) == 0 {
			return err
		}
		if s = strings.TrimSpace(s); s != "" {
			*f.value = s
		}
	}
	return Save(p, *c)
}

func (c Config) Validate() error {
	if c.Key == "" {
		return errors.New("还没配置 API Key，先运行：agent config")
	}
	if c.URL == "" || c.Model == "" {
		return errors.New("API URL 和模型不能为空")
	}
	return nil
}

func MaskedKey(k string) string { return mask(k) }
func mask(k string) string {
	if len(k) <= 10 {
		return "***"
	}
	return k[:6] + "..." + k[len(k)-4:]
}
func applyEnv(c *Config) {
	if v := os.Getenv("AGENT_SERVER_TOKEN"); v != "" {
		c.API.Token = v
	}
	if v := os.Getenv("AGENT_LISTEN"); v != "" {
		c.API.Listen = v
	}
	if v := os.Getenv("AGENT_URL"); v != "" {
		c.URL = v
	}
	if v := os.Getenv("AGENT_KEY"); v != "" {
		c.Key = v
	}
	if v := os.Getenv("AGENT_MODEL"); v != "" {
		c.Model = v
	}
	if v := os.Getenv("AGENT_SYSTEM"); v != "" {
		c.System = v
	}
}
