import { rm as remove, mkdir as makeDirectory, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const INSTALL_GRACE_MS = 5000
const OUTPUT_LIMIT = 64 * 1024
// 脚本下载与安装总时长上限：static.devin.ai / npm registry 在受限网络下
// 会慢到近乎挂死，无超时会让 resolve() 的 await installs.get() 把
// /ally/snapshot 轮询永久挂起（前端表现为"检查中" + Failed to fetch）。
const DOWNLOAD_TIMEOUT_MS = 120_000
const INSTALL_TIMEOUT_MS = 600_000
// 脚本安装器的"载荷就绪"轮询与收尾窗口：官方 setup 脚本结尾会跑
// `devin setup` 这类交互步骤（stdin 已 ignore，永远不会返回），
// 单靠 child.done 会让安装状态一直停在"安装中"。
const SCRIPT_POLL_MS = 2_000
const SCRIPT_SETTLE_MS = 15_000

function delay(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

const SPECS = Object.freeze({
  'claude-code': Object.freeze({
    label: 'Claude Code',
    command: 'claude',
    package: '@anthropic-ai/claude-code@latest',
  }),
  codex: Object.freeze({
    label: 'Codex',
    command: 'codex',
    package: '@openai/codex@latest',
  }),
  'kimi-code': Object.freeze({
    label: 'Kimi Code',
    command: 'kimi',
    package: '@moonshot-ai/kimi-code@latest',
  }),
  devin: Object.freeze({
    label: 'Devin',
    command: 'devin',
    // 非 npm 包:官方安装脚本装到用户目录(~/.local/bin 或 %LOCALAPPDATA%)。
    // installer === 'script' 时跳过 managed prefix,fallbackPaths 兜底
    // 受限 PATH 下 resolveExecutable('devin') 找不到的已知安装位置。
    installer: 'script',
  }),
})

function fallbackPaths(command) {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return [join(localAppData, 'devin', 'cli', 'bin', `${command}.exe`)]
  }
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return [
    join(homedir(), '.local', 'bin', command),
    join(xdgData, 'devin', 'cli', '_versions', 'current', 'bin', command),
  ]
}

// 脚本安装"载荷已写完"的探测路径。setup.ps1 的顺序是
// Copy-Item(入口 exe)→ Set-Content(distribution marker)→ PATH → `devin setup`,
// marker 是拷贝完成的可靠信号；exe 在 Copy-Item 期间就可见，仅列在最后兜底。
// POSIX 下 ~/.local/bin/devin 是解包完成后才 ln -s 出来的符号链接，天然原子。
function scriptCompletionPaths(command) {
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    return [join(localAppData, 'devin', 'cli', 'distribution'), ...fallbackPaths(command)]
  }
  return fallbackPaths(command)
}

function defaultManagedRoot() {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'tools', 'dsh-ally')
}

function binaryName(command) {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

export function createCliManager({
  subprocess,
  managedRoot = defaultManagedRoot(),
  mkdir = makeDirectory,
  rm = remove,
  download,
  scriptPollMs = SCRIPT_POLL_MS,
  scriptSettleMs = SCRIPT_SETTLE_MS,
} = {}) {
  if (!subprocess) throw new Error('CLI manager requires subprocess')
  const downloadFile = download ?? (async (url, dest, signal) => {
    const response = await fetch(url, { signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    await writeFile(dest, await response.text(), 'utf8')
  })
  const installs = new Map()
  const controllers = new Map()
  let closed = false

  const specFor = (harness) => {
    const spec = SPECS[harness]
    if (!spec) throw new Error(`不支持的 Harness：${String(harness)}`)
    return spec
  }
  const prefixFor = (harness) => join(managedRoot, harness)
  const pathFor = (harness) => {
    const spec = specFor(harness)
    return join(prefixFor(harness), 'node_modules', '.bin', binaryName(spec.command))
  }
  const resolveGlobal = async (harness) => subprocess.resolveExecutable(specFor(harness).command)
  const resolveManaged = async (harness) => {
    const spec = specFor(harness)
    if (spec.installer === 'script') {
      for (const path of fallbackPaths(spec.command)) {
        try {
          return await subprocess.resolveExecutable(path)
        } catch {}
      }
      throw new Error(`${spec.label} CLI 未安装`)
    }
    return subprocess.resolveExecutable(pathFor(harness))
  }

  async function inspect(harness) {
    specFor(harness)
    try {
      await resolveGlobal(harness)
      return { available: true, source: 'global', installing: false }
    } catch {}
    if (installs.has(harness)) return { available: false, source: 'missing', installing: true }
    try {
      await resolveManaged(harness)
      return { available: true, source: 'managed', installing: false }
    } catch {
      return { available: false, source: 'missing', installing: false }
    }
  }

  async function resolve(harness) {
    specFor(harness)
    const active = installs.get(harness)
    if (active) await active
    try {
      return await resolveGlobal(harness)
    } catch {}
    try {
      return await resolveManaged(harness)
    } catch {
      const error = new Error(`${specFor(harness).label} CLI 未安装`)
      error.code = 'CLI_NOT_INSTALLED'
      throw error
    }
  }

  async function performScriptInstall(spec, controller) {
    // 官方安装入口:POSIX 走 cli.devin.ai/install.sh,Windows 走 setup.ps1。
    // 两者都把 devin 装到用户级目录并自管 PATH,不碰 managedRoot。
    // Windows Defender 的 ML 检测(如 Trojan:Win32/Commando.A!ml)会对
    // `irm <url> | iex` 下载即执行特征误报。改为先把脚本下载到临时文件、
    // 再以 -File 执行——命令行里不再出现远程执行特征。
    let scriptFile
    const script = process.platform === 'win32'
      ? {
        file: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
        url: 'https://static.devin.ai/cli/setup.ps1',
        suffix: '.ps1',
      }
      : {
        // install.sh 是 bash 脚本,必须用 bash 执行(原管道形式是 curl|bash)。
        file: 'bash',
        args: [],
        url: 'https://cli.devin.ai/install.sh',
        suffix: '.sh',
      }
    try {
      if (script.url) {
        scriptFile = join(tmpdir(), `dsh-ally-devin-setup-${process.pid}${script.suffix}`)
        try {
          await downloadFile(script.url, scriptFile, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS))
        } catch (error) {
          throw new Error(`${spec.label} CLI 安装脚本下载失败`, { cause: error })
        }
      }
      const shell = await subprocess.resolveExecutable(script.file, undefined, controller.signal)
      const child = subprocess.spawn({
        argv: scriptFile ? [shell, ...script.args, scriptFile] : [shell, ...script.args],
        cwd: homedir(),
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_LIMIT },
          stderr: { maxBytes: OUTPUT_LIMIT },
        },
        graceMs: INSTALL_GRACE_MS,
        signal: controller.signal,
      })
      // 官方脚本收尾会跑 `devin setup`(交互式登录/初始化):stdin 已 ignore,
      // 它永远不会返回,Windows Job 还要等整个范围清空——单靠 child.done
      // 会让状态一直停在"安装中"。安装本体(二进制+marker+PATH)在交互
      // 步骤之前就已完成,改为 done 与"入口产物已就绪"竞速。
      const exitResult = child.done.then(
        (result) => ({ kind: 'exit', result }),
        (error) => ({ kind: 'exit-error', error }),
      )
      const stopWatch = new AbortController()
      const binaryWatch = (async () => {
        while (!stopWatch.signal.aborted && !controller.signal.aborted) {
          for (const candidate of scriptCompletionPaths(spec.command)) {
            try {
              await subprocess.resolveExecutable(candidate)
              return { kind: 'binary' }
            } catch {}
          }
          await delay(scriptPollMs, stopWatch.signal)
        }
        return { kind: 'idle' }
      })()
      binaryWatch.catch(() => {})

      const first = await Promise.race([exitResult, binaryWatch])
      let outcome
      if (first.kind === 'binary') {
        // 载荷已就位:给安装器一个收尾窗口(写 PATH 等),仍未退出则
        // 终止残余的交互进程——不 await done,残余进程树不应再阻塞结果。
        const settled = await Promise.race([
          exitResult,
          delay(scriptSettleMs, controller.signal).then(() => ({ kind: 'linger' })),
        ])
        stopWatch.abort()
        if (settled.kind === 'linger') {
          try { await Promise.race([child.terminate?.(), delay(INSTALL_GRACE_MS)]) } catch {}
          outcome = undefined
        } else if (settled.kind === 'exit-error') {
          throw new Error(`${spec.label} CLI 安装失败`, { cause: settled.error })
        } else {
          outcome = settled.result
        }
      } else {
        stopWatch.abort()
        if (first.kind === 'idle') {
          // 外部中止但 done 未联动:主动终止,再等一个收尾窗口。
          try { await Promise.race([child.terminate?.(), delay(INSTALL_GRACE_MS)]) } catch {}
          outcome = (await Promise.race([exitResult, delay(INSTALL_GRACE_MS).then(() => undefined)]))?.result
        } else if (first.kind === 'exit-error') {
          throw new Error(`${spec.label} CLI 安装失败`, { cause: first.error })
        } else {
          outcome = first.result
        }
      }
      if (controller.signal.aborted) throw new Error(`${spec.label} CLI 安装已取消`)
      if (outcome !== undefined && outcome.exitCode !== 0) throw new Error(`${spec.label} CLI 安装失败`)
    } finally {
      if (scriptFile) await remove(scriptFile, { force: true }).catch(() => {})
    }
  }

  async function performInstall(harness) {
    const spec = specFor(harness)
    const prefix = prefixFor(harness)
    const controller = new AbortController()
    controllers.set(harness, controller)
    const watchdog = setTimeout(() => controller.abort('install-timeout'), INSTALL_TIMEOUT_MS)
    // 不持有事件循环：悬挂的 install 不该阻止进程退出。
    watchdog.unref?.()
    try {
      if (spec.installer === 'script') {
        await performScriptInstall(spec, controller)
        try {
          await resolveGlobal(harness)
        } catch {
          await resolveManaged(harness)
        }
        return { available: true, source: 'global', installing: false }
      }
      await rm(prefix, { recursive: true, force: true })
      await mkdir(prefix, { recursive: true, mode: 0o700 })
      const npm = await subprocess.resolveExecutable('npm', undefined, controller.signal)
      // Windows: DSH subprocess 直接 child_process.spawn,不带 shell:true,
      // 启动 npm.cmd 会抛 spawn EINVAL。npm.cmd 实际调 <basedir>/node_modules/npm/bin/npm-cli.js,
      // 把 argv[0] 换成 [node, npm-cli.js] 即可。
      let installArgv
      if (process.platform === 'win32' && typeof npm === 'string' && npm.toLowerCase().endsWith('.cmd')) {
        const basedir = dirname(npm)
        const npmCli = join(basedir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
        installArgv = [process.execPath, npmCli, 'install', '--prefix', prefix,
          '--no-audit', '--no-fund', '--save-exact',
          '--registry=https://registry.npmjs.org',
          spec.package,
        ]
      } else {
        installArgv = [npm, 'install', '--prefix', prefix,
          '--no-audit', '--no-fund', '--save-exact',
          '--registry=https://registry.npmjs.org',
          spec.package,
        ]
      }
      const child = subprocess.spawn({
        argv: installArgv,
        cwd: prefix,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: OUTPUT_LIMIT },
          stderr: { maxBytes: OUTPUT_LIMIT },
        },
        graceMs: INSTALL_GRACE_MS,
        signal: controller.signal,
        env: { NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
      })
      const outcome = await child.done
      if (controller.signal.aborted) throw new Error(`${spec.label} CLI 安装已取消`)
      if (outcome.exitCode !== 0) throw new Error(`${spec.label} CLI 安装失败`)
      await resolveManaged(harness)
      return { available: true, source: 'managed', installing: false }
    } catch (error) {
      await rm(prefix, { recursive: true, force: true }).catch(() => {})
      if (controller.signal.aborted) {
        throw new Error(`${spec.label} CLI 安装${controller.signal.reason === 'install-timeout' ? '超时' : '已取消'}`)
      }
      if (error instanceof Error && /安装(?:失败|已取消)/.test(error.message)) throw error
      throw new Error(`${spec.label} CLI 安装失败`)
    } finally {
      clearTimeout(watchdog)
      controllers.delete(harness)
    }
  }

  async function install(harness) {
    specFor(harness)
    if (closed) throw new Error('CLI manager 已关闭')
    if (installs.has(harness)) return installs.get(harness)
    // 同步标记 installing:并发 status() 调用要在 fire-and-forget 路径下
    // 立刻能看到"安装中"状态,不能等 await inspect 之后再设。
    // marker 是 deferred:若并发 install() 在 inspect 完成前拿到它,会随后续
    // 交接的 attempt 一起 settle;直接存一个永不 resolve 的 promise 会把
    // 并发调用方永久挂起。
    let releaseMarker
    let failMarker
    const marker = new Promise((resolve, reject) => { releaseMarker = resolve; failMarker = reject })
    marker.catch(() => {})
    installs.set(harness, marker)
    try {
      const existing = await inspect(harness)
      if (existing.available) {
        installs.delete(harness)
        releaseMarker(existing)
        return existing
      }
      const attempt = performInstall(harness).finally(() => installs.delete(harness))
      installs.set(harness, attempt)
      releaseMarker(attempt)
      return attempt
    } catch (err) {
      installs.delete(harness)
      failMarker(err)
      throw err
    }
  }

  async function status() {
    const [claude, codex, kimi, devin] = await Promise.all([
      inspect('claude-code'),
      inspect('codex'),
      inspect('kimi-code'),
      inspect('devin'),
    ])
    return { 'claude-code': claude, codex, 'kimi-code': kimi, devin }
  }

  async function close() {
    if (closed) return
    closed = true
    for (const controller of controllers.values()) controller.abort()
    await Promise.allSettled(installs.values())
  }

  // 非阻塞可用性探测：供 gateway.available / /ally/snapshot 轮询用。
  // 与 resolve() 的区别是 resolve 会 await 进行中的安装(派发路径需要)，
  // probe 在安装期间直接报不可用，绝不挂起请求。
  async function probe(harness) {
    return (await inspect(harness)).available
  }

  return { status, resolve, install, close, managedRoot, probe }
}
