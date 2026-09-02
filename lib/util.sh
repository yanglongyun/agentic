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

# ---- 让 readline 能正常收中文 ----
# locale 不是 UTF-8 时，readline 把 UTF-8 的高位字节当成 Meta 编辑命令，
# 中文输入会被当场吃掉（"你好" 可能变成一串补全动作）。
# 新装的服务器 locale 常常就是 C/POSIX，所以这里主动兜一下。
ensure_utf8_input() {
    case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
        *UTF-8*|*utf-8*|*UTF8*|*utf8*) ;;
        *)
            local cand
            for cand in C.UTF-8 C.utf8 en_US.UTF-8 en_US.utf8; do
                if locale -a 2>/dev/null | grep -qix "$cand"; then
                    export LC_ALL="$cand" LANG="$cand"
                    break
                fi
            done
            ;;
    esac

    # 双保险：一台 UTF-8 locale 都没有的机器上，至少别让 readline 改写高位字节
    if [ -z "${INPUTRC:-}" ] && [ -n "${AGENT_RUN_DIR:-}" ]; then
        local rc="$AGENT_RUN_DIR/inputrc"
        {
            [ -f "$HOME/.inputrc" ] && printf '$include %s\n' "$HOME/.inputrc"
            printf 'set input-meta on\nset output-meta on\nset convert-meta off\n'
        } >"$rc" 2>/dev/null && export INPUTRC="$rc"
    fi
}

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
