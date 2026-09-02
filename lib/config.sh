#!/usr/bin/env bash
# 配置：读写 ~/.config/agent-cli/config

AGENT_CONFIG_DIR="${AGENT_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/agent-cli}"
AGENT_CONFIG_FILE="$AGENT_CONFIG_DIR/config"
AGENT_DATA_DIR="${AGENT_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/agent-cli}"

# 默认值（config 文件里的同名变量会覆盖它们，环境变量优先级最高）
config_defaults() {
    : "${AGENT_URL:=https://api.openai.com/v1/responses}"
    : "${AGENT_KEY:=}"
    : "${AGENT_MODEL:=gpt-4o-mini}"
    : "${AGENT_COMPACT_AT:=60000}"   # 上次用量超过这个 token 数就压缩
    : "${AGENT_KEEP_ITEMS:=20}"      # 压缩时至少保留最近多少条
    : "${AGENT_TIMEOUT:=120}"        # 单个工具执行超时（秒）
    : "${AGENT_MAX_OUTPUT:=30000}"   # 工具输出截断（字符）
    : "${AGENT_SYSTEM:=}"            # 自定义系统提示词，空则用内置
}

config_load() {
    # 环境变量优先：先存下来，加载文件后再盖回去
    local env_url="${AGENT_URL:-}" env_key="${AGENT_KEY:-}" env_model="${AGENT_MODEL:-}"
    # shellcheck disable=SC1090
    [ -f "$AGENT_CONFIG_FILE" ] && . "$AGENT_CONFIG_FILE"
    [ -n "$env_url" ]   && AGENT_URL="$env_url"
    [ -n "$env_key" ]   && AGENT_KEY="$env_key"
    [ -n "$env_model" ] && AGENT_MODEL="$env_model"
    config_defaults
    mkdir -p "$AGENT_DATA_DIR"
}

config_write() {
    mkdir -p "$AGENT_CONFIG_DIR"
    umask 077
    cat >"$AGENT_CONFIG_FILE" <<EOF
# agent-cli 配置 —— 由 \`agent config\` 生成，可手工编辑
AGENT_URL=$(printf '%q' "$AGENT_URL")
AGENT_KEY=$(printf '%q' "$AGENT_KEY")
AGENT_MODEL=$(printf '%q' "$AGENT_MODEL")

# 上下文压缩水位（token）
AGENT_COMPACT_AT=$(printf '%q' "$AGENT_COMPACT_AT")
# 压缩时至少保留最近多少条
AGENT_KEEP_ITEMS=$(printf '%q' "$AGENT_KEEP_ITEMS")
# 单个工具执行超时（秒）
AGENT_TIMEOUT=$(printf '%q' "$AGENT_TIMEOUT")
# 工具输出截断（字符）
AGENT_MAX_OUTPUT=$(printf '%q' "$AGENT_MAX_OUTPUT")
# 自定义系统提示词（留空用内置）
AGENT_SYSTEM=$(printf '%q' "$AGENT_SYSTEM")
EOF
    chmod 600 "$AGENT_CONFIG_FILE"
}

# 交互式配置：agent config
config_wizard() {
    local ans
    say "${C_BOLD}配置 agent-cli${C_OFF}  ($AGENT_CONFIG_FILE)"
    say "${C_GRAY}直接回车保留当前值${C_OFF}"
    say ""

    printf 'API 地址 [%s]: ' "$AGENT_URL"
    read -r ans; [ -n "$ans" ] && AGENT_URL="$ans"

    local shown="(未设置)"
    [ -n "$AGENT_KEY" ] && shown="${AGENT_KEY:0:6}...${AGENT_KEY: -4}"
    printf 'API Key [%s]: ' "$shown"
    read -r ans; [ -n "$ans" ] && AGENT_KEY="$ans"

    printf '模型 [%s]: ' "$AGENT_MODEL"
    read -r ans; [ -n "$ans" ] && AGENT_MODEL="$ans"

    config_write
    say ""
    say "${C_GREEN}已保存到 $AGENT_CONFIG_FILE${C_OFF}"
}

# 非交互：agent config set url https://...
config_set() {
    local key="$1" val="$2"
    case "$key" in
        url)        AGENT_URL="$val" ;;
        key)        AGENT_KEY="$val" ;;
        model)      AGENT_MODEL="$val" ;;
        compact-at) AGENT_COMPACT_AT="$val" ;;
        keep)       AGENT_KEEP_ITEMS="$val" ;;
        timeout)    AGENT_TIMEOUT="$val" ;;
        max-output) AGENT_MAX_OUTPUT="$val" ;;
        system)     AGENT_SYSTEM="$val" ;;
        *) die "未知配置项：$key（可用：url key model compact-at keep timeout max-output system）" ;;
    esac
    config_write
    say "${C_GREEN}$key 已更新${C_OFF}"
}

config_show() {
    local shown="(未设置)"
    [ -n "$AGENT_KEY" ] && shown="${AGENT_KEY:0:6}...${AGENT_KEY: -4}"
    say "配置文件   $AGENT_CONFIG_FILE"
    say "数据目录   $AGENT_DATA_DIR"
    say ""
    say "url        $AGENT_URL"
    say "key        $shown"
    say "model      $AGENT_MODEL"
    say "compact-at $AGENT_COMPACT_AT"
    say "keep       $AGENT_KEEP_ITEMS"
    say "timeout    $AGENT_TIMEOUT"
    say "max-output $AGENT_MAX_OUTPUT"
}

config_require() {
    [ -n "$AGENT_KEY" ] || die "还没配置 API Key，先运行：agent config"
    [ -n "$AGENT_URL" ] || die "还没配置 API 地址，先运行：agent config"
    [ -n "$AGENT_MODEL" ] || die "还没配置模型，先运行：agent config"
}
