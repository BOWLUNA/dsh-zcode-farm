#!/usr/bin/env node
/**
 * boot-check.mjs —— 在本仓库上真装一次、真启动一次。
 *
 * **这是唯一能抓「装得上但起不来」的守卫。** 只读文件的检查在原理上替代不了真启动：
 * 装配行的 `name` 解析失败时 `--dump-config` 是 exit 0 / stderr 0 字节 / **照样列出该行**
 * （成功与失败两种 dump 差异为零），而真启动报 `Cannot find package` 并退出。
 * 兄弟仓库的 1.0.0 就是这样发出去的：dump exit 0 / CI 全绿，真启动 stderr 7231 字节。
 *
 * 规范形态（与其它四个 `dsh-zcode-*` 仓库一致）：
 *   断言 A  `dsh plugin --profile web add <repo>` 返回 0
 *   断言 B  **直接读文件**：`cordis.patch.yml` 的行 `name` === `package.json` 的 `name`
 *   断言 C  起 `--profile web --port <N> --no-open`，**在超时内 `net.connect(N)` 成功**
 *   断言 D  拿到端口**那一刻** stderr 为空
 * 退出码：0 通过 / 1 有断言失败（并打印是哪一条）/ 2 环境缺件（harness 或 pnpm 缺失，**与插件无关**）
 *
 * 为什么不断言「打印了监听 URL」：那是版本相关的 —— dsh `0.1.5-rc.2` 启动成功却 stdout 零字节。
 * 断言的落点是**端口是否应答**。
 *
 * 用法：
 *   node tools/boot-check.mjs                 # 默认端口 31841
 *   node tools/boot-check.mjs --port 31848
 *   node tools/boot-check.mjs --dsh-bin <path/to/dsh 或 bin.js>
 *   node tools/boot-check.mjs --keep          # 失败时保留沙盒目录供排查
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))

// ── 参数 ────────────────────────────────────────────────────────
const argOf = (name, fallback) => {
  const i = process.argv.indexOf('--' + name)
  return i === -1 ? fallback : process.argv[i + 1]
}
const PORT = Number(argOf('port', '31841'))
const DSH_BIN_ARG = argOf('dsh-bin', undefined)
const KEEP = process.argv.includes('--keep')
const TIMEOUT_MS = Number(argOf('timeout-ms', '60000'))
/** 端口首次应答后再观察这么久，确认它不是「绑了端口但插件加载失败」的假应答 */
const STABLE_MS = Number(argOf('stable-ms', '2500'))

const PKG_RAW = (() => {
  try {
    return JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  } catch (error) {
    // 清单读不出来/不是合法 JSON = 连装都装不上。这属于断言 A，不是守卫崩了 ——
    // 早先的写法在这里直接抛 SyntaxError，于是「注入 A」的变异会以 exit 1 通过，
    // 证明的是「守卫会崩」而不是「断言 A 会红」，那是**无效验证**。
    console.error('')
    console.error(`✗ 断言 A 失败 —— package.json 读不出来或不是合法 JSON（${String(error.message).split('\n')[0]}）`)
    console.error('  装都装不上，后面的断言无从谈起。')
    process.exit(1)
  }
})()
const PKG_NAME = PKG_RAW.name
if (typeof PKG_NAME !== 'string' || PKG_NAME === '') {
  console.error('')
  console.error('✗ 断言 A 失败 —— package.json 里没有可用的 name')
  process.exit(1)
}

// ── 退出码 2：环境缺件，与插件无关 ──────────────────────────────
function envFail(message, hint) {
  console.error('')
  console.error('✗ 环境缺件（exit 2）—— 这不是插件的问题：')
  console.error('  ' + message)
  if (hint !== undefined) {
    console.error('')
    console.error('  可复制的修法：')
    for (const line of hint) console.error('    ' + line)
  }
  process.exit(2)
}

/**
 * harness 发现顺序（五步，找不到就 exit 2）。
 * ⚠️ 这里**不探** `%APPDATA%\dsh-desktop` —— 那是 2026-09-21 搬迁前的旧址，已不存在。
 */
function findDsh() {
  // 1. 显式参数（最高优先级）
  if (DSH_BIN_ARG !== undefined) {
    if (!existsSync(DSH_BIN_ARG)) envFail(`--dsh-bin 指向的路径不存在：${DSH_BIN_ARG}`)
    return runner(DSH_BIN_ARG)
  }

  // 2. $DSH_INSTALL —— 迁移会话留话：以后换 harness 位置优先用它，而不是逐个改链接
  const install = process.env.DSH_INSTALL
  if (install !== undefined && install !== '') {
    // 两种形态都认：安装根（含 node_modules）或 dsh 包目录本身
    const candidates = [
      join(install, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      join(install, 'lib', 'bin.js'),
    ]
    const hit = candidates.find((c) => existsSync(c))
    if (hit !== undefined) return runner(hit)
  }

  // 3. 仓库本地安装（CI 就是这一路）
  const local = join(REPO, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (existsSync(local)) return runner(local)

  // 4. PATH 上的 dsh（机器级安装）
  //    不假设它在 PATH 上 —— 开发机常有、CI 常没有，假设它会让守卫全腿报 127 而看起来像插件故障
  const onPath = process.env.PATH?.split(process.platform === 'win32' ? ';' : ':')
    .map((dir) => join(dir, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'))
    .find((c) => existsSync(c))
  if (onPath !== undefined) return { command: onPath, args: [], label: onPath }

  // 5. 都没有
  envFail(
    '找不到 harness。试过：--dsh-bin、$DSH_INSTALL、<repo>/node_modules/@deepseek-ai/dsh、PATH 上的 dsh。',
    [
      '# 首选：用你自己的实测实例（每个窗口一份，互不干扰）',
      'export DSH_INSTALL="C:/Users/BOWLUNA/Desktop/DSHTEST/farm/dsh"',
      'export PATH="$DSH_INSTALL/node_modules/.bin:$PATH"   # 就地装的 pnpm 也在这里',
      'N="C:/Users/BOWLUNA/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"',
      'D="$DSH_INSTALL/node_modules/@deepseek-ai/dsh/lib/bin.js"',
      '',
      '# 或：让本仓库自带一份（CI 就是这一路）',
      'npm install --no-save --no-audit --no-fund @deepseek-ai/dsh@0.1.6-alpha.2',
      '',
      '# 桌面版那份共享 harness 也能用，但**不要拿它做实验** —— 用户日常在用：',
      '#   C:/BL/AI/dsh-harness（DSH_HOME 是它下面的 harness/）',
    ],
  )
}

/** 统一的调用形态：`.js` 用当前 node 跑；Windows 的 `.cmd/.bat` 必须经 cmd.exe；其余直接执行。 */
function runner(dshPath) {
  if (/\.(mjs|js)$/i.test(dshPath)) {
    return { command: process.execPath, args: [dshPath], label: `${process.execPath} ${dshPath}` }
  }
  // ⚠️ Windows 上不能直接 spawn 一个 .cmd/.bat —— Node 会以 `spawn EINVAL` 收场
  //    （实测：PATH 上命中 `dsh.cmd` 时，守卫崩在 spawn 里，既没干活也没干净地 exit 2）。
  //    正确姿势是交给 cmd.exe。
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(dshPath)) {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', dshPath],
      label: dshPath,
    }
  }
  return { command: dshPath, args: [], label: dshPath }
}

/** spawn 失败（EINVAL/ENOENT 等）要变成可读的 exit 2，而不是一段栈。 */
function safeSpawn(command, args, options) {
  try {
    return spawn(command, args, options)
  } catch (err) {
    envFail(
      `无法启动 harness（${command}）：${String(err.code ?? err.message)}`,
      ['多半是路径形式不对。用 --dsh-bin 直接指到 bin.js：',
        '  --dsh-bin "C:/Users/BOWLUNA/Desktop/DSHTEST/farm/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"'],
    )
    return null
  }
}

const dsh = findDsh()

// ── pnpm 前置（`dsh plugin add` 会 forward 给 pnpm，`dsh` 不自带）──
function hasPnpm() {
  const exts = process.platform === 'win32' ? ['pnpm.cmd', 'pnpm.exe', 'pnpm'] : ['pnpm']
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  return dirs.some((dir) => dir !== '' && exts.some((ext) => existsSync(join(dir, ext))))
}
if (hasPnpm() === false) {
  envFail(
    'setUp: PATH 上没有 pnpm。`dsh plugin --profile web add` 会 forward 给 pnpm，缺了它装不上。',
    ['npm install -g pnpm@12'],
  )
}

// ── 沙盒：一次性 DSH_HOME，且第一行就断言它不是真实的 ~/.dsh ────
const SANDBOX = mkdtempSync(join(tmpdir(), 'dsh-bootcheck-'))
const REAL_HOME = resolve(process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh'))
if (resolve(SANDBOX) === REAL_HOME || resolve(SANDBOX).startsWith(join(REAL_HOME, ''))) {
  console.error(`✗ 沙盒路径与真实 DSH_HOME 重叠：${SANDBOX} vs ${REAL_HOME}`)
  process.exit(2)
}
process.env.DSH_HOME = SANDBOX

console.log(`dsh     : ${dsh.label}`)
console.log(`repo    : ${REPO}`)
console.log(`DSH_HOME: ${SANDBOX}   (一次性，跑完即删)`)
console.log(`port    : ${String(PORT)}`)
console.log('')

const cleanup = () => {
  if (KEEP) console.log(`沙盒保留在：${SANDBOX}`)
  else rmSync(SANDBOX, { recursive: true, force: true })
}

function run(args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = safeSpawn(dsh.command, [...dsh.args, ...args], {
      cwd: REPO,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    })
    let out = ''
    let err = ''
    child.stdout?.on('data', (b) => { out += String(b) })
    child.stderr?.on('data', (b) => { err += String(b) })
    child.on('close', (code) => resolvePromise({ code, out, err, child }))
  })
}

function fail(assertion, detail) {
  console.error('')
  console.error(`✗ 断言 ${assertion} 失败 —— ${detail}`)
  cleanup()
  process.exit(1)
}

// ── 前置：端口必须先是空的 ──────────────────────────────────────
// 否则断言 C 会被**上一次运行残留的监听**欺骗：探测连上了，但连的不是本次起的进程。
// 这不是假设 —— 变异测试里真的发生过（同一条 C 注入，一次红一次绿）。
// 端口被占属于环境问题 ⇒ exit 2，与插件无关。
function probePortOnce(port, timeoutMs) {
  return new Promise((resolvePromise) => {
    const sock = createConnection({ host: '127.0.0.1', port })
    const done = (ok) => { sock.destroy(); resolvePromise(ok) }
    sock.setTimeout(timeoutMs)
    sock.on('connect', () => done(true))
    sock.on('timeout', () => done(false))
    sock.on('error', () => done(false))
  })
}

if (await probePortOnce(PORT, 800)) {
  envFail(
    `端口 ${String(PORT)} 上已经有东西在应答 —— 断言 C 会连到那个进程，而不是本次启动的这一个。`,
    [
      '换一个端口：node tools/boot-check.mjs --port 31848',
      `或先清理残留：ss -ltnp | grep :${String(PORT)}   （WSL） / netstat -ano | findstr :${String(PORT)}   （Windows）`,
    ],
  )
}

// ── 断言 A：装得上 ─────────────────────────────────────────────
console.log('── 断言 A · dsh plugin --profile web add ──')
const add = await run(['plugin', '--profile', 'web', 'add', REPO])
console.log(`exit=${String(add.code)}`)
if (add.code !== 0) {
  console.error(add.out.trim())
  console.error(add.err.trim())
  fail('A', 'plugin add 失败 —— 装都装不上')
}
console.log((add.out.split('\n').find((l) => l.trim().startsWith('+')) ?? '').trim())
console.log('✓ A 通过')

// ── 断言 B：行名 === 包名（直接读文件，不问 --dump-config）──────
console.log('')
console.log('── 断言 B · cordis.patch.yml 的行 name === package.json 的 name ──')
const patchPath = join(REPO, 'cordis.patch.yml')
if (existsSync(patchPath) === false) fail('B', 'cordis.patch.yml 不存在')
const patchText = readFileSync(patchPath, 'utf8')
// 取 `name:` 那一行的值，支持单/双引号
const rowName = /^\s*name:\s*['"]?([^'"\n#]+?)['"]?\s*$/m.exec(patchText)?.[1]?.trim()
if (rowName === undefined) fail('B', 'cordis.patch.yml 里找不到 name: 行')
console.log(`  行 name      = ${rowName}`)
console.log(`  package.json = ${PKG_NAME}`)
if (rowName !== PKG_NAME) {
  fail('B', `行 name（${rowName}）与包名（${PKG_NAME}）不一致 —— 启动时会 ERR_MODULE_NOT_FOUND，\n  而 --dump-config 对此零信号（照样 exit 0 / stderr 0 字节 / 照样列出该行）`)
}
console.log('✓ B 通过')

// ── 断言 C + D：真启动，端口应答，且那一刻 stderr 为空 ──────────
console.log('')
console.log('── 断言 C · 真启动并在超时内连上端口 ──')

const boot = safeSpawn(dsh.command, [...dsh.args, '--profile', 'web', '--port', String(PORT), '--no-open'], {
  cwd: REPO,
  env: process.env,
  stdio: ['ignore', 'pipe', 'pipe'],
})
let bootOut = ''
let bootErr = ''
boot.stdout.on('data', (b) => { bootOut += String(b) })
boot.stderr.on('data', (b) => { bootErr += String(b) })
let exited = null
boot.on('close', (code) => { exited = code })

const deadline = Date.now() + TIMEOUT_MS
let answered = false
while (Date.now() < deadline) {
  if (exited !== null) break
  if (await probePortOnce(PORT, 1000)) { answered = true; break }
  await new Promise((r) => setTimeout(r, 250))
}

/**
 * ★ 稳定窗口：端口「曾应答」不等于「起得来」。
 *
 * 实测（2026-09-21）：`dsh web` 是**先绑端口、再加载插件树**。插件加载失败时，
 * 端口会有一段**短暂应答窗口**，然后进程退出。于是「只探一次」的断言 C 会在
 * 这段窗口里**假绿** —— 同一条注入（index.js 顶层抛错）曾经一次红一次绿，
 * 红的那次只是恰好没落在窗口内。这是原规格的漏洞，不是偶发。
 *
 * 所以：首次应答后等一个稳定窗口，再复查「端口仍在应答」且「进程还活着」。
 */
let stable = answered
if (answered) {
  await new Promise((r) => setTimeout(r, STABLE_MS))
  stable = (await probePortOnce(PORT, 1500)) && exited === null
}

/** 那一刻的 stderr —— 断言 D 用的快照 */
const stderrAtAnswer = bootErr

// 停止：SIGTERM，不要 SIGKILL（SIGKILL 会让子进程 stdout 断裂并往 stderr 吐 traceback）
boot.kill('SIGTERM')
await new Promise((r) => {
  if (exited !== null) return r()
  const t = setTimeout(() => { boot.kill('SIGKILL'); r() }, 5000)
  boot.on('close', () => { clearTimeout(t); r() })
})

console.log(`  进程退出码=${exited === null ? '(未退出，已强杀)' : String(exited)}`)
if (bootOut.trim() !== '') console.log(`  stdout: ${bootOut.trim()}`)

if (answered === false) {
  console.error('  stderr 前 20 行：')
  console.error(stderrAtAnswer.split('\n').slice(0, 20).join('\n'))
  fail('C', `超时 ${String(TIMEOUT_MS)}ms 内端口 ${String(PORT)} 始终没有应答 —— 装得上但起不来`)
}
if (stable === false) {
  console.error('  stderr 前 20 行：')
  console.error(stderrAtAnswer.split('\n').slice(0, 20).join('\n'))
  fail(
    'C',
    `端口曾应答，但 ${String(STABLE_MS)}ms 的稳定窗口内它消失了（进程退出码=${exited === null ? '仍在跑' : String(exited)}）——\n` +
      '  dsh 先绑端口再加载插件树：插件加载失败时会有这么一段「假应答」窗口。',
  )
}
console.log(`✓ C 通过（端口 ${String(PORT)} 应答并在 ${String(STABLE_MS)}ms 稳定窗口后仍应答、进程仍活着）`)

console.log('')
console.log('── 断言 D · 端口应答那一刻，stderr 里不许有致命模式 ──')
/**
 * ★ 断言 D 的正确形态是**白名单式「不许有致命模式」**，而不是「必须一个字都没有」。
 *
 * R2 定的原话是「拿到端口那一刻 stderr 为空」。那条太粗：插件自己声明的、带明确修复指引的
 * **降级告警**会被判成失败。姊妹仓 `dsh-zcode-rewind` 就是这么红的 —— 266 字节 stderr，
 * 内容是它自己写的「@deepseek-ai/dsh-tools 不可达:工具注册跳过(捕获钩子仍工作)。修复:…」，
 * 那是优雅降级，不是故障。而当时的修法只能是把断言 D 删掉 —— 那是把闸门关掉。
 *
 * 所以这里分三档，**逐条列出、可审计**：
 *   ① 命中 FATAL_PATTERNS            ⇒ 失败（端口应答了也不代表插件树是好的）
 *   ② 命中 ALLOWED_PATTERNS          ⇒ 通过，但把命中的原文打出来
 *   ③ 既不是致命、也不在白名单里      ⇒ **失败**，并告诉你「要么修掉它，要么带着理由加进白名单」
 * ③ 是关键：它让白名单必须被**有意识地维护**，而不是退化成「忽略一切 stderr」。
 */
const FATAL_PATTERNS = [
  { re: /ERR_MODULE_NOT_FOUND/, why: '装配行/依赖解析失败 —— 插件树没起来' },
  { re: /Cannot find package/, why: '同上，另一种措辞' },
  { re: /failed to load/i, why: '插件树加载失败' },
  { re: /failed to import/i, why: '同上（dsh 在插件 import 失败时用这句）' },
  { re: /is already registered/, why: '工具名冲突 —— 本生态真踩过，整个 profile 起不来' },
  { re: /SyntaxError/, why: '模块语法错误' },
  { re: /Cannot read properties of undefined/, why: '宿主 API 变了（例如 0.1.7 的 preset 面改动）' },
]

/** 允许的降级告警：**逐条列，每条都要写为什么可接受**。不许写「忽略一切」。 */
const ALLOWED_PATTERNS = [
  // farm 目前没有任何已知的可接受降级告警 —— 每次实测 stderr 都是 0 字节。
  // 这个数组保持为空是有意的：将来真出现降级告警时，它必须**带着理由**被加进来。
]

const stderrBytes = Buffer.byteLength(stderrAtAnswer, 'utf8')
console.log(`  stderr 字节=${String(stderrBytes)}`)
if (stderrAtAnswer !== '') {
  console.log('  --- 原文 ---')
  console.log(stderrAtAnswer.split('\n').slice(0, 20).join('\n'))
}

const fatal = FATAL_PATTERNS.filter(({ re }) => re.test(stderrAtAnswer))
if (fatal.length > 0) {
  fail(
    'D',
    `stderr 里有 ${String(fatal.length)} 类致命模式（端口虽然应答了，插件树并不是好的）：\n`
      + fatal.map((f) => `    ${String(f.re)}  —— ${f.why}`).join('\n'),
  )
}

const allowed = ALLOWED_PATTERNS.filter(({ re }) => re.test(stderrAtAnswer))
const unrecognised = stderrAtAnswer !== '' && allowed.length === 0
if (unrecognised) {
  fail(
    'D',
    'stderr 既不是空的、也不在白名单里。两条路，选一条：\n'
      + '    ① 修掉它（首选）；\n'
      + '    ② 如果它确实是**优雅降级**，把它连同「为什么可接受」加进本文件的 ALLOWED_PATTERNS。\n'
      + '    不要为了让这条变绿而放宽断言 —— 那等于把这道闸门关掉。',
  )
}
if (allowed.length > 0) {
  console.log(`  （命中 ${String(allowed.length)} 条白名单降级告警：${allowed.map((a) => String(a.re)).join(', ')}）`)
}
console.log('✓ D 通过（无致命模式；非空 stderr 也已逐条白名单化）')

cleanup()
console.log('')
console.log('✓ 四条断言全过：装得上 · 行名与包名一致 · 起得来（端口应答）· stderr 干净')
writeFileSync(join(tmpdir(), 'boot-check-last.txt'), `ok ${PKG_NAME} ${String(PORT)}\n`)
process.exit(0)
