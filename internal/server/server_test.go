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

func TestRuntimeLifecycleAndSessionReservation(t *testing.T) {
	started := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body any
		json.NewDecoder(r.Body).Decode(&body)
		close(started)
		<-r.Context().Done()
	}))
	defer upstream.Close()
	c := config.Default()
	c.Key, c.URL, c.API.Token, c.API.Listen = "fake", upstream.URL, testToken, "127.0.0.1:0"
	runtime, err := Start(c, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer runtime.Close()
	client := &http.Client{Timeout: 3 * time.Second}
	getHealth := func(token string) int {
		t.Helper()
		req, _ := http.NewRequest("GET", runtime.URL+"/healthz", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		return res.StatusCode
	}
	if getHealth("wrong") != 401 || getHealth(testToken) != 200 {
		t.Fatal("health authentication failed")
	}
	c.API.Listen = strings.TrimPrefix(runtime.URL, "http://")
	if other, err := Start(c, t.TempDir()); err == nil {
		other.Close()
		t.Fatal("accepted occupied port")
	}
	release, err := runtime.ReserveSession("cli-session")
	if err != nil {
		t.Fatal(err)
	}
	if w := request(runtime.Server, "POST", "/v1/tasks", `{"prompt":"x","session_id":"cli-session"}`, testToken); w.Code != 409 {
		t.Fatal(w.Code)
	}
	release()
	job, err := runtime.tasks.Submit(task.Request{Prompt: "wait", SessionID: "cli-session"})
	if err != nil {
		t.Fatal(err)
	}
	release() // Must not release the API task that now owns this session.
	if _, err := runtime.ReserveSession("cli-session"); err == nil {
		t.Fatal("reserved active API session")
	}
	select {
	case <-started:
	case <-time.After(3 * time.Second):
		t.Fatal("task did not start")
	}
	runtime.Close()
	select {
	case <-job.Done():
	default:
		t.Fatal("shutdown returned before task finished")
	}
	if runtime.tasks.Snapshot(job).Status != "cancelled" {
		t.Fatal("task was not cancelled")
	}
	if runtime.Err() != nil {
		t.Fatal(runtime.Err())
	}
	req, _ := http.NewRequest("GET", runtime.URL+"/healthz", nil)
	if res, err := client.Do(req); err == nil {
		res.Body.Close()
		t.Fatal("listener still open")
	}
}
