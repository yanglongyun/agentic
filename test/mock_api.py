#!/usr/bin/env python3
"""测试用的假 Responses API。

每次 POST 按顺序吐出 SCRIPT_FILE 里预设的一组 output items，
同时把收到的请求体逐条追加进 REQUESTS_FILE，供测试断言。
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

SCRIPT_FILE = os.environ["SCRIPT_FILE"]
REQUESTS_FILE = os.environ["REQUESTS_FILE"]
PORT = int(os.environ.get("PORT", "8899"))

with open(SCRIPT_FILE) as f:
    SCRIPT = json.load(f)

state = {"i": 0}


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        with open(REQUESTS_FILE, "a") as f:
            f.write(json.dumps(body, ensure_ascii=False) + "\n")

        i = state["i"]
        if i < len(SCRIPT):
            step = SCRIPT[i]
            state["i"] = i + 1
        else:
            # 脚本用完后继续吐一条普通消息，usage 沿用最后一条
            # （不能重复 function_call，否则 agent 会无限循环）
            usage = SCRIPT[-1].get("usage", {"total_tokens": 10}) if SCRIPT else {"total_tokens": 10}
            step = {"output": [msg("（脚本已用完）")], "usage": usage}

        payload = json.dumps(step, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


def msg(text):
    return {
        "type": "message",
        "role": "assistant",
        "content": [{"type": "output_text", "text": text}],
    }


if __name__ == "__main__":
    HTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
