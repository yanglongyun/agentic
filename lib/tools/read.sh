#!/usr/bin/env bash
# read 工具：读文件，支持图片
#
# 图片处理：Responses API 的 function_call_output 只吃字符串，
# 所以图片不从工具输出走 —— 工具把 data URL 落到 $AGENT_PENDING_IMAGE，
# 主循环发现该文件存在，就在 function_call_output 之后补一条带 input_image 的
# user message item，模型下一轮就能真正"看见"这张图。

AGENT_IMAGE_MAX_BYTES="${AGENT_IMAGE_MAX_BYTES:-5242880}"   # 5MB

tool_def_read() {
    jq -n '{
        type: "function",
        name: "read",
        description: "读取一个文件的内容。文本文件按行返回并带行号；图片文件（png/jpg/jpeg/gif/webp）会作为图像直接呈现给你，你可以看图。",
        parameters: {
            type: "object",
            properties: {
                path:   { type: "string",  description: "文件路径，相对或绝对都行" },
                offset: { type: "integer", description: "可选，从第几行开始读（1 起）" },
                limit:  { type: "integer", description: "可选，最多读多少行，默认 2000" }
            },
            required: ["path"]
        }
    }'
}

_is_image() {
    case "${1,,}" in
        *.png|*.jpg|*.jpeg|*.gif|*.webp) return 0 ;;
        *) return 1 ;;
    esac
}

_image_mime() {
    case "${1,,}" in
        *.png)  echo image/png ;;
        *.jpg|*.jpeg) echo image/jpeg ;;
        *.gif)  echo image/gif ;;
        *.webp) echo image/webp ;;
        *)      echo application/octet-stream ;;
    esac
}

tool_run_read() {
    local args="$1"
    local path offset limit
    path="$(printf '%s' "$args" | jq -r '.path // empty')"
    offset="$(printf '%s' "$args" | jq -r '.offset // 1')"
    limit="$(printf '%s' "$args" | jq -r '.limit // 2000')"

    [ -n "$path" ] || { printf '错误：缺少 path 参数'; return 0; }

    printf '%s  read %s%s\n' "$C_GRAY" "$path" "$C_OFF" >&2

    [ -e "$path" ] || { printf '错误：文件不存在：%s' "$path"; return 0; }
    [ -d "$path" ] && { printf '错误：这是个目录，用 bash 的 ls 看：%s' "$path"; return 0; }
    [ -r "$path" ] || { printf '错误：没有读权限：%s' "$path"; return 0; }

    if _is_image "$path"; then
        local size mime b64
        size="$(wc -c <"$path" | tr -d ' ')"
        if [ "$size" -gt "$AGENT_IMAGE_MAX_BYTES" ]; then
            printf '错误：图片太大（%s 字节，上限 %s）。先用 bash 压缩再读。' \
                "$size" "$AGENT_IMAGE_MAX_BYTES"
            return 0
        fi
        mime="$(_image_mime "$path")"
        b64="$(base64 -w 0 <"$path" 2>/dev/null || base64 <"$path" | tr -d '\n')"
        printf 'data:%s;base64,%s' "$mime" "$b64" >"$AGENT_PENDING_IMAGE"
        printf '%s' "$path" >"$AGENT_PENDING_IMAGE.name"
        printf '已读取图片 %s（%s，%s 字节），图像内容见下一条消息。' "$path" "$mime" "$size"
        return 0
    fi

    # 二进制文件挡一下
    if LC_ALL=C grep -qI . "$path" 2>/dev/null; then :; else
        printf '错误：这看起来是二进制文件，read 只读文本和图片：%s' "$path"
        return 0
    fi

    local total content
    total="$(wc -l <"$path" | tr -d ' ')"
    content="$(sed -n "${offset},\$p" "$path" | head -n "$limit" | \
               awk -v off="$offset" '{ printf "%6d\t%s\n", NR + off - 1, $0 }')"

    [ -n "$content" ] || { printf '(文件为空，或 offset 超出了文件末尾。共 %s 行)' "$total"; return 0; }

    content="$(truncate_text "$content" "$AGENT_MAX_OUTPUT")"
    printf '%s\n\n[共 %s 行]' "$content" "$total"
}
