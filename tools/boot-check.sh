#!/usr/bin/env bash
#
# boot-check.sh —— 在本仓库上真装一次、真启动一次。
#
# 为什么需要它（2026-09-21 实测，不是理论）：
#   `dsh-zcode-scribe` 1.0.0 装进 profile 后**启动硬失败** ——
#   `ERR_MODULE_NOT_FOUND`、exit 1、stderr 7231 字节；
#   而同一时刻 `--dump-config` 是 exit 0 / stderr 0 字节 / 164 行，CI 全绿。
#   根因是改名时漏了 `cordis.patch.yml` 的行 `name`（还写着旧包名）——
#   行的包名按启动的那个 profile 解析，解析不到就找不到模块。
#
#   ⚠️ `--dump-config` **抓不到这一类**：它只合成配置、不 apply 插件；
#      行名解析失败时它不报错，只是不打印 `packageDir` / `version`。
#      **只有真 `--port` 启动能验。**
#
# 断言（三条，任一不过就 exit 1）：
#   A. `dsh plugin --profile web add .` 成功            —— 装得上
#   B. `--dump-config` 里能解析到本插件的行（带 packageDir）—— 行名没跟包名脱节
#   C. 真启动：stderr **0 字节** 且 stdout 打印出监听 URL —— 起得来
#
#   只有 C 是决定性的。A 与 B 是为了在 C 失败时给出更可读的原因。
#
# 用法：
#   bash tools/boot-check.sh                 # 在仓库根跑，用默认端口
#   BOOT_PORT=31842 bash tools/boot-check.sh # 换端口
#   KEEP_SANDBOX=1 bash tools/boot-check.sh  # 失败时保留沙盒目录供排查
#
# 退出码：0 = 三条全过；1 = 有断言不过；2 = 环境问题（找不到 dsh）
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BOOT_PORT:-31841}"

# ── 找 dsh：CI 里在 node_modules/.bin，本机在 ~/.local/bin ────────
find_dsh() {
  if [ -n "${DSH_BIN:-}" ] && [ -x "${DSH_BIN}" ]; then printf '%s\n' "${DSH_BIN}"; return 0; fi
  if [ -x "$REPO/node_modules/.bin/dsh" ]; then printf '%s\n' "$REPO/node_modules/.bin/dsh"; return 0; fi
  if command -v dsh >/dev/null 2>&1; then command -v dsh; return 0; fi
  if [ -x "$HOME/.local/bin/dsh" ]; then printf '%s\n' "$HOME/.local/bin/dsh"; return 0; fi
  return 1
}

DSH="$(find_dsh)" || {
  echo "✗ 找不到 dsh —— 先装宿主：npm install --no-save @deepseek-ai/dsh@<版本>" >&2
  echo "  （或设 DSH_BIN 指向可执行的 dsh）" >&2
  exit 2
}
echo "dsh     : $DSH  ($("$DSH" --version 2>&1))"
echo "repo    : $REPO"
echo "port    : $PORT"

SANDBOX="$(mktemp -d "${TMPDIR:-/tmp}/dsh-bootcheck-XXXXXX")"
cleanup() {
  if [ "${KEEP_SANDBOX:-0}" = "1" ]; then
    echo "沙盒保留在：$SANDBOX"
  else
    rm -rf "$SANDBOX"
  fi
}
trap cleanup EXIT

mkdir -p "$SANDBOX/profiles/web"
export DSH_HOME="$SANDBOX"

fail() { echo; echo "✗ $1" >&2; exit 1; }

# ── A. 装得上 ────────────────────────────────────────────────────
echo
echo "── A. dsh plugin --profile web add ──"
if ! "$DSH" plugin --profile web add "$REPO" > "$SANDBOX/add.log" 2>&1; then
  cat "$SANDBOX/add.log"
  fail "plugin add 失败 —— 装都装不上（见上面的输出）"
fi
echo "exit=0"
grep -E '^\+ ' "$SANDBOX/add.log" || true

# ── B. 行名解析得到（带 packageDir）─────────────────────────────
echo
echo "── B. --dump-config 的行解析 ──"
"$DSH" --profile web --dump-config > "$SANDBOX/dump.yml" 2> "$SANDBOX/dump.err"
echo "exit=$?  stderr bytes=$(wc -c < "$SANDBOX/dump.err")"
if [ -s "$SANDBOX/dump.err" ]; then
  cat "$SANDBOX/dump.err"
  fail "dump-config 有 stderr 输出"
fi
# 本插件的行 id 与包名（改了就同步改这里）
PKG="$(node -p "require('$REPO/package.json').name" 2>/dev/null || echo dsh-zcode-farm)"
if ! grep -q "$PKG" "$SANDBOX/dump.yml"; then
  grep -n -A3 -B1 'comfyui-farm' "$SANDBOX/dump.yml" || true
  fail "dump-config 里找不到包名 $PKG —— cordis.patch.yml 的行 name 可能与包名脱节了"
fi
echo "✓ 合成树里找到 $PKG"
grep -n -A2 "id: comfyui-farm" "$SANDBOX/dump.yml" || true

# ── C. 真启动（决定性的一条）────────────────────────────────────
echo
echo "── C. 真启动 dsh --profile web --port $PORT --no-open ──"
timeout 45 "$DSH" --profile web --port "$PORT" --no-open \
  > "$SANDBOX/boot.log" 2> "$SANDBOX/boot.err"
BOOT_EXIT=$?
echo "exit=$BOOT_EXIT （124 = 被 timeout 掐住，即一直在正常服务）"
echo "stderr bytes=$(wc -c < "$SANDBOX/boot.err")"
echo "stdout:"
cat "$SANDBOX/boot.log"

[ -s "$SANDBOX/boot.err" ] && {
  echo "── stderr 全文 ──" >&2
  cat "$SANDBOX/boot.err" >&2
  fail "启动写入了 stderr —— 装得上但起不来（这正是 --dump-config 抓不到的那一类）"
}
grep -q 'http://' "$SANDBOX/boot.log" ||
  fail "没有打印出监听 URL —— 实例没真正服务起来"

echo
echo "✓ 三条断言全过：装得上 · 行名解析得到 · 起得来（stderr 0 字节 + 打印了 URL）"
