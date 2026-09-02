#!/usr/bin/env bash
# write 工具：整文件写入

tool_def_write() {
    jq -n '{
        type: "function",
        name: "write",
        description: "把内容完整写入一个文件（覆盖已有内容，父目录会自动创建）。改动已有文件的一小部分时优先用 edit，不要用 write 整篇重写。",
        parameters: {
            type: "object",
            properties: {
                path:    { type: "string", description: "文件路径" },
                content: { type: "string", description: "要写入的完整内容" }
            },
            required: ["path", "content"]
        }
    }'
}

tool_run_write() {
    local args="$1"
    local path content dir bytes lines existed=no
    path="$(printf '%s' "$args" | jq -r '.path // empty')"

    [ -n "$path" ] || { printf '错误：缺少 path 参数'; return 0; }
    printf '%s' "$args" | jq -e 'has("content")' >/dev/null 2>&1 \
        || { printf '错误：缺少 content 参数'; return 0; }

    # jq -j 不补尾部换行，哨兵 X 挡住命令替换的剥离 —— 文件最后一行的换行符才不会丢
    content="$(printf '%s' "$args" | jq -j '.content'; printf X)"
    content="${content%X}"
    [ -f "$path" ] && existed=yes

    printf '%s  write %s%s\n' "$C_GRAY" "$path" "$C_OFF" >&2

    dir="$(dirname "$path")"
    mkdir -p "$dir" 2>/dev/null || { printf '错误：无法创建目录 %s' "$dir"; return 0; }

    printf '%s' "$content" >"$path" 2>/dev/null \
        || { printf '错误：写入失败（权限？）：%s' "$path"; return 0; }

    bytes="$(wc -c <"$path" | tr -d ' ')"
    lines="$(wc -l <"$path" | tr -d ' ')"
    if [ "$existed" = yes ]; then
        printf '已覆盖 %s（%s 行，%s 字节）' "$path" "$lines" "$bytes"
    else
        printf '已创建 %s（%s 行，%s 字节）' "$path" "$lines" "$bytes"
    fi
}
