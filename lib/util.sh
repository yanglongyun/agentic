#!/usr/bin/env bash
# 通用工具：颜色、日志、依赖检查、JSON 助手

# ---- 颜色输出 ----
if [ -t 1 ]; then
    C_RED=$'\033[31m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
    C_BLUE=$'\033[34m'; C_GRAY=$'\033[90m'; C_BOLD=$'\033[1m'; C_OFF=$'\033[0m'
else
    C_RED=''; C_GREEN=''; C_YELLOW=''; C_BLUE=''; C_GRAY=''; C_BOLD=''; C_OFF=''
fi

say()  { printf '%s\n' "$*"; }
info() { printf '%s%s%s\n' "$C_GRAY" "$*" "$C_OFF"; }
warn() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_OFF" >&2; }
err()  { printf '%s%s%s\n' "$C_RED" "$*" "$C_OFF" >&2; }
die()  { err "$*"; exit 1; }

log() {
    [ -n "${AGENT_LOG:-}" ] || return 0
    printf '[%s] %s\n' "$(date '+%F %T')" "$*" >>"$AGENT_LOG" 2>/dev/null || true
}

# ---- 依赖检查 ----
need_deps() {
    local missing=()
    local d
    for d in curl jq; do
        command -v "$d" >/dev/null 2>&1 || missing+=("$d")
    done
    if [ ${#missing[@]} -gt 0 ]; then
        err "缺少依赖：${missing[*]}"
        err "安装：apt-get install -y ${missing[*]}   或   yum install -y ${missing[*]}"
        exit 1
    fi
}

# ---- JSON 助手 ----
# 把任意字符串安全转成 JSON 字符串字面量
json_str() { jq -Rn --arg s "$(cat)" '$s' 2>/dev/null; }

# 截断过长文本，尾部标注省略了多少
truncate_text() {
    local text="$1" limit="${2:-30000}"
    if [ "${#text}" -le "$limit" ]; then
        printf '%s' "$text"
    else
        printf '%s\n\n[输出过长，已截断：共 %d 字符，显示前 %d 字符]' \
            "${text:0:$limit}" "${#text}" "$limit"
    fi
}
