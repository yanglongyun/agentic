#!/bin/sh
set -eu
REPO="${AGENT_REPO:-yanglongyun/agentic}"
VERSION="${AGENT_VERSION:-latest}"
BIN_DIR="${AGENT_BIN_DIR:-$HOME/.local/bin}"
command -v curl >/dev/null 2>&1 || { echo "缺少 curl" >&2; exit 1; }
command -v tar >/dev/null 2>&1 || { echo "缺少 tar" >&2; exit 1; }
case "$(uname -s)" in Linux) os=linux;; Darwin) os=darwin;; *) echo "不支持的系统；Windows 请使用 install.ps1" >&2; exit 1;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64;; arm64|aarch64) arch=arm64;; *) echo "不支持的 CPU：$(uname -m)" >&2; exit 1;; esac
if [ "$VERSION" = latest ]; then url="https://github.com/$REPO/releases/latest/download/agent_${os}_${arch}.tar.gz"; else VERSION=${VERSION#v}; url="https://github.com/$REPO/releases/download/v$VERSION/agent_${os}_${arch}.tar.gz"; fi
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM
echo "下载 $url"
curl -fL "$url" -o "$tmp/agent.tar.gz"
tar -xzf "$tmp/agent.tar.gz" -C "$tmp"
mkdir -p "$BIN_DIR"
install -m 0755 "$tmp/agent" "$BIN_DIR/agent"
echo "已安装：$BIN_DIR/agent"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) echo "请把 $BIN_DIR 加入 PATH：export PATH=\"\$PATH:$BIN_DIR\"";; esac
echo "下一步：agent config"
