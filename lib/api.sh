#!/usr/bin/env bash
# Responses API 调用

# api_call <input_json_array> <tools_json_array> <instructions>
# 成功：把完整响应 JSON 打到 stdout，返回 0
# 失败：错误信息打到 stderr，返回 1
api_call() {
    local input="$1" tools="$2" instructions="$3"
    local body resp http code attempt=0 max=3

    body="$(jq -n \
        --arg model "$AGENT_MODEL" \
        --arg ins "$instructions" \
        --argjson input "$input" \
        --argjson tools "$tools" \
        '{model:$model, instructions:$ins, input:($input | map(del(._kind))), tools:$tools, store:false}')" \
        || { err "构建请求体失败"; return 1; }

    while :; do
        attempt=$((attempt + 1))
        resp="$(curl -sS -w $'\n%{http_code}' \
            --max-time 600 \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $AGENT_KEY" \
            -d "$body" \
            "$AGENT_URL" 2>&1)"
        code="${resp##*$'\n'}"
        http="${resp%$'\n'*}"

        case "$code" in
            2*)
                # 有些兼容服务 HTTP 200 也带 error 体
                if printf '%s' "$http" | jq -e '.error' >/dev/null 2>&1; then
                    err "API 错误：$(printf '%s' "$http" | jq -r '.error.message // .error')"
                    return 1
                fi
                printf '%s' "$http"
                return 0
                ;;
            429|5*)
                if [ "$attempt" -lt "$max" ]; then
                    local wait=$((attempt * 2))
                    warn "HTTP $code，${wait}s 后重试（$attempt/$max）"
                    sleep "$wait"
                    continue
                fi
                ;;
        esac

        local msg
        msg="$(printf '%s' "$http" | jq -r '.error.message // empty' 2>/dev/null)"
        if [ -z "$msg" ]; then
            # 网关的 HTML 错误页别整页糊到终端上
            case "$http" in
                *"<html"*|*"<HTML"*) msg="服务端返回了 HTML 错误页，不是 API 响应" ;;
                *) msg="$(printf '%s' "$http" | tr -d '\r' | head -c 300)" ;;
            esac
        fi

        case "$code" in
            401|403)
                err "认证失败 (HTTP $code)：$msg"
                err "检查 key 是否正确： agent config set key <你的 key>"
                ;;
            404)
                err "接口不存在 (HTTP 404)：$msg"
                err "检查 url 是否指向 Responses 接口： agent config set url <.../v1/responses>"
                ;;
            000)
                err "连不上服务器：$msg"
                err "检查 url 和网络： agent config show"
                ;;
            *)
                err "请求失败 (HTTP ${code:-?})：$msg"
                ;;
        esac
        return 1
    done
}

# 单次补全，不带工具（压缩摘要用）
api_complete() {
    local prompt="$1" instructions="$2"
    local input resp
    input="$(jq -n --arg t "$prompt" \
        '[{type:"message", role:"user", content:[{type:"input_text", text:$t}]}]')"
    resp="$(api_call "$input" '[]' "$instructions")" || return 1
    printf '%s' "$resp" | jq -r '
        [.output[]? | select(.type=="message") | .content[]? | select(.type=="output_text") | .text]
        | join("\n")'
}
