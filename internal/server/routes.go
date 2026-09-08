package server

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/yanglongyun/agentic/internal/task"
)

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
func failure(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}
func (s *Server) writeTask(w http.ResponseWriter, code int, t *task.Task) {
	b, _ := json.Marshal(s.tasks.Snapshot(t))
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_, _ = w.Write(b)
}
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !s.authorized(r) {
		failure(w, 401, errors.New("需要 Bearer token"))
		return
	}

	if r.URL.Path == "/healthz" && r.Method == "GET" {
		writeJSON(w, 200, map[string]string{"status": "ok"})
		return
	}
	if r.URL.Path == "/v1/tasks" && r.Method == "POST" {
		var req task.Request
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 160*1024))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			failure(w, 400, err)
			return
		}
		if err := dec.Decode(new(any)); err != io.EOF {
			failure(w, 400, errors.New("请求必须是单个 JSON 对象"))
			return
		}
		t, err := s.tasks.Submit(req)
		if err != nil {
			failure(w, taskStatus(err), err)
			return
		}
		s.writeTask(w, 202, t)
		return
	}
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || len(parts) > 4 || parts[0] != "v1" || parts[1] != "tasks" {
		failure(w, 404, errors.New("接口不存在"))
		return
	}
	t := s.tasks.Get(parts[2])
	if t == nil {
		failure(w, 404, errors.New("任务不存在或已过期"))
		return
	}
	if len(parts) == 3 && r.Method == "GET" {
		s.writeTask(w, 200, t)
		return
	}
	if len(parts) == 4 && parts[3] == "cancel" && r.Method == "POST" {
		t.Cancel()
		writeJSON(w, 202, map[string]string{"id": t.ID, "status": "cancel_requested"})
		return
	}
	if len(parts) == 4 && parts[3] == "events" && r.Method == "GET" {
		s.events(w, r, t)
		return
	}
	failure(w, 405, errors.New("不支持的方法或操作"))
}

func taskStatus(err error) int {
	var e *task.Error
	if errors.As(err, &e) {
		switch e.Code {
		case task.Invalid:
			return 400
		case task.Busy:
			return 409
		case task.Capacity:
			return 429
		case task.Closed:
			return 503
		}
	}
	return 500
}
