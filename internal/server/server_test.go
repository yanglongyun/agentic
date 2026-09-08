package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/task"
)

const testToken = "test-token-for-server"

func setup(t *testing.T, handler http.HandlerFunc, depth int) *Server {
	t.Helper()
	up := httptest.NewServer(handler)
	t.Cleanup(up.Close)
	c := config.Default()
	c.URL = up.URL
	c.Key = "fake"
	s, err := New(c, t.TempDir(), Options{Token: testToken, Concurrency: 1, MaxTasks: 10, MaxDepth: depth, Timeout: 3 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Close)
	return s
}
func answer(w http.ResponseWriter, text string) {
	_ = json.NewEncoder(w).Encode(map[string]any{"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": text}}}}})
}
func request(s *Server, method, path, body, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}
func TestHTTPAndSessions(t *testing.T) {
	s := setup(t, func(w http.ResponseWriter, r *http.Request) { answer(w, "hello") }, 2)
	if w := request(s, "POST", "/v1/tasks", `{"prompt":"hello"}`, "wrong"); w.Code != 401 {
		t.Fatal(w.Code)
	}
	for _, body := range []string{`{"prompt":""}`, `{"prompt":"x","session_id":"../bad"}`, `{"prompt":"x","parent_id":"fake"}`, `{"prompt":"x"} {}`} {
		if w := request(s, "POST", "/v1/tasks", body, testToken); w.Code != 400 {
			t.Fatal(w.Code, body)
		}
	}
	w := request(s, "POST", "/v1/tasks", `{"prompt":"hello","session_id":"one"}`, testToken)
	if w.Code != 202 {
		t.Fatal(w.Body.String())
	}
	var out task.Task
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	running := s.tasks.Get(out.ID)
	select {
	case <-running.Done():
	case <-time.After(5 * time.Second):
		t.Fatal("task stuck")
	}
	w = request(s, "GET", "/v1/tasks/"+out.ID, "", testToken)
	if !strings.Contains(w.Body.String(), `"result":"hello"`) {
		t.Fatal(w.Body.String())
	}
	w = request(s, "GET", "/v1/tasks/"+out.ID+"/events", "", testToken)
	if !strings.Contains(w.Body.String(), "event: message") || !strings.Contains(w.Body.String(), "completed") {
		t.Fatal(w.Body.String())
	}
}

func TestBusyAndCancellationHTTP(t *testing.T) {
	started := make(chan struct{}, 1)
	s := setup(t, func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		started <- struct{}{}
		<-r.Context().Done()
	}, 1)
	w := request(s, "POST", "/v1/tasks", `{"prompt":"wait","session_id":"busy"}`, testToken)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out task.Task
	json.Unmarshal(w.Body.Bytes(), &out)
	<-started
	if w = request(s, "POST", "/v1/tasks", `{"prompt":"second","session_id":"busy"}`, testToken); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w = request(s, "POST", "/v1/tasks/"+out.ID+"/cancel", "", testToken); w.Code != 202 {
		t.Fatal(w.Code)
	}
	select {
	case <-s.tasks.Get(out.ID).Done():
	case <-time.After(5 * time.Second):
		t.Fatal("cancel stuck")
	}
	w = request(s, "GET", "/v1/tasks/"+out.ID, "", testToken)
	if !strings.Contains(w.Body.String(), `"status":"cancelled"`) {
		t.Fatal(w.Body.String())
	}
}
