#!/usr/bin/env bash
# bash 工具：执行 shell 命令

tool_def_bash() {
    jq -n '{
        type: "function",
        name: "bash",
        description: "在这台机器上执行一条 bash 命令，返回合并的 stdout/stderr 和退出码。用它来查看目录、搜索文件、运行程序、装依赖。长时间运行的命令请自行加超时或放后台。",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "要执行的 bash 命令" },
                workdir: { type: "string", description: "可选，执行时的工作目录" }
            },
            required: ["command"]
        }
    }'
}

tool_run_bash() {
    local args="$1"
    local command workdir out code
    command="$(printf '%s' "$args" | jq -r '.command // empty')"
    workdir="$(printf '%s' "$args" | jq -r '.workdir // empty')"

    [ -n "$command" ] || { printf '错误：缺少 command 参数'; return 0; }

    printf '%s  $ %s%s\n' "$C_GRAY" "$command" "$C_OFF" >&2

    local tmp; tmp="$(mktemp)"
    if [ -n "$workdir" ]; then
        ( cd "$workdir" 2>/dev/null || { echo "cd 失败：$workdir" >&2; exit 127; }
          timeout "$AGENT_TIMEOUT" bash -c "$command" ) >"$tmp" 2>&1
    else
        timeout "$AGENT_TIMEOUT" bash -c "$command" >"$tmp" 2>&1
    fi
    code=$?
    out="$(cat "$tmp")"
    rm -f "$tmp"

    if [ "$code" -eq 124 ]; then
        out="${out}"$'\n'"[超时：命令超过 ${AGENT_TIMEOUT}s 被终止]"
    fi
    [ -n "$out" ] || out="(无输出)"

    out="$(truncate_text "$out" "$AGENT_MAX_OUTPUT")"
    printf '%s\n\n[退出码 %d]' "$out" "$code"
}
