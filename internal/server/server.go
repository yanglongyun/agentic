package server

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/task"
)

type Options struct {
	Token                           string
	Concurrency, MaxTasks, MaxDepth int
	Timeout                         time.Duration
}
type Server struct {
	tasks *task.Manager
	token string
}

func New(c config.Config, dir string, o Options) (*Server, error) {
	if len(o.Token) < 16 {
		return nil, errors.New("AGENT_SERVER_TOKEN 至少需要 16 个字符")
	}
	manager, err := task.New(c, dir, task.Options{Concurrency: o.Concurrency, MaxTasks: o.MaxTasks, MaxDepth: o.MaxDepth, Timeout: o.Timeout})
	if err != nil {
		return nil, err
	}
	return &Server{tasks: manager, token: o.Token}, nil
}
func (s *Server) Close() { s.tasks.Close() }
func Run(args []string, c config.Config, dir string) error {
	fs := flag.NewFlagSet("agent serve", flag.ContinueOnError)
	addr := fs.String("listen", "127.0.0.1:9528", "HTTP 监听地址")
	o := Options{Token: os.Getenv("AGENT_SERVER_TOKEN")}
	fs.IntVar(&o.Concurrency, "concurrency", 4, "最大并行执行数")
	fs.IntVar(&o.MaxTasks, "max-tasks", 256, "内存任务记录和排队容量")
	fs.IntVar(&o.MaxDepth, "max-depth", 2, "最大子任务层级，0 禁用")
	fs.DurationVar(&o.Timeout, "task-timeout", 10*time.Minute, "任务超时（包含排队时间）")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	if fs.NArg() != 0 {
		return errors.New("serve 不接受位置参数")
	}
	if err := c.Validate(); err != nil {
		return err
	}
	s, err := New(c, dir, o)
	if err != nil {
		return err
	}
	defer s.Close()
	srv := &http.Server{Addr: *addr, Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		s.Close()
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	fmt.Fprintf(os.Stderr, "agent API 监听 %s（工作目录为启动目录）\n", *addr)
	err = srv.ListenAndServe()
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
