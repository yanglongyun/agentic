#!/usr/bin/env bash
# 端到端自测：拿假 API 跑真的 agent 循环
#   ./test/run.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
PORT="${PORT:-8899}"
PASS=0; FAIL=0

export AGENT_CONFIG_DIR="$WORK/config"
export AGENT_DATA_DIR="$WORK/data"
export AGENT_URL="http://127.0.0.1:$PORT/v1/responses"
export AGENT_KEY="test-key"
export AGENT_MODEL="test-model"
export SCRIPT_FILE="$WORK/script.json"
export REQUESTS_FILE="$WORK/requests.jsonl"

cleanup() { [ -n "${MOCK_PID:-}" ] && kill "$MOCK_PID" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; FAIL=$((FAIL+1)); }
check(){ if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (期望 [$3]，实际 [$2])"; fi; }

start_mock() {
    printf '%s' "$1" >"$SCRIPT_FILE"
    : >"$REQUESTS_FILE"
    rm -rf "$AGENT_DATA_DIR"; mkdir -p "$AGENT_DATA_DIR"
    [ -n "${MOCK_PID:-}" ] && { kill "$MOCK_PID" 2>/dev/null; wait "$MOCK_PID" 2>/dev/null; }
    PORT=$PORT python3 "$ROOT/test/mock_api.py" &
    MOCK_PID=$!
    # 探活必须用 GET：mock 只在 POST 上推进脚本，别把第一条响应浪费掉
    for _ in $(seq 1 40); do
        curl -s -o /dev/null -m 1 "$AGENT_URL" 2>/dev/null && break
        sleep 0.1
    done
}

AGENT="$ROOT/bin/agent"

echo "== 1. 纯对话（不调工具）=="
start_mock '[{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"你好呀"}]}],"usage":{"total_tokens":42}}]'
out="$("$AGENT" -p "你好" 2>/dev/null)"
check "回复正确" "$out" "你好呀"
check "历史 2 条" "$(wc -l <"$AGENT_DATA_DIR/history.jsonl" | tr -d ' ')" "2"
check "usage 记下了" "$(jq -r .tokens "$AGENT_DATA_DIR/state.json")" "42"
check "tools 传了 4 个" "$(jq -r '.tools|length' <"$REQUESTS_FILE" | head -1)" "4"
check "tools 是扁平格式" "$(jq -r '.tools[0].name' <"$REQUESTS_FILE" | head -1)" "bash"

echo "== 2. bash 工具 + 循环回传 =="
start_mock '[
 {"output":[{"type":"function_call","id":"fc_1","call_id":"call_1","name":"bash","arguments":"{\"command\":\"echo hello-from-tool\"}"}],"usage":{"total_tokens":50}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"命令输出是 hello-from-tool"}]}],"usage":{"total_tokens":60}}]'
out="$("$AGENT" -p "跑个命令" 2>/dev/null)"
check "拿到最终回复" "$out" "命令输出是 hello-from-tool"
check "请求了 2 次" "$(wc -l <"$REQUESTS_FILE" | tr -d ' ')" "2"
check "第二次带回了工具结果" \
  "$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]|select(.type=="function_call_output")|.call_id]|last')" "call_1"
check "工具输出含命令结果" \
  "$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]|select(.type=="function_call_output")|.output]|last' | grep -c hello-from-tool)" "1"

echo "== 3. write + edit =="
target="$WORK/demo.txt"
start_mock "$(jq -n --arg p "$target" '[
 {"output":[{"type":"function_call","id":"f1","call_id":"c1","name":"write",
   "arguments":({path:$p, content:"alpha\nbeta\ngamma\n"}|tostring)}],"usage":{"total_tokens":10}},
 {"output":[{"type":"function_call","id":"f2","call_id":"c2","name":"edit",
   "arguments":({path:$p, old_string:"beta", new_string:"BETA"}|tostring)}],"usage":{"total_tokens":20}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"改好了"}]}],"usage":{"total_tokens":30}}]')"
out="$("$AGENT" -p "建个文件再改" 2>/dev/null)"
check "最终回复" "$out" "改好了"
check "文件内容已替换" "$(cat "$target")" "$(printf 'alpha\nBETA\ngamma')"
check "尾部换行保住了" "$(tail -c 1 "$target" | od -An -tx1 | tr -d ' \n')" "0a"

echo "== 3b. edit 处理以换行结尾的 old_string =="
printf 'keep\nremove-me\ntail\n' >"$WORK/nl.txt"
start_mock "$(jq -n --arg p "$WORK/nl.txt" '[
 {"output":[{"type":"function_call","id":"f1","call_id":"c1","name":"edit",
   "arguments":({path:$p, old_string:"remove-me\n", new_string:""}|tostring)}],"usage":{"total_tokens":10}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"删了"}]}],"usage":{"total_tokens":20}}]')"
"$AGENT" -p "删一行" >/dev/null 2>&1
check "整行被删掉" "$(cat "$WORK/nl.txt")" "$(printf 'keep\ntail')"

echo "== 4. edit 匹配到多处要报错 =="
printf 'x\nx\n' >"$WORK/dup.txt"
start_mock "$(jq -n --arg p "$WORK/dup.txt" '[
 {"output":[{"type":"function_call","id":"f1","call_id":"c1","name":"edit",
   "arguments":({path:$p, old_string:"x", new_string:"y"}|tostring)}],"usage":{"total_tokens":10}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"知道了"}]}],"usage":{"total_tokens":20}}]')"
"$AGENT" -p "改" >/dev/null 2>&1
check "报了不唯一" \
  "$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]?|select(.type=="function_call_output")|.output]|last' | grep -c '不唯一')" "1"
check "文件没被动" "$(cat "$WORK/dup.txt")" "$(printf 'x\nx')"

echo "== 5. read 文本（带行号）=="
printf 'line-one\nline-two\n' >"$WORK/r.txt"
start_mock "$(jq -n --arg p "$WORK/r.txt" '[
 {"output":[{"type":"function_call","id":"f1","call_id":"c1","name":"read",
   "arguments":({path:$p}|tostring)}],"usage":{"total_tokens":10}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"读到了"}]}],"usage":{"total_tokens":20}}]')"
"$AGENT" -p "读文件" >/dev/null 2>&1
body="$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]?|select(.type=="function_call_output")|.output]|last')"
check "有行号 1" "$(printf '%s' "$body" | grep -cE '^ *1[[:space:]]+line-one$')" "1"
check "有行号 2" "$(printf '%s' "$body" | grep -cE '^ *2[[:space:]]+line-two$')" "1"

echo "== 6. read 图片 → 追加 input_image =="
# 一个最小的合法 PNG
printf '\x89PNG\r\n\x1a\n' >"$WORK/pic.png"; head -c 64 /dev/urandom >>"$WORK/pic.png"
start_mock "$(jq -n --arg p "$WORK/pic.png" '[
 {"output":[{"type":"function_call","id":"f1","call_id":"c1","name":"read",
   "arguments":({path:$p}|tostring)}],"usage":{"total_tokens":10}},
 {"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"看到图了"}]}],"usage":{"total_tokens":20}}]')"
"$AGENT" -p "看图" >/dev/null 2>&1
check "第二次请求带了 input_image" \
  "$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]?|select(.type=="message")|.content[]?|select(.type=="input_image")]|length')" "1"
check "是 png 的 data URL" \
  "$(tail -1 "$REQUESTS_FILE" | jq -r '[.input[]?|.content[]?|select(.type=="input_image")|.image_url]|last' | grep -c '^data:image/png;base64,')" "1"

echo "== 7. 压缩 =="
start_mock '[{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}],"usage":{"total_tokens":999999}}]'
export AGENT_COMPACT_AT=1000 AGENT_KEEP_ITEMS=4
for i in 1 2 3 4 5 6 7 8 9; do "$AGENT" -p "第 $i 句" >/dev/null 2>&1; done
after="$(wc -l <"$AGENT_DATA_DIR/history.jsonl" | tr -d ' ')"
# 9 轮对话不压缩就是 18 条
if [ "$after" -lt 18 ]; then ok "压缩生效（18 条原文 → 上下文 $after 条）"
else bad "没压缩（上下文 $after 条）"; fi
check "首条是摘要" \
  "$(head -1 "$AGENT_DATA_DIR/history.jsonl" | jq -r '.content[0].text' | grep -c '之前对话的摘要')" "1"
check "保留段从 user 消息开始" \
  "$(sed -n '2p' "$AGENT_DATA_DIR/history.jsonl" | jq -r '.role')" "user"
if [ "$(wc -l <"$AGENT_DATA_DIR/archive.jsonl" | tr -d ' ')" -gt "$after" ]; then
    ok "原文都在归档里"
else bad "归档比当前上下文还短"; fi
unset AGENT_COMPACT_AT AGENT_KEEP_ITEMS

echo "== 8. reset / history =="
start_mock '[{"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"嗯"}]}],"usage":{"total_tokens":5}}]'
"$AGENT" -p "记一句" >/dev/null 2>&1
check "history 打得出来" "$("$AGENT" history | grep -c '记一句')" "1"
"$AGENT" reset >/dev/null 2>&1
check "reset 后为空" "$(wc -l <"$AGENT_DATA_DIR/history.jsonl" | tr -d ' ')" "0"

echo "== 9. 配置 =="
"$AGENT" config set model my-model >/dev/null 2>&1
check "写进配置文件了" "$(grep -c 'AGENT_MODEL=my-model' "$AGENT_CONFIG_DIR/config")" "1"
check "配置文件权限 600" "$(stat -c %a "$AGENT_CONFIG_DIR/config")" "600"

echo
if [ "$FAIL" -eq 0 ]; then
    printf '\033[32m全部通过：%d 项\033[0m\n' "$PASS"
else
    printf '\033[31m%d 项通过，%d 项失败\033[0m\n' "$PASS" "$FAIL"
    exit 1
fi
