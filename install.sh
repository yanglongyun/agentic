#!/usr/bin/env bash
# agent-cli 一键安装
#
#   curl -fsSL https://raw.githubusercontent.com/yanglongyun/agent-cli/main/install.sh | bash
#
# 可用环境变量：
#   AGENT_REPO    默认 yanglongyun/agent-cli
#   AGENT_BRANCH  默认 main
#   AGENT_PREFIX  安装目录，默认 ~/.agent-cli
#   AGENT_BIN     可执行文件放哪，默认 /usr/local/bin（没权限则 ~/.local/bin）
set -euo pipefail

REPO="${AGENT_REPO:-yanglongyun/agent-cli}"
BRANCH="${AGENT_BRANCH:-main}"
PREFIX="${AGENT_PREFIX:-$HOME/.agent-cli}"

red()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
gray()  { printf '\033[90m%s\033[0m\n' "$*"; }

# 1. 依赖
missing=()
for d in curl tar; do command -v "$d" >/dev/null 2>&1 || missing+=("$d"); done
command -v jq >/dev/null 2>&1 || missing+=(jq)
if [ ${#missing[@]} -gt 0 ]; then
    red "缺少依赖：${missing[*]}"
    if command -v apt-get >/dev/null 2>&1; then
        gray "正在安装..."
        if [ "$(id -u)" = 0 ]; then
            apt-get update -qq && apt-get install -y "${missing[@]}"
        else
            sudo apt-get update -qq && sudo apt-get install -y "${missing[@]}"
        fi
    elif command -v yum >/dev/null 2>&1; then
        gray "正在安装..."
        if [ "$(id -u)" = 0 ]; then yum install -y "${missing[@]}"; else sudo yum install -y "${missing[@]}"; fi
    elif command -v apk >/dev/null 2>&1; then
        if [ "$(id -u)" = 0 ]; then apk add --no-cache "${missing[@]}"; else sudo apk add --no-cache "${missing[@]}"; fi
    else
        red "请先自行安装：${missing[*]}"
        exit 1
    fi
fi

# 2. 下载
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
gray "下载 $REPO@$BRANCH ..."
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$BRANCH" \
    | tar -xz -C "$tmp" --strip-components=1

[ -f "$tmp/bin/agent" ] || { red "下载的包里没有 bin/agent，安装中止"; exit 1; }

# 3. 安装
mkdir -p "$PREFIX"
rm -rf "$PREFIX/bin" "$PREFIX/lib"
cp -R "$tmp/bin" "$tmp/lib" "$PREFIX/"
[ -f "$tmp/README.md" ] && cp "$tmp/README.md" "$PREFIX/" || true
chmod +x "$PREFIX/bin/agent"

# 4. 放进 PATH
BIN="${AGENT_BIN:-}"
if [ -z "$BIN" ]; then
    if [ -w /usr/local/bin ] || [ "$(id -u)" = 0 ]; then BIN=/usr/local/bin; else BIN="$HOME/.local/bin"; fi
fi
mkdir -p "$BIN"
ln -sf "$PREFIX/bin/agent" "$BIN/agent"

green "✅ 装好了：$BIN/agent"

case ":$PATH:" in
    *":$BIN:"*) ;;
    *)
        gray "注意 $BIN 不在 PATH 里，加一行到 ~/.bashrc："
        echo "    export PATH=\"\$PATH:$BIN\""
        ;;
esac

echo
green "下一步："
echo "    agent config      # 填 url / key / model"
echo "    agent             # 开始对话"
