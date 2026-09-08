package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/yanglongyun/agentic/internal/task"
)

func (s *Server) events(w http.ResponseWriter, r *http.Request, t *task.Task) {
	f, ok := w.(http.Flusher)
	if !ok {
		failure(w, 500, errors.New("不支持流式输出"))
		return
	}
	cursor := 0
	if value := r.Header.Get("Last-Event-ID"); value != "" {
		var err error
		cursor, err = strconv.Atoi(value)
		if err != nil || cursor < 0 {
			failure(w, 400, errors.New("Last-Event-ID 无效"))
			return
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		events, done, changed, first := s.tasks.Watch(t, cursor)
		_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(20 * time.Second))
		if first > 0 && cursor < first-1 {
			fmt.Fprintf(w, "event: gap\ndata: {\"first_available_id\":%d}\n\n", first)
		}
		for _, e := range events {
			if e.ID > cursor {
				b, _ := json.Marshal(e)
				if _, err := fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", e.ID, e.Type, b); err != nil {
					return
				}
				cursor = e.ID
			}
		}
		fmt.Fprint(w, ": heartbeat\n\n")
		f.Flush()
		if done {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-s.tasks.Done():
			return
		case <-changed:
		case <-ticker.C:
		}
	}
}
