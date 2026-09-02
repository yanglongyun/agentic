#!/usr/bin/env bash
# 工具注册与分发：四个固定工具 bash / read / write / edit

AGENT_TOOLS=(bash read write edit)

tools_load() {
    local t
    for t in "${AGENT_TOOLS[@]}"; do
        # shellcheck disable=SC1090
        . "$AGENT_LIB/tools/${t}.sh"
    done
}

# 所有工具定义 -> JSON 数组（给 Responses API 的 tools 字段，扁平格式）
tools_definitions() {
    local t defs='[]' one
    for t in "${AGENT_TOOLS[@]}"; do
        one="$("tool_def_${t}")"
        defs="$(printf '%s' "$defs" | jq -c --argjson d "$one" '. + [$d]')"
    done
    printf '%s' "$defs"
}

# tools_run <name> <arguments_json>  -> 结果文本打到 stdout
tools_run() {
    local name="$1" args="$2" fn
    fn="tool_run_${name}"
    if ! declare -F "$fn" >/dev/null; then
        printf '错误：没有这个工具：%s（可用：%s）' "$name" "${AGENT_TOOLS[*]}"
        return 0
    fi
    # 参数不是合法 JSON 时兜底
    if ! printf '%s' "$args" | jq -e . >/dev/null 2>&1; then
        printf '错误：工具参数不是合法 JSON：%s' "$(printf '%s' "$args" | head -c 200)"
        return 0
    fi
    "$fn" "$args"
}
