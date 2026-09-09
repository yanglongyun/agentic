package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"sync"
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
		return nil, errors.New("API 令牌至少需要 16 个字符（config.json 中 api.token 或 AGENT_SERVER_TOKEN）")
	}
	manager, err := task.New(c, dir, task.Options{Concurrency: o.Concurrency, MaxTasks: o.MaxTasks, MaxDepth: o.MaxDepth, Timeout: o.Timeout})
	if err != nil {
		return nil, err
	}
	return &Server{tasks: manager, token: o.Token}, nil
}
func (s *Server) Close() { s.tasks.Close() }

// Runtime owns the listener and API tasks for one interactive process.
type Runtime struct {
	*Server
	URL  string
	http *http.Server
	done chan struct{}
	err  error
	once sync.Once
}

func Start(c config.Config, dir string) (*Runtime, error) {
	if err := c.Validate(); err != nil {
		return nil, err
	}
	if c.API.Listen == "" {
		return nil, errors.New("api.listen 不能为空")
	}
	s, err := New(c, dir, Options{Token: c.API.Token, Concurrency: c.API.Concurrency, MaxTasks: c.API.MaxTasks, MaxDepth: c.API.MaxDepth, Timeout: time.Duration(c.API.TaskTimeout) * time.Second})
	if err != nil {
		return nil, err
	}
	listener, err := net.Listen("tcp", c.API.Listen)
	if err != nil {
		s.Close()
		return nil, fmt.Errorf("API 无法监听 %s：%w；可通过 agent config set api-listen 修改地址", c.API.Listen, err)
	}
	r := &Runtime{Server: s, URL: "http://" + listener.Addr().String(), done: make(chan struct{})}
	r.http = &http.Server{Handler: s, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 * 1024}
	go func() {
		defer close(r.done)
		r.err = r.http.Serve(listener)
		if errors.Is(r.err, http.ErrServerClosed) {
			r.err = nil
		}
	}()
	return r, nil
}
func (r *Runtime) Done() <-chan struct{} { return r.done }
func (r *Runtime) Err() error            { <-r.done; return r.err }
func (r *Runtime) Close() {
	r.once.Do(func() {
		r.Server.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := r.http.Shutdown(ctx); err != nil {
			_ = r.http.Close()
		}
		<-r.done
	})
}
func (s *Server) ReserveSession(id string) (func(), error) { return s.tasks.ReserveSession(id) }

func (s *Server) Agents() *task.Manager { return s.tasks }
