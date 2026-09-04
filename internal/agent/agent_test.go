package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/yanglongyun/agentic/internal/api"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

func TestToolLoop(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		w.Header().Set("Content-Type", "application/json")
		if calls.Add(1) == 1 {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"output": []any{map[string]any{"type": "function_call", "call_id": "c1", "name": "shell", "arguments": "{\"command\":\"echo hello\"}"}},
				"usage":  map[string]any{"total_tokens": 10},
			})
			return
		}
		input := body["input"].([]any)
		found := false
		for _, v := range input {
			if v.(map[string]any)["type"] == "function_call_output" {
				found = true
			}
		}
		if !found {
			t.Error("second request lacks function_call_output")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"output": []any{map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "完成"}}}},
			"usage":  map[string]any{"total_tokens": 20},
		})
	}))
	defer srv.Close()
	h, err := history.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	c := config.Default()
	c.URL = srv.URL
	c.Key = "test"
	c.Model = "test"
	a := &Agent{Config: c, API: &api.Client{URL: c.URL, Key: c.Key, Model: c.Model}, History: h, Tools: tools.New(5, 30000)}
	out, err := a.Turn(context.Background(), "执行")
	if err != nil {
		t.Fatal(err)
	}
	if out != "完成" {
		t.Fatalf("out=%q", out)
	}
	if calls.Load() != 2 {
		t.Fatalf("calls=%d", calls.Load())
	}
}
