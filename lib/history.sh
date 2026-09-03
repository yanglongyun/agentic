#!/usr/bin/env bash
# 历史：全局唯一一个对话，存成 jsonl —— 每行一个 Responses API 的 input item
#
#   history.jsonl   当前上下文（会被压缩重写）
#   archive.jsonl   只追加，压缩掉的原文全在这里，永不丢
#   state.json      最近一次 usage 等运行状态

history_paths() {
    HISTORY_FILE="$AGENT_DATA_DIR/history.jsonl"
    ARCHIVE_FILE="$AGENT_DATA_DIR/archive.jsonl"
    STATE_FILE="$AGENT_DATA_DIR/state.json"
}

history_init() {
    history_paths
    mkdir -p "$AGENT_DATA_DIR"
    [ -f "$HISTORY_FILE" ] || : >"$HISTORY_FILE"
    [ -f "$ARCHIVE_FILE" ] || : >"$ARCHIVE_FILE"
    [ -f "$STATE_FILE" ]   || echo '{"tokens":0,"turns":0}' >"$STATE_FILE"
}

# 追加一条 item（入参是一段 JSON），同时进归档
history_append() {
    local item="$1"
    printf '%s\n' "$(printf '%s' "$item" | jq -c .)" >>"$HISTORY_FILE"
    printf '%s\n' "$(printf '%s' "$item" | jq -c .)" >>"$ARCHIVE_FILE"
}

# 当前上下文 -> JSON 数组
history_items() {
    if [ -s "$HISTORY_FILE" ]; then
        jq -s -c . "$HISTORY_FILE"
    else
        echo '[]'
    fi
}

history_count() {
    if [ -s "$HISTORY_FILE" ]; then wc -l <"$HISTORY_FILE" | tr -d ' '; else echo 0; fi
}

# 用一个 JSON 数组整体覆盖当前上下文（压缩用；归档不动）
history_replace() {
    local items="$1"
    printf '%s' "$items" | jq -c '.[]' >"$HISTORY_FILE.tmp" && mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
}

history_reset() {
    history_paths
    : >"$HISTORY_FILE"
    state_set_tokens 0
    say "${C_GREEN}对话已清空${C_OFF}（原文仍在 $ARCHIVE_FILE）"
}

# ---- 运行状态 ----
state_get() {
    local key="$1" def="${2:-0}"
    jq -r --arg k "$key" --arg d "$def" '.[$k] // $d' "$STATE_FILE" 2>/dev/null || printf '%s' "$def"
}

state_set_tokens() {
    local n="$1"
    local cur; cur="$(cat "$STATE_FILE" 2>/dev/null || echo '{}')"
    printf '%s' "$cur" | jq -c --argjson n "$n" '.tokens=$n' >"$STATE_FILE.tmp" \
        && mv "$STATE_FILE.tmp" "$STATE_FILE"
}

# 人读的对话记录
history_dump() {
    history_paths
    [ -s "$HISTORY_FILE" ] || { say "（对话为空）"; return; }
    jq -r '
        if ._kind == "compaction" then
            "[90m[摘要] " + ([.content[]? | .text] | join("\n")) + "[0m"
        elif .type == "message" and .role == "user" then
            "[32m你:[0m " + ([.content[]? | select(.type=="input_text") | .text] | join("\n"))
        elif .type == "message" and .role == "assistant" then
            "[34m助理:[0m " + ([.content[]? | select(.type=="output_text") | .text] | join("\n"))
        elif .type == "function_call" then
            "[90m  → " + .name + " " + (.arguments|tostring|.[0:120]) + "[0m"
        elif .type == "function_call_output" then
            "[90m  ← " + ((.output|tostring)[0:120]) + "[0m"
        else empty end
    ' "$HISTORY_FILE"
}
