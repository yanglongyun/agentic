#!/usr/bin/env bash
# edit 工具：精确字符串替换

AGENT_EDIT_MAX_BYTES="${AGENT_EDIT_MAX_BYTES:-2097152}"   # 2MB，再大就该用 bash+sed 了

tool_def_edit() {
    jq -n '{
        type: "function",
        name: "edit",
        description: "把文件里的一段文本精确替换成另一段。old_string 必须和文件里的内容逐字符一致（含缩进），并且默认只能匹配到一处 —— 匹配到多处会报错，请加上足够的上下文让它唯一，或设 replace_all。改文件前先用 read 看过原文。",
        parameters: {
            type: "object",
            properties: {
                path:        { type: "string",  description: "文件路径" },
                old_string:  { type: "string",  description: "要被替换掉的原文" },
                new_string:  { type: "string",  description: "替换成的新内容" },
                replace_all: { type: "boolean", description: "可选，替换全部匹配处，默认 false" }
            },
            required: ["path", "old_string", "new_string"]
        }
    }'
}

tool_run_edit() {
    local args="$1"
    local path old new all size content rest count result
    path="$(printf '%s' "$args" | jq -r '.path // empty')"
    all="$(printf '%s' "$args" | jq -r '.replace_all // false')"

    [ -n "$path" ] || { printf '错误：缺少 path 参数'; return 0; }
    printf '%s' "$args" | jq -e 'has("old_string") and has("new_string")' >/dev/null 2>&1 \
        || { printf '错误：缺少 old_string 或 new_string'; return 0; }

    # jq -j 不补尾部换行，哨兵 X 挡住命令替换的剥离 ——
    # 两者缺一，以换行结尾的 old_string 就永远匹配不上
    old="$(printf '%s' "$args" | jq -j '.old_string'; printf X)"; old="${old%X}"
    new="$(printf '%s' "$args" | jq -j '.new_string'; printf X)"; new="${new%X}"

    printf '%s  edit %s%s\n' "$C_GRAY" "$path" "$C_OFF" >&2

    [ -f "$path" ] || { printf '错误：文件不存在：%s（新建文件用 write）' "$path"; return 0; }
    [ -w "$path" ] || { printf '错误：没有写权限：%s' "$path"; return 0; }
    [ -n "$old" ]  || { printf '错误：old_string 不能为空'; return 0; }

    size="$(wc -c <"$path" | tr -d ' ')"
    if [ "$size" -gt "$AGENT_EDIT_MAX_BYTES" ]; then
        printf '错误：文件太大（%s 字节），改用 bash 里的 sed/awk 处理。' "$size"
        return 0
    fi

    # 读进来，用哨兵保住尾部换行
    content="$(cat "$path"; printf X)"
    content="${content%X}"

    # 数一下出现次数
    rest="${content//"$old"/}"
    count=$(( (${#content} - ${#rest}) / ${#old} ))

    if [ "$count" -eq 0 ]; then
        printf '错误：在 %s 里没找到 old_string。先 read 一遍确认原文（注意缩进和空白）。' "$path"
        return 0
    fi
    if [ "$count" -gt 1 ] && [ "$all" != "true" ]; then
        printf '错误：old_string 在 %s 里匹配到 %s 处，不唯一。请加上更多上下文，或设 replace_all=true。' \
            "$path" "$count"
        return 0
    fi

    if [ "$all" = "true" ]; then
        result="${content//"$old"/"$new"}"
    else
        result="${content/"$old"/"$new"}"
    fi

    printf '%s' "$result" >"$path" 2>/dev/null \
        || { printf '错误：写回失败：%s' "$path"; return 0; }

    if [ "$count" -gt 1 ]; then
        printf '已修改 %s（替换了 %s 处）' "$path" "$count"
    else
        printf '已修改 %s（替换了 1 处）' "$path"
    fi
}
