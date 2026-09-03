#!/usr/bin/env bash
# 上下文压缩
#
# 触发：每次请求前检查，最近一次 API 返回的 usage.total_tokens 超过 AGENT_COMPACT_AT 就压。
#       工具循环内也检查 —— 一轮里连续调几十次工具，上下文在轮内就能撑爆。
# 做法：早期上下文 → 模型摘要（失败则机械摘要）→ 摘要 + 近期原文。
# 切点必须落在一条 user 消息上，否则保留段开头会出现孤儿 function_call_output，API 会报错。
# 原文一条都不丢，全在 archive.jsonl 里。

compact_maybe() {
    local tokens; tokens="$(state_get tokens 0)"
    [ "$tokens" -gt 0 ] 2>/dev/null || return 0
    if [ "$tokens" -ge "$AGENT_COMPACT_AT" ]; then
        compact_now
    fi
}

compact_now() {
    local items n cut old keep summary text

    items="$(history_items)"
    n="$(printf '%s' "$items" | jq 'length')"

    if [ "$n" -le $((AGENT_KEEP_ITEMS + 2)) ]; then
        return 0
    fi

    # 从 n-KEEP 处向后找第一条 user 消息作为切点；找不到就向前找最后一条
    cut="$(printf '%s' "$items" | jq --argjson keep "$AGENT_KEEP_ITEMS" '
        . as $it | ($it|length) as $n | ($n - $keep) as $start |
        ( [ range($start; $n) | select($it[.].type=="message" and $it[.].role=="user") ] | first )
        // ( [ range(0; $start)  | select($it[.].type=="message" and $it[.].role=="user") ] | last  )
        // 0')"

    [ "$cut" -gt 0 ] 2>/dev/null || return 0

    old="$(printf '%s'  "$items" | jq -c ".[0:$cut]")"
    keep="$(printf '%s' "$items" | jq -c ".[$cut:]")"

    printf '%s压缩上下文中（%s 条 → 摘要）...%s\n' "$C_YELLOW" "$cut" "$C_OFF" >&2

    # 渲染成给模型读的纯文本
    text="$(printf '%s' "$old" | jq -r '
        .[] |
        if   .type=="message" and .role=="user"      then "用户: " + ([.content[]?|.text // empty]|join("\n"))
        elif .type=="message" and .role=="assistant" then "助理: " + ([.content[]?|.text // empty]|join("\n"))
        elif .type=="function_call"        then "调用工具 " + .name + ": " + ((.arguments|tostring)[0:500])
        elif .type=="function_call_output" then "工具结果: " + ((.output|tostring)[0:800])
        else empty end')"

    summary="$(api_complete "$text" '把下面这段人和 AI 助理的对话压成一份交接摘要，供助理继续工作时读。保留：用户的目标和明确要求、已经做完的事、改过哪些文件、当前进行到哪一步、待办和已知问题、关键路径与命令。丢掉寒暄和冗余的工具输出。用中文，分条写，不要开场白。' 2>/dev/null)"

    if [ -z "$summary" ]; then
        warn "摘要生成失败，改用机械摘要"
        summary="$(printf '%s' "$text" | head -c 4000)"
    fi

    local head_item
    # 摘要就是一条普通的 user 消息;_kind 只给本地看(history 命令据此标成摘要),发请求前 api_call 会剥掉
    head_item="$(jq -n --arg s "$summary" '{
        type:"message", role:"user", _kind:"compaction",
        content:[{type:"input_text", text:("以下是历史上下文压缩摘要:\n\n" + $s)}]
    }')"

    # 摘要也进归档，方便回溯每次压缩
    printf '%s\n' "$(printf '%s' "$head_item" | jq -c .)" >>"$ARCHIVE_FILE"

    history_replace "$(jq -n --argjson h "$head_item" --argjson k "$keep" '[$h] + $k')"
    state_set_tokens 0

    say "${C_GREEN}已压缩：$cut 条 → 1 条摘要，保留最近 $(printf '%s' "$keep" | jq 'length') 条${C_OFF}"
}
