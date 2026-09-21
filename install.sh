#!/usr/bin/env bash
# 把 dsh-zcode-farm 装进一个 DSH profile。
#
#   ./install.sh            # 默认 profile: web
#   ./install.sh tui        # 指定 profile
#
# 为什么钉版本：pnpm 默认有 24 小时发布冷却期，裸包名会**静默**解析到上一版。
set -euo pipefail

PROFILE="${1:-web}"
PKG="$(node -p "require('./package.json').name")"
VER="$(node -p "require('./package.json').version")"

echo "装 ${PKG}@${VER} 到 profile ${PROFILE}"

if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile "${PROFILE}" add "${PKG}@${VER}"
else
  echo "找不到 dsh 命令。两种可能：" >&2
  echo "  - WSL 非登录 shell: 先 export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  echo "  - 桌面版: 用桌面自带 node 跑 @deepseek-ai/dsh/lib/bin.js plugin --profile ${PROFILE} add ${PKG}@${VER}" >&2
  exit 1
fi

echo "装好了。重启应用后，Agent 会拿到三个 comfyui_farm_* 工具。"
echo "配置（可选）：在 profile 的 cordis.patch.yml 里给 comfyui-farm 行加 config.instances。"
