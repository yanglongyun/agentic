package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	URL, Key, Model string
	HTTP            *http.Client
}
type Response struct {
	Output []map[string]any `json:"output"`
	Usage  struct {
		TotalTokens int `json:"total_tokens"`
	} `json:"usage"`
}

func (c *Client) Call(ctx context.Context, input []map[string]any, tools []map[string]any, instructions string) (Response, error) {
	clean := make([]map[string]any, len(input))
	for i, item := range input {
		clean[i] = cloneWithoutKind(item)
	}
	body, err := json.Marshal(map[string]any{"model": c.Model, "instructions": instructions, "input": clean, "tools": tools, "store": false})
	if err != nil {
		return Response{}, err
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	var last error
	for attempt := 1; attempt <= 3; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.URL, bytes.NewReader(body))
		if err != nil {
			return Response{}, err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+c.Key)
		resp, err := client.Do(req)
		if err != nil {
			last = err
		} else {
			b, readErr := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
			resp.Body.Close()
			if readErr != nil {
				return Response{}, readErr
			}
			if resp.StatusCode >= 200 && resp.StatusCode < 300 {
				var apiErr struct {
					Error *struct {
						Message string `json:"message"`
					} `json:"error"`
				}
				if json.Unmarshal(b, &apiErr) == nil && apiErr.Error != nil {
					return Response{}, fmt.Errorf("API 错误：%s", apiErr.Error.Message)
				}
				var out Response
				if err := json.Unmarshal(b, &out); err != nil {
					return out, fmt.Errorf("API 返回的不是合法 JSON：%w", err)
				}
				return out, nil
			}
			var e struct {
				Error struct {
					Message string `json:"message"`
				} `json:"error"`
			}
			_ = json.Unmarshal(b, &e)
			msg := e.Error.Message
			if msg == "" {
				if len(b) > 300 {
					b = b[:300]
				}
				msg = string(b)
			}
			last = fmt.Errorf("API HTTP %d：%s", resp.StatusCode, msg)
			if resp.StatusCode != 429 && resp.StatusCode < 500 {
				return Response{}, last
			}
		}
		if attempt < 3 {
			select {
			case <-ctx.Done():
				return Response{}, ctx.Err()
			case <-time.After(time.Duration(attempt*2) * time.Second):
			}
		}
	}
	return Response{}, last
}

func cloneWithoutKind(in map[string]any) map[string]any {
	out := make(map[string]any, len(in))
	for k, v := range in {
		if k != "_kind" {
			out[k] = v
		}
	}
	return out
}
