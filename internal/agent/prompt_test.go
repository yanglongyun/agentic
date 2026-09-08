package agent

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yanglongyun/agentic/internal/ai"
	"github.com/yanglongyun/agentic/internal/config"
	"github.com/yanglongyun/agentic/internal/history"
	"github.com/yanglongyun/agentic/internal/tools"
)

func TestConfiguredPromptsReachModel(t *testing.T) {
	var instructions []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Instructions string `json:"instructions"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		instructions = append(instructions, req.Instructions)
		json.NewEncoder(w).Encode(map[string]any{"output": []any{message("assistant", "output_text", "response")}})
	}))
	defer srv.Close()
	c := config.Default()
	c.System = "main {{os}}"
	c.CompactSystem = "compress custom"
	c.CompactPrefix = "custom-prefix:"
	c.Keep = 1
	h, err := history.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{Config: c, History: h, API: &ai.Client{URL: srv.URL, Key: "fake", Model: "fake"}, Tools: tools.New(1, 1000)}
	if _, err = a.Turn(context.Background(), "hello"); err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"a", "b", "c", "d"} {
		if err = h.Append(message("user", "input_text", text)); err != nil {
			t.Fatal(err)
		}
	}
	if err = a.Compact(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(instructions) != 2 || !strings.HasPrefix(instructions[0], "main ") || strings.Contains(instructions[0], "{{") || instructions[1] != "compress custom" {
		t.Fatal(instructions)
	}
	items, err := h.Items()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(items[0])
	if !strings.Contains(string(raw), "custom-prefix:response") {
		t.Fatal(string(raw))
	}
	if renderPrompt("") != "" {
		t.Fatal("empty prompt was replaced")
	}
}
