package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

type Config struct {
	URL       string `json:"url"`
	Key       string `json:"key"`
	Model     string `json:"model"`
	CompactAt int    `json:"compact_at"`
	Keep      int    `json:"keep"`
	Timeout   int    `json:"timeout"`
	MaxOutput int    `json:"max_output"`
	System    string `json:"system"`
}

type Paths struct {
	ConfigDir string
	DataDir   string
	Config    string
}

func Default() Config {
	return Config{URL: "https://api.openai.com/v1/responses", Model: "gpt-4o-mini", CompactAt: 60000, Keep: 20, Timeout: 120, MaxOutput: 30000}
}

func DefaultPaths() (Paths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return Paths{}, err
	}
	var configDir, dataDir string
	switch runtime.GOOS {
	case "windows":
		configDir = filepath.Join(firstEnv("APPDATA", home), "agentic")
		dataDir = filepath.Join(firstEnv("LOCALAPPDATA", home), "agentic")
	case "darwin":
		configDir = filepath.Join(home, "Library", "Application Support", "agentic")
		dataDir = configDir
	default:
		configDir = filepath.Join(firstEnv("XDG_CONFIG_HOME", filepath.Join(home, ".config")), "agentic")
		dataDir = filepath.Join(firstEnv("XDG_DATA_HOME", filepath.Join(home, ".local", "share")), "agentic")
	}
	if v := os.Getenv("AGENT_CONFIG_DIR"); v != "" {
		configDir = v
	}
	if v := os.Getenv("AGENT_DATA_DIR"); v != "" {
		dataDir = v
	}
	return Paths{ConfigDir: configDir, DataDir: dataDir, Config: filepath.Join(configDir, "config.json")}, nil
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
	case "url":
		c.URL = value
	case "key":
		c.Key = value
	case "model":
		c.Model = value
	case "system":
		c.System = value
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
func firstEnv(k, fallback string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return fallback
}
func applyEnv(c *Config) {
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
