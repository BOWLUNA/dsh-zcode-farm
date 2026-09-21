#!/usr/bin/env bash
# 从 DSH profile 里卸载 dsh-zcode-farm。
#
#   ./uninstall.sh          # 默认 profile: web
#   ./uninstall.sh tui      # 指定 profile
#
# 有安装就必须有卸载：改用户 profile 却不给退路是不礼貌的。
set -euo pipefail

PROFILE="${1:-web}"
PKG="$(node -p "require('./package.json').name")"

echo "从 profile ${PROFILE} 卸载 ${PKG}"

if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile "${PROFILE}" remove "${PKG}"
else
  echo "找不到 dsh 命令。两种可能：" >&2
  echo "  - WSL 非登录 shell: 先 export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  echo "  - 桌面版: 用桌面自带 node 跑 @deepseek-ai/dsh/lib/bin.js plugin --profile ${PROFILE} remove ${PKG}" >&2
  exit 1
fi

echo "已卸载。重启应用后三个 comfyui_farm_* 工具消失。"
