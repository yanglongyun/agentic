#!/usr/bin/env bash
# Agent 循环：一直转到模型不再调工具为止

AGENT_MAX_ROUNDS="${AGENT_MAX_ROUNDS:-50}"

system_prompt() {
    if [ -n "$AGENT_SYSTEM" ]; then
        printf '%s' "$AGENT_SYSTEM"
        return
    fi
    cat <<EOF
你是一个跑在服务器终端里的 AI agent，通过工具直接操作这台机器。

当前环境：
- 主机：$(hostname 2>/dev/null || echo unknown)
- 系统：$(uname -sr 2>/dev/null)
- 用户：$(whoami 2>/dev/null)
- 工作目录：$PWD
- 时间：$(date '+%F %T %Z')

你有四个工具：
- bash：执行 shell 命令，用来查看、搜索、运行、安装。
- read：读文件，支持图片（读图片时你能真的看见图）。
- write：整文件写入，用于新建文件。
- edit：精确替换文件里的一段文本，用于修改已有文件。

原则：
- 先看再动：改任何文件前先 read 一遍原文。
- 修改已有文件用 edit，不要用 write 整篇重写。
- 回答简洁，不要复述工具输出，说结论。
- 不确定的事就用 bash 去查，不要猜。
- 破坏性操作（rm -rf、覆盖重要文件、改系统配置、装卸软件）动手前先说明你要干什么。
EOF
}

# 后台转圈，等 API 时给点反馈
_spin_pid=""
spin_start() {
    [ -t 2 ] || return 0
    ( local f='|/-\' i=0
      while :; do
          printf '\r%s%s 思考中%s' "$C_GRAY" "${f:$((i % 4)):1}" "$C_OFF" >&2
          i=$((i + 1)); sleep 0.15
      done ) &
    _spin_pid=$!
}
spin_stop() {
    [ -n "$_spin_pid" ] || return 0
    kill "$_spin_pid" 2>/dev/null; wait "$_spin_pid" 2>/dev/null
    _spin_pid=""
    printf '\r\033[K' >&2
}

# 一轮完整对话：用户说一句 → 模型可能反复调工具 → 最终给出回复
agent_turn() {
    local user_text="$1"
    local tools instructions input resp tokens n i item type rounds=0 has_call

    history_append "$(jq -n --arg t "$user_text" \
        '{type:"message", role:"user", content:[{type:"input_text", text:$t}]}')"

    compact_maybe

    tools="$(tools_definitions)"
    instructions="$(system_prompt)"

    while :; do
        rounds=$((rounds + 1))
        if [ "$rounds" -gt "$AGENT_MAX_ROUNDS" ]; then
            warn "已达最大轮数 $AGENT_MAX_ROUNDS，停下了。"
            return 0
        fi

        input="$(history_items)"
        spin_start
        resp="$(api_call "$input" "$tools" "$instructions")"
        local rc=$?
        spin_stop
        [ $rc -eq 0 ] || return 1

        tokens="$(printf '%s' "$resp" | jq -r '.usage.total_tokens // 0')"
        [ "$tokens" -gt 0 ] 2>/dev/null && state_set_tokens "$tokens"

        n="$(printf '%s' "$resp" | jq '.output | length // 0')"
        has_call=0

        for ((i = 0; i < n; i++)); do
            item="$(printf '%s' "$resp" | jq -c ".output[$i]")"
            type="$(printf '%s' "$item" | jq -r '.type // "unknown"')"

            case "$type" in
                message)
                    local text
                    text="$(printf '%s' "$item" | jq -r \
                        '[.content[]? | select(.type=="output_text") | .text] | join("")')"
                    [ -n "$text" ] && printf '%s\n' "$text"
                    history_append "$item"
                    ;;
                function_call)
                    has_call=1
                    history_append "$item"
                    local name args call_id out
                    name="$(printf '%s'    "$item" | jq -r '.name')"
                    args="$(printf '%s'    "$item" | jq -r '.arguments // "{}"')"
                    call_id="$(printf '%s' "$item" | jq -r '.call_id // .id')"

                    out="$(tools_run "$name" "$args")"

                    history_append "$(jq -n --arg id "$call_id" --arg o "$out" \
                        '{type:"function_call_output", call_id:$id, output:$o}')"

                    # read 读到图片时留下的 data URL：补一条带图的消息，模型下一轮才真看得见
                    if [ -f "$AGENT_PENDING_IMAGE" ]; then
                        local durl iname
                        durl="$(cat "$AGENT_PENDING_IMAGE")"
                        iname="$(cat "$AGENT_PENDING_IMAGE.name" 2>/dev/null || echo image)"
                        history_append "$(jq -n --arg u "$durl" --arg p "$iname" '{
                            type:"message", role:"user",
                            content:[
                                {type:"input_text",  text:("图片内容（" + $p + "）:")},
                                {type:"input_image", image_url:$u, detail:"auto"}
                            ]}')"
                        rm -f "$AGENT_PENDING_IMAGE" "$AGENT_PENDING_IMAGE.name"
                    fi
                    ;;
                *)
                    # reasoning 等其它 item 原样带回，推理模型需要它
                    history_append "$item"
                    ;;
            esac
        done

        [ "$has_call" -eq 0 ] && break
    done
    return 0
}
