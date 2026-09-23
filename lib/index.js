// Harness 联盟 Host adapter：把 session-scoped Harness 选择接入标准 Agent LLM
// waterfall。Agent 仍独占 turn/step；外部 CLI 只是可替换的模型执行 adapter。

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { StringDecoder } from 'node:string_decoder'

import { createModelBridge } from './bridge.js'
import { createCliManager } from './cli-manager.js'
import { createDevinModelAdapter, DEVIN_PROVIDER } from './devin-models.js'
import { ownConfigAdapters } from './cli-own-models.js'
import { createHarnessGateway } from './harness.js'
import { createNativeSessionRegistry } from './native-session.js'
import { createAllianceRuntime, HARNESSES, isAllianceSession } from './runtime.js'
import { createAllianceState } from './state.js'
import { shimProjectionCache, shimStatus } from './projection-cache-shim.js'
import { ALLY_VERSION } from './version.js'

export const name = 'ally'
export const inject = ['agents', 'llm', 'sandbox', 'sandboxPolicy', 'sessions', 'subagents', 'subprocess', 'webServer']

const ERROR_STATUS = Object.freeze({
  INVALID_HARNESS: 400,
  PRESET_REQUIRED: 403,
  SESSION_NOT_FOUND: 404,
  AGENT_NOT_FOUND: 409,
  TURN_OPEN: 409,
  PROVIDER_UNAVAILABLE: 503,
})

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

// 远端访问白名单：当 dsh-bridge customTunnel / 反代不能改写 Origin 时，
// 这里列出信任的 host。Host 命中后,authority.host = 'host:port',
// 与浏览器送来的 Origin.host 相等,trustedRead 即放行。
// ⚠️ 加进 ALLOWED_REMOTE_HOSTS 意味着任何能访问该 host 并通过
// dsh-bridge 认证的人都能调 /ally/select 与 /ally/cli-install。
//
// ALLOWED_REMOTE_ALL = true 时,把白名单层整体旁路——任何 Origin 都通过
// 这层过滤(由 dsh-bridge 的 cookie + token_and_password 在更外层兜底)。
// 适用场景：fork 用户只走 dsh-bridge 访问、希望换 IP 服务器或对外二次
// 分发而不想每次回来改这里。
const ALLOWED_REMOTE_HOSTS = new Set([
  '113.31.118.243:3002', // dsh-bridge customTunnel 公网入口
])
const ALLOWED_REMOTE_ALL = true

function loopbackAuthority(host) {
  if (!host) return undefined
  try {
    const authority = new URL(`http://${host}`)
    const hostname = authority.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
    if (loopback) return authority
    if (ALLOWED_REMOTE_HOSTS.has(authority.host)) return authority
    return undefined
  } catch {
    return undefined
  }
}

function isLoopbackAuthority(authority) {
  if (!authority) return false
  const h = authority.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || /^127(?:\.\d{1,3}){3}$/.test(h)
}

function isWhitelistedOrigin(origin) {
  if (!origin) return false
  if (ALLOWED_REMOTE_ALL) return true
  try {
    const host = new URL(origin).host
    return ALLOWED_REMOTE_HOSTS.has(host)
  } catch {
    return false
  }
}

function trustedRead(req) {
  const host = req.headers?.host
  const origin = req.headers?.origin
  const secFetchSite = req.headers?.['sec-fetch-site']
  const authority = loopbackAuthority(host)
  if (!authority) return false
  if (secFetchSite === 'cross-site') return false
  if (!origin) return true
  // 三层 fallback（按信任强度排序）：
  // 1. Host 是 loopback → dsh-bridge 已改写 host,信任代理
  // 2. Origin 命中白名单 → 公网直连入口
  // 3. Origin.host 与 authority.host 相等 → 同源直连
  if (isLoopbackAuthority(authority)) return true
  if (isWhitelistedOrigin(origin)) return true
  return new URL(origin).host === authority.host
}

export function trustedMutation(req) {
  const contentType = req.headers?.['content-type']
  const origin = req.headers?.origin
  // 关键：不再卡死 sec-fetch-site === 'same-origin'
  // dsh-bridge 转发时浏览器元数据可能丢失 / 被公网代理改写为 none / same-site 等;
  // 同源 + Content-Type + Origin 三者齐全已足以表达请求合法性。
  if (!trustedRead(req)) return false
  if (!String(contentType ?? '').toLowerCase().startsWith('application/json')) return false
  return Boolean(origin)
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8')
    let body = ''
    let bytes = 0
    req.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > 64 * 1024) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      body += decoder.write(chunk)
    })
    req.on('end', () => {
      body += decoder.end()
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'INVALID_JSON' }))
      }
    })
    req.on('error', reject)
  })
}

function errorStatus(error) {
  if (error?.code === 'BODY_TOO_LARGE') return 413
  if (error?.code === 'INVALID_JSON') return 400
  return ERROR_STATUS[error?.code] ?? 500
}

async function loadAgentLoopGuard() {
  const entry = process.argv[1]
  if (!entry) throw new Error('无法定位 DSH 入口，拒绝启用 Harness LLM router')
  const requireFromDsh = createRequire(realpathSync(entry))
  const modulePath = requireFromDsh.resolve('@deepseek-ai/dsh-llm')
  const llmModule = await import(pathToFileURL(modulePath).href)
  if (typeof llmModule.isAgentLoopRequest !== 'function') {
    throw new Error('当前 DSH 未提供 isAgentLoopRequest，拒绝启用 Harness LLM router')
  }
  return llmModule.isAgentLoopRequest
}

export async function closeAlliance({ runtime, bridge, state, cliManager }) {
  const results = await Promise.allSettled([
    runtime ? runtime.shutdown() : Promise.resolve(),
    cliManager ? cliManager.close() : Promise.resolve(),
    bridge.close(),
    state.close(),
  ])
  const failure = results.find((result) => result.status === 'rejected')
  if (failure) throw failure.reason
}

export async function apply(ctx) {
  // seeded 子代理会话的投影缓存兜底(详见 projection-cache-shim.js);
  // ctx.inject 使该可选服务缺席时 shim 安静跳过,不阻塞插件加载。
  shimProjectionCache(ctx)
  const isAgentLoopRequest = await loadAgentLoopGuard()
  const authorize = (session) => {
    if (isAllianceSession(session)) return
    const error = new Error('只有 Harness联盟模式 会话可以委派外部 Harness')
    error.code = 'PRESET_REQUIRED'
    throw error
  }
  const state = await createAllianceState()
  // attachments 服务经 reflect.get 免 inject 解析(见 gateway 同名 getter),
  // 每次请求时取一次——缺席时图片/文件翻译降级为占位文本。
  const bridge = createModelBridge({
    llm: ctx.llm,
    stateDir: state.dir,
    attachments() {
      try { return ctx.reflect?.get('attachments', false) ?? undefined } catch { return undefined }
    },
  })
  const cliManager = createCliManager({ subprocess: ctx.subprocess })
  const nativeSessions = createNativeSessionRegistry({ state, version: ALLY_VERSION })
  let runtime
  ctx.effect(() => () => closeAlliance({ runtime, bridge, state, cliManager }), 'ally.runtime')
  const gateway = createHarnessGateway({
    subprocess: ctx.subprocess,
    sandbox: ctx.sandbox,
    policyFor: (session) => ctx.sandboxPolicy.resolve({ session }),
    authorize,
    bridge,
    cliManager,
    nativeSessions,
    stateDir: state.dir,
    // 惰性解析:attachments 服务不进 inject 声明,避免老版本 DSH 缺该服务时
    // 整个插件永远不 apply。未 inject 的服务直接访问会 throw(cordis 的
    // 上下文代理按 fiber 链解析,插件 fiber 看不到旁系 provider 的 store),
    // 这里走 ctx.reflect.get——全局 store 查找、免 inject;缺席则 undefined。
    get attachments() {
      try { return ctx.reflect?.get('attachments', false) ?? undefined } catch { return undefined }
    },
  })
  for (const provider of gateway.providers) ctx.subagents.registerProvider(provider)
  // Devin 模型目录注册为 DSH provider:模型选择器里出现 devin/<model>,
  // 选中后由 devin ACP adapter 翻译成 `devin acp --model`。该 provider
  // 不接受真实 llm 请求——用别的 Harness 执行会得到明确报错。
  // Claude Code / Codex 同理注册「CLI 配置」provider:选中时 adapter 跳过
  // bridge,子进程用自己的 settings/config.toml(CCSwitch 等写入的配置)。
  let devinModelAdapter
  try {
    devinModelAdapter = createDevinModelAdapter({ subprocess: ctx.subprocess, cliManager })
    ctx.llm.registerAdapter([DEVIN_PROVIDER], devinModelAdapter)
  } catch (error) {
    ctx.logger.warn(`ally devin provider registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (const ownAdapter of ownConfigAdapters({ subprocess: ctx.subprocess, cliManager, cwd: state.dir })) {
    try {
      ctx.llm.registerAdapter([ownAdapter.providerId], ownAdapter)
    } catch (error) {
      ctx.logger.warn(`ally ${ownAdapter.providerId} provider registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  runtime = createAllianceRuntime({
    sessions: ctx.sessions,
    agents: ctx.agents,
    gateway,
    state,
    isAgentLoopRequest,
    llm: ctx.llm,
  })
  ctx.on('llm/stream', (options, next) => runtime.route(options, next))

  const requireAllianceSession = (sessionId) => {
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error('会话不存在或当前未加载')
      error.code = 'SESSION_NOT_FOUND'
      throw error
    }
    authorize(session)
  }

  const routes = {
    'GET /ally/snapshot': async (req, res, url) => {
      if (!trustedRead(req)) return sendJson(res, 403, { error: '拒绝非可信请求' })
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      sendJson(res, 200, await runtime.snapshot(sessionId))
    },
    'POST /ally/select': async (req, res) => {
      if (!trustedMutation(req)) return sendJson(res, 403, { error: '拒绝非同源请求' })
      sendJson(res, 200, await runtime.select(await readJson(req)))
    },
    'GET /ally/model-diag': async (req, res, url) => {
      if (!trustedRead(req)) return sendJson(res, 403, { error: '拒绝非可信请求' })
      const provider = url.searchParams.get('provider') ?? 'devin'
      const model = url.searchParams.get('model') ?? 'swe-2'
      const out = { provider, model }
      try {
        const listed = await ctx.llm.listModels(provider)
        out.count = listed?.length
        out.swe = (listed ?? []).filter((m) => m.id.startsWith('swe')).map((m) => ({ id: m.id, efforts: m.supportedReasoningEfforts }))
      } catch (error) { out.listError = String(error?.message ?? error) }
      if (provider === DEVIN_PROVIDER && devinModelAdapter) {
        try {
          const raw = await devinModelAdapter.listModels()
          out.rawCount = raw?.length
          out.rawWindows = (raw ?? []).filter((m) => m.contextWindow).length
          const hit = (raw ?? []).find((m) => m.id === model)
          out.rawEntry = hit ?? null
        } catch (error) { out.rawError = String(error?.message ?? error) }
      }
      try { out.resolved = await ctx.llm.resolveModelInfo(provider, model) } catch (error) { out.resolveError = String(error?.message ?? error) }
      out.projectionCacheShim = shimStatus()
      sendJson(res, 200, out)
    },
    'GET /ally/cli-status': async (req, res, url) => {
      if (!trustedRead(req)) return sendJson(res, 403, { error: '拒绝非可信请求' })
      const sessionId = url.searchParams.get('sessionId')
      if (!sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      await requireAllianceSession(sessionId)
      sendJson(res, 200, { harnesses: await cliManager.status() })
    },
    'POST /ally/cli-install': async (req, res) => {
      if (!trustedMutation(req)) return sendJson(res, 403, { error: '拒绝非同源请求' })
      const { sessionId, harness } = await readJson(req)
      if (typeof sessionId !== 'string' || !sessionId) return sendJson(res, 400, { error: '缺少 sessionId' })
      if (harness === 'dsh' || !HARNESSES.includes(harness)) {
        return sendJson(res, 400, { error: '未知 Harness CLI' })
      }
      await requireAllianceSession(sessionId)
      // 不 await:npm install 经常跑 30-60s+,dsh-bridge 隧道 + 公网代理默认
      // 请求超时通常 30-60s,会返回 504。改为 fire-and-forget:install() 同步标记
      // installs Map,status() 立刻看到 installing=true;后台继续 install,
      // 客户端 UI 显示"安装中",完成后由 BroadcastChannel 或
      // 下一次 status 轮询触发 UI 更新。
      cliManager.install(harness).catch(() => {})
      sendJson(res, 200, { harnesses: await cliManager.status() })
    },
  }

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: '/ally',
      handler: async (req, res) => {
        const url = new URL(req.url, 'http://localhost')
        const route = routes[`${req.method} ${url.pathname}`]
        if (!route) return sendJson(res, 404, { error: 'unknown ally route' })
        try {
          await route(req, res, url)
        } catch (error) {
          ctx.logger.warn(`ally request failed: ${error instanceof Error ? error.message : String(error)}`)
          const status = errorStatus(error)
          sendJson(res, status, { error: status === 500 ? 'Harness 联盟服务失败' : error instanceof Error ? error.message : String(error) })
        }
      },
    }),
    'ally.webServer.register(/ally)',
  )
}
