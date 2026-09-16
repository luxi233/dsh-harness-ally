// Devin 账号模型目录注册为 DSH provider "devin":模型选择器列出 devin
// 账号可用的模型,选中后 request.provider==='devin' 由 devin ACP adapter
// 翻译成 `devin acp --model`。该 provider 不参与 llm 请求——
// stream/prepareCall 永远给出明确报错,引导把 Harness 切到 Devin。

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEVIN_PROVIDER = 'devin'

const LIST_MAX_BYTES = 256 * 1024
const LIST_TIMEOUT_MS = 10000
const ACP_TIMEOUT_MS = 15000
const ACP_MAX_LINE_BYTES = 2 * 1024 * 1024

// Devin 的 ACP server 不读本地凭据,要求 host 主动调 authenticate。
// api_key 来自 devin auth login 落盘的 credentials.toml(或 DEVIN_API_KEY /
// WINDSURF_API_KEY 环境变量)。
export function devinApiKey(deps) {
  const env = deps.env ?? process.env
  const direct = env.DEVIN_API_KEY ?? env.WINDSURF_API_KEY
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const read = deps.readTextFile ?? ((path) => readFileSync(path, 'utf8'))
  const home = deps.homedir ?? homedir()
  const candidates = [
    // Windows: CLI 落盘在 %APPDATA%\Devin\credentials.toml。
    ...(process.platform === 'win32'
      ? [join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Devin', 'credentials.toml')]
      : []),
    typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME
      ? join(env.XDG_DATA_HOME, 'devin', 'credentials.toml')
      : undefined,
    join(home, '.local', 'share', 'devin', 'credentials.toml'),
  ]
  for (const path of candidates) {
    if (!path) continue
    try {
      const text = read(path)
      const match = /^\s*(?:windsurf_api_key|api_key|session_token)\s*=\s*["']([^"']+)["']/m.exec(text)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch {}
  }
  return undefined
}

// session/new 的 configOptions 里 category==='model' 的 select 携带账号级
// 完整目录(value/name/supportsImages),等价于 models list 的账号数据。
function modelsFromConfigOptions(created) {
  const options = Array.isArray(created?.configOptions) ? created.configOptions : []
  const modelOption = options.find((option) => option?.id === 'model' || option?.category === 'model')
  const entries = Array.isArray(modelOption?.options) ? modelOption.options : []
  const found = []
  for (const entry of entries) {
    const id = typeof entry?.value === 'string' && entry.value ? entry.value : undefined
    // configOptions 里混有 MODEL_* 形式的内部枚举别名,不是 --model 可接受的
    // slug,过滤掉只留用户可选的模型 id。
    if (!id || /^[A-Z0-9_]+$/.test(id) || found.some((model) => model.id === id)) continue
    found.push({
      provider: DEVIN_PROVIDER,
      id,
      name: typeof entry.name === 'string' && entry.name ? entry.name : id,
      ...typeof entry.description === 'string' && entry.description ? { description: entry.description } : {},
    })
  }
  return found
}

// `devin models list` 在这个版本上对 credentials.toml 的登录态判定有 bug
// (auth status 同样误报"未登录"),但 ACP authenticate + session/new 正常工作
// 且返回完整账号目录。走 ACP 握手拿 configOptions.model。
async function listModelsViaAcp(deps) {
  const executable = deps.cliManager
    ? await deps.cliManager.resolve(DEVIN_PROVIDER)
    : await deps.subprocess.resolveExecutable('devin')
  const child = deps.subprocess.spawn({
    argv: [executable, 'acp'],
    cwd: deps.cwd ?? homedir(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 3000,
    env: {},
  })
  const pending = new Map()
  let nextId = 1
  let buffer = ''
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  const request = (method, params) => {
    const id = nextId++
    const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    send({ id, method, params })
    return promise
  }
  child.stdout?.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer) > ACP_MAX_LINE_BYTES) { child.terminate(); return }
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (!line.trim()) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      if (Number.isSafeInteger(message?.id) && pending.has(message.id) && typeof message.method !== 'string') {
        const waiter = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(message.error?.message ?? 'devin ACP request failed'))
        else waiter.resolve(message.result)
      } else if (Number.isSafeInteger(message?.id) && typeof message.method === 'string') {
        send({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } })
      }
    }
  })
  const fail = (error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.done?.then(() => fail(new Error('devin ACP exited')), () => fail(new Error('devin ACP spawn failed')))
  const timeout = setTimeout(() => { fail(new Error('devin ACP model discovery timeout')); child.terminate() }, ACP_TIMEOUT_MS)
  try {
    await request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'dsh-ally', version: '0.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
    })
    const apiKey = devinApiKey(deps)
    if (apiKey) {
      await request('authenticate', { methodId: 'devin-browser', _meta: { api_key: apiKey } })
    }
    const created = await request('session/new', { cwd: deps.cwd ?? homedir(), mcpServers: [] })
    const modelOption = (Array.isArray(created?.configOptions) ? created.configOptions : [])
      .find((option) => option?.id === 'model' || option?.category === 'model')
    return {
      models: modelsFromConfigOptions(created),
      current: typeof modelOption?.currentValue === 'string' && modelOption.currentValue
        ? modelOption.currentValue
        : undefined,
    }
  } finally {
    clearTimeout(timeout)
    fail(new Error('devin ACP closed'))
    child.terminate()
  }
}
// `devin models list` 需要登录,输出是账号级目录。登录不可用或解析失败时
// 给一份 `devin acp --model` 帮助文档列出的 family 兜底,保证选择器不为空;
// --model 接受模糊名,家族 slug 总会解析。
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'codex', name: 'Codex' },
]

// v3000.x 的 `devin acp` 在 session/new 的 model configOption 里返回空 options
// (currentValue 有值)。此时读 CLI 自己缓存的账号目录:
// <data>/devin/cli/model_configs_v5.<digest>.bin —— JSON 包一层 base64 的
// protobuf,模型 slug 以可打印字符串出现,直接抽取。
const MODEL_CACHE_PREFIXES = /^(?:claude|gpt|gemini|swe|glm|kimi|codex|deepseek|grok|minimax|qwen|o[0-9])[0-9a-z.-]*$/
function modelCatalogFromCache(deps) {
  const env = deps.env ?? process.env
  const home = deps.homedir ?? homedir()
  const read = deps.readTextFile ?? ((path) => readFileSync(path, 'utf8'))
  const dirs = [
    process.platform === 'win32'
      ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'devin', 'cli')
      : undefined,
    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'devin', 'cli'),
    join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'devin'),
  ]
  const found = []
  for (const dir of dirs) {
    if (!dir) continue
    let files
    try {
      files = readdirSync(dir).filter((name) => /^model_configs_v\d+\.[0-9a-f]+\.bin$/.test(name))
    } catch { continue }
    for (const name of files) {
      let payload
      try { payload = JSON.parse(read(join(dir, name)))?.payload } catch { continue }
      if (typeof payload !== 'string') continue
      const buf = Buffer.from(payload, 'base64')
      let current = ''
      const strings = []
      for (const byte of buf) {
        if (byte >= 0x20 && byte < 0x7f) current += String.fromCharCode(byte)
        else { if (current.length >= 3) strings.push(current); current = '' }
      }
      if (current.length >= 3) strings.push(current)
      // 缓存里每个模型按 effort/tier 展开成多个变体条目
      // (-low/-medium/-high/-fast/…),选择器只留家族基础 slug 和别名;
      // 变体存在但基础 slug 缺席时补一个基础项(--model 模糊匹配总能解析)。
      const EFFORT_SUFFIX = /-(?:minimal|none|low|medium|high|xhigh|max|fast|priority)$/
      const slugs = new Set()
      for (const token of strings) {
        const slug = token.trim().toLowerCase()
        if (MODEL_CACHE_PREFIXES.test(slug) && /[0-9.-]/.test(slug)) slugs.add(slug)
      }
      for (const slug of slugs) {
        if (!EFFORT_SUFFIX.test(slug)) {
          if (!found.some((model) => model.id === slug)) {
            found.push({ provider: DEVIN_PROVIDER, id: slug, name: slug })
          }
        }
        const base = slug.replace(EFFORT_SUFFIX, '')
        if (!slugs.has(base) && !found.some((model) => model.id === base)) {
          found.push({ provider: DEVIN_PROVIDER, id: base, name: base })
        }
      }
    }
  }
  return found
}

// `devin models list --format json` 的结构未公开约定:可能是按 family 分组的
// 嵌套对象。宽容地遍历整棵树,收集任何带字符串 id 的模型条目。
function collectModels(value, found, seen) {
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectModels(item, found, seen)
    return
  }
  const id = typeof value.id === 'string' && value.id ? value.id
    : typeof value.slug === 'string' && value.slug ? value.slug
    : undefined
  if (id && !found.some((model) => model.id === id)) {
    found.push({
      provider: DEVIN_PROVIDER,
      id,
      name: typeof value.name === 'string' && value.name ? value.name : id,
      ...typeof value.description === 'string' && value.description ? { description: value.description } : {},
    })
    return
  }
  for (const item of Object.values(value)) collectModels(item, found, seen)
}

// models list 不可用(未登录判定 bug 或旧版本无此命令)时的目录链:
// ACP configOptions → CLI 本地缓存的账号目录(含 ACP currentValue) → 静态兜底。
async function accountCatalogFallback(deps) {
  const acp = await listModelsViaAcp(deps).catch(() => ({ models: [] }))
  if (acp.models?.length) return acp.models
  const cached = modelCatalogFromCache(deps)
  if (acp.current && !cached.some((model) => model.id === acp.current)) {
    cached.unshift({ provider: DEVIN_PROVIDER, id: acp.current, name: acp.current })
  }
  if (cached.length) return cached
  return FALLBACK_MODELS.map((m) => ({ provider: DEVIN_PROVIDER, ...m }))
}

export function createDevinModelAdapter(deps) {
  let catalog
  const listAccountModels = async () => {
    if (catalog) return catalog
    catalog = (async () => {
      try {
        const executable = deps.cliManager
          ? await deps.cliManager.resolve(DEVIN_PROVIDER)
          : await deps.subprocess.resolveExecutable('devin')
        const child = deps.subprocess.spawn({
          argv: [executable, 'models', 'list', '--format', 'json'],
          cwd: deps.cwd ?? homedir(),
          stdio: { stdin: 'ignore', stdout: { maxBytes: LIST_MAX_BYTES }, stderr: { maxBytes: LIST_MAX_BYTES } },
          graceMs: 5000,
        })
        const outcome = await Promise.race([
          child.done,
          new Promise((_, reject) => setTimeout(() => reject(new Error('devin models list timeout')), LIST_TIMEOUT_MS)),
        ]).catch((error) => {
          child.terminate()
          throw error
        })
        const text = child.collected?.stdout?.readFrom(0)?.text ?? ''
        if (outcome.exitCode === 0 && text.trim()) {
          const found = []
          try {
            collectModels(JSON.parse(text), found, new Set())
          } catch {}
          if (found.length) return found
        }
        return await accountCatalogFallback(deps)
      } catch {
        return await accountCatalogFallback(deps)
      }
    })()
    const listed = await catalog
    // 只缓存成功拿到账号目录的结果;失败目录不钉死,下次目录请求重试。
    if (listed === undefined || listed.every((m) => FALLBACK_MODELS.some((f) => f.id === m.id))) catalog = undefined
    return listed
  }

  return {
    providerInfo(provider) {
      return { id: provider, name: 'Devin' }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    listModels() {
      return listAccountModels()
    },
    async resolveModel(provider, model) {
      const listed = await listAccountModels()
      const entry = listed.find((item) => item.id === model)
      return entry ?? { provider, id: model, name: model }
    },
    async prepareCall(provider, model, signal) {
      const resolved = await this.resolveModel(provider, model, signal)
      return { model: resolved, stream: (options) => this.stream(options) }
    },
    async *stream() {
      throw new Error('Devin provider 的模型只由 Devin Harness 执行：请把 Harness 切换到 Devin')
    },
  }
}
