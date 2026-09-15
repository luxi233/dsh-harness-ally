import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { DEVIN_PROVIDER } from './devin-models.js'
import { filePathFallback, FILE_UNRESOLVABLE, imagePathFallback, IMAGE_UNRESOLVABLE, requestFileInputs, requestImageInputs, resolveFileInputs, resolveImageInputs } from './image-input.js'
import { ALLY_VERSION } from './version.js'
import { commandFromToolInput, pathsFromToolInput, summaryFromToolInput } from './work-ledger.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const DISPOSE_GRACE_MS = 3000
const CANCEL_GRACE_MS = 1000
// Devin 的 ACP mode configOption 取值随版本变化;按"自动放行程度"从高到低挑一个存在的。
// 找不到时跳过 set_config_option,由 session/request_permission 的 allow_once 兜底。
const DEVIN_MODE_PREFERENCE = Object.freeze([
  'dangerous', 'bypass', 'yolo', 'accept-edits', 'acceptEdits', 'accept_edits', 'smart', 'auto',
])
const AUTH_FAILURE = /auth|api.?key|credential|login|permission denied|forbidden/i

function promptText(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error('Harness task must contain text')
  const texts = []
  for (const block of blocks) {
    if (block?.type !== 'text' || typeof block.text !== 'string') {
      throw new Error('Harness task currently supports text blocks only')
    }
    texts.push(block.text)
  }
  const text = texts.join('\n')
  if (!text.trim()) throw new Error('Harness task must not be empty')
  return text
}

function activityName(kind, title) {
  const names = {
    execute: 'Bash',
    edit: 'Edit',
    read: 'Read',
    fetch: 'WebSearch',
    search: 'Search',
    think: 'Think',
  }
  return names[kind] ?? (typeof title === 'string' && title.trim() ? title.trim() : 'Tool')
}

function activityForUpdate(update) {
  if (!update || typeof update.toolCallId !== 'string' || !update.toolCallId) return undefined
  const title = typeof update.title === 'string' ? update.title.trim() : ''
  const name = activityName(update.kind, title)
  const input = summaryFromToolInput(update.rawInput)
  const summary = title && title !== name ? title : input
  const command = commandFromToolInput(update.rawInput)
  const paths = pathsFromToolInput(update.rawInput)
  return {
    type: 'activity',
    id: update.toolCallId,
    name,
    summary,
    ...(command ? { command } : {}),
    ...(paths.length ? { paths } : {}),
    status: update.status === 'completed' || update.status === 'failed' ? update.status : 'running',
  }
}

// Devin 的 ACP server 不读本地凭据,要求 host 主动调 authenticate:
//   authenticate { methodId: 'devin-browser', _meta: { api_key } }
// api_key 来自 devin auth login 落盘的 credentials.toml(或 DEVIN_API_KEY /
// WINDSURF_API_KEY 环境变量)。没有 key 时仍尝试 session/new——旧版本可能允许
// 本地凭据直通;失败再报"未登录"。
function devinApiKey(deps) {
  const env = deps.env ?? process.env
  const direct = env.DEVIN_API_KEY ?? env.WINDSURF_API_KEY
  if (typeof direct === 'string' && direct.trim()) return direct.trim()
  const read = deps.readTextFile ?? ((path) => readFileSync(path, 'utf8'))
  const home = deps.homedir ?? homedir()
  const candidates = [
    typeof env.XDG_DATA_HOME === 'string' && env.XDG_DATA_HOME
      ? join(env.XDG_DATA_HOME, 'devin', 'credentials.toml')
      : undefined,
    join(home, '.local', 'share', 'devin', 'credentials.toml'),
  ]
  for (const path of candidates) {
    if (!path) continue
    try {
      const text = read(path)
      const match = /^\s*(?:windsurf_api_key|api_key)\s*=\s*["']([^"']+)["']/m.exec(text)
      if (match?.[1]?.trim()) return match[1].trim()
    } catch {}
  }
  return undefined
}

export async function startDevinAcpRun(deps, request) {
  const { subprocess, authorize } = deps
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error('devin delegation aborted before spawn')
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error('devin delegation requires a parent workspace')
  const images = requestImageInputs(request)
  const files = requestFileInputs(request)
  const textBlocks = (request.prompt ?? []).filter((block) => block?.type !== 'image' && block?.type !== 'file')
  let prompt = request.nativeSession?.prompt ?? (textBlocks.length ? promptText(textBlocks) : '')
  if (typeof prompt !== 'string' || (!prompt.trim() && images.length === 0 && files.length === 0)) throw new Error('Harness task must not be empty')
  if (!prompt.trim()) prompt = images.length ? 'See the attached image(s).' : 'See the attached file(s).'
  const resolvedFiles = files.length ? await resolveFileInputs(deps, files) : []
  if (resolvedFiles.length) prompt = filePathFallback(prompt, resolvedFiles)
  const executable = deps.cliManager
    ? await deps.cliManager.resolve('devin')
    : await subprocess.resolveExecutable('devin')
  const apiKey = devinApiKey(deps)
  // 模型选择器里 devin provider 的模型翻译成 `devin acp --model`;
  // 其它 provider 的模型对 Devin 无意义,不透传。
  const argv = [executable, 'acp']
  if (request.provider === DEVIN_PROVIDER && typeof request.model === 'string' && request.model) {
    argv.push('--model', request.model)
  }

  const child = subprocess.spawn({
    argv,
    cwd,
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
    graceMs: DISPOSE_GRACE_MS,
    env: {},
  })

  const stream = createAsyncQueue()
  const state = {
    text: '',
    stream,
    toolUpdates: new Map(),
    activitySnapshots: new Map(),
    protocolErrors: 0,
  }
  const pending = new Map()
  const decoder = new StringDecoder('utf8')
  let stdoutBuffer = ''
  let nextRequestId = 1
  let sessionId
  const noteSession = (value) => {
    sessionId = value
    if (typeof value === 'string' && value) request.nativeSession?.adopt(value)
  }
  let phase = 'initialize'
  let settled = false
  let disposing = false
  let gracefulExitRequested = false
  let cancelTimer
  let abortListener
  let disposal
  let resolveResult
  const result = new Promise((resolve) => { resolveResult = resolve })

  const rejectPending = () => {
    for (const waiter of pending.values()) waiter.reject(new Error('devin ACP closed'))
    pending.clear()
  }
  const settle = (value, terminate) => {
    if (settled) return
    settled = true
    if (cancelTimer) clearTimeout(cancelTimer)
    if (abortListener) signal.removeEventListener('abort', abortListener)
    stream.end()
    rejectPending()
    resolveResult(value)
    if (terminate) child.terminate()
  }
  const writeMessage = (message) => {
    if (settled) return false
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
    return true
  }
  const sendRequest = (method, params) => {
    if (settled) return Promise.reject(new Error('devin ACP already settled'))
    const id = nextRequestId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    writeMessage({ id, method, params })
    return response
  }
  const sendNotification = (method, params) => writeMessage({ method, params })
  const cancel = () => {
    if (settled) return
    if (sessionId) {
      sendNotification('session/cancel', { sessionId })
      cancelTimer = setTimeout(() => child.terminate(), CANCEL_GRACE_MS)
    } else {
      child.terminate()
    }
  }

  const handleServerRequest = (message) => {
    if (message.method === 'session/request_permission') {
      if (phase === 'session-load' || !sessionId || message.params?.sessionId !== sessionId) {
        writeMessage({ id: message.id, result: { outcome: { outcome: 'cancelled' } } })
        return
      }
      const options = Array.isArray(message.params?.options) ? message.params.options : []
      const allowOnce = options.find((option) => option?.kind === 'allow_once')
      // 与 kimi adapter 同一策略:canonical 工具审批(带 allow_always)自动
      // allow_once;计划评审/提问类请求不替用户作答。DSH 已在外层授权并
      // 限制该子进程。
      const offersCanonicalToolApproval = options.some((option) => option?.kind === 'allow_always')
      const outcome = offersCanonicalToolApproval && allowOnce?.optionId
        ? { outcome: 'selected', optionId: allowOnce.optionId }
        : { outcome: 'cancelled' }
      writeMessage({ id: message.id, result: { outcome } })
      return
    }
    writeMessage({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } })
  }

  const onUpdate = (params) => {
    if (phase === 'session-load' || !sessionId || params?.sessionId !== sessionId) return
    const update = params.update
    if (update?.sessionUpdate === 'agent_message_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      state.text += update.content.text
      state.stream.push({ type: 'text-delta', text: update.content.text })
      return
    }
    if (update?.sessionUpdate === 'agent_thought_chunk'
      && update.content?.type === 'text'
      && typeof update.content.text === 'string'
      && update.content.text) {
      state.stream.push({ type: 'reasoning-delta', text: update.content.text })
      return
    }
    if (update?.sessionUpdate === 'tool_call' || update?.sessionUpdate === 'tool_call_update') {
      if (typeof update.toolCallId !== 'string' || !update.toolCallId) return
      const merged = { ...(state.toolUpdates.get(update.toolCallId) ?? {}), ...update }
      state.toolUpdates.set(update.toolCallId, merged)
      const activity = activityForUpdate(merged)
      if (!activity) return
      const snapshot = `${activity.name} ${activity.summary} ${activity.status}`
      if (state.activitySnapshots.get(activity.id) === snapshot) return
      state.activitySnapshots.set(activity.id, snapshot)
      state.stream.push(activity)
    }
  }

  const onMessage = (message) => {
    const hasId = Number.isSafeInteger(message?.id) || (typeof message?.id === 'string' && Boolean(message.id))
    if (hasId && pending.has(message.id) && typeof message.method !== 'string') {
      const waiter = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error?.message ?? 'devin ACP request failed'))
      else waiter.resolve(message.result)
      return
    }
    if (hasId && typeof message.method === 'string') {
      handleServerRequest(message)
      return
    }
    if (message?.method === 'session/update') onUpdate(message.params)
  }
  const parseLine = (line) => {
    if (!line.trim()) return
    try {
      onMessage(JSON.parse(line))
    } catch {
      state.protocolErrors += 1
    }
  }
  child.stdout?.on('data', (chunk) => {
    stdoutBuffer += decoder.write(chunk)
    if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES) {
      settle({ output: [], stopReason: 'error', diagnostic: 'Devin ACP 返回了过大的响应' }, true)
      return
    }
    let newline
    while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
      const line = stdoutBuffer.slice(0, newline)
      stdoutBuffer = stdoutBuffer.slice(newline + 1)
      parseLine(line)
    }
  })
  child.stderr?.on('data', () => {})
  child.stdin?.on('error', () => {})

  abortListener = cancel
  signal.addEventListener('abort', abortListener, { once: true })
  if (signal.aborted) cancel()

  child.done.then((outcome) => {
    stdoutBuffer += decoder.end()
    if (stdoutBuffer.trim()) parseLine(stdoutBuffer)
    if (settled) return
    if (signal.aborted || disposing) {
      settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
    } else {
      settle({
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: 'error',
        diagnostic: `Devin ACP 提前退出（exit ${String(outcome.exitCode)}）`,
      }, false)
    }
  }, () => {
    settle({
      output: state.text ? [{ type: 'text', text: state.text }] : [],
      stopReason: signal.aborted || disposing ? 'aborted' : 'error',
      ...(signal.aborted || disposing ? {} : { diagnostic: 'Devin ACP 进程启动失败' }),
    }, false)
  })

  void (async () => {
    try {
      const initialized = await sendRequest('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'dsh-ally', version: ALLY_VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      if (apiKey) {
        phase = 'authenticate'
        await sendRequest('authenticate', {
          methodId: 'devin-browser',
          _meta: { api_key: apiKey },
        })
      }
      phase = 'session'
      const nativeSession = request.nativeSession
      const canResume = initialized?.agentCapabilities?.loadSession === true
      let created
      if (nativeSession?.mode === 'resume' && canResume) {
        try {
          phase = 'session-load'
          sessionId = nativeSession.vendorId
          created = await sendRequest('session/load', {
            sessionId: nativeSession.vendorId,
            cwd,
            mcpServers: [],
          })
          noteSession(created?.sessionId ?? nativeSession.vendorId)
        } catch (error) {
          if (signal.aborted || disposing) throw error
          await nativeSession.fallback()
          prompt = nativeSession.prompt
          if (resolvedFiles.length) prompt = filePathFallback(prompt, resolvedFiles)
        }
      } else if (nativeSession?.mode === 'resume') {
        await nativeSession.fallback()
        prompt = nativeSession.prompt
        if (resolvedFiles.length) prompt = filePathFallback(prompt, resolvedFiles)
      }
      if (!created) {
        created = await sendRequest('session/new', { cwd, mcpServers: [] })
        noteSession(created?.sessionId)
      }
      if (typeof sessionId !== 'string' || !sessionId) throw new Error('Devin ACP returned no session id')
      const modeOption = Array.isArray(created.configOptions)
        ? created.configOptions.find((option) => option?.id === 'mode')
        : undefined
      const preferredMode = Array.isArray(modeOption?.options)
        ? DEVIN_MODE_PREFERENCE.find((value) => modeOption.options.some((option) => option?.value === value))
        : undefined
      if (preferredMode) {
        // 非致命:设置失败时由 session/request_permission 的 allow_once 兜底。
        try {
          await sendRequest('session/set_config_option', { sessionId, configId: 'mode', value: preferredMode })
        } catch {}
      }
      // 图片输入:agent 声明 promptCapabilities.image 时走原生 image block;
      // 否则退化为宿主文件路径引用,让模型用自己的读文件工具查看。
      let imageBlocks = []
      if (images.length) {
        const resolved = await resolveImageInputs(deps, images)
        if (initialized?.agentCapabilities?.promptCapabilities?.image === true) {
          imageBlocks = resolved.map((image) => ({ type: 'image', data: image.data, mimeType: image.mediaType }))
        } else {
          prompt = imagePathFallback(prompt, resolved)
        }
      }
      phase = 'prompt'
      const response = await sendRequest('session/prompt', {
        sessionId,
        prompt: [...imageBlocks, { type: 'text', text: prompt }],
      })
      const output = state.text ? [{ type: 'text', text: state.text }] : []
      if (response?.stopReason === 'cancelled' || signal.aborted || disposing) {
        settle({ output, stopReason: 'aborted' }, true)
      } else if (response?.stopReason === 'end_turn') {
        gracefulExitRequested = true
        child.stdin?.end()
        settle({ output, stopReason: 'completed' }, false)
      } else {
        settle({ output, stopReason: 'error', diagnostic: 'Devin ACP 执行失败' }, true)
      }
    } catch (error) {
      const message = String(error instanceof Error ? error.message : error)
      const authFailure = AUTH_FAILURE.test(message)
      const diagnostics = {
        initialize: 'Devin ACP 握手失败',
        authenticate: 'Devin CLI 认证失败，请重新运行 devin auth login 或更新 DEVIN_API_KEY',
        session: 'Devin ACP 会话创建失败',
        'session-load': 'Devin ACP 会话创建失败',
        prompt: 'Devin ACP 回合失败',
      }
      // 附件解析失败保留具体诊断(无法解析图片/文件附件),其余按 phase 归纳。
      const attachmentFailure = message === IMAGE_UNRESOLVABLE || message === FILE_UNRESOLVABLE ? message : undefined
      settle({
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: signal.aborted || disposing ? 'aborted' : 'error',
        ...(signal.aborted || disposing ? {} : {
          diagnostic: authFailure
            ? 'Devin CLI 未登录或凭据失效：请先运行 devin auth login（或设置 DEVIN_API_KEY）'
            : attachmentFailure ?? diagnostics[phase] ?? 'Devin ACP 执行失败',
        }),
      }, true)
    }
  })()

  return {
    id: `ally-devin-${randomUUID()}`,
    stream,
    result,
    dispose() {
      if (!disposal) disposal = (async () => {
        disposing = true
        if (!settled) cancel()
        if (gracefulExitRequested) {
          const flushTimeoutMs = Number.isFinite(deps.sessionFlushTimeoutMs) ? deps.sessionFlushTimeoutMs : 1_000
          const exited = await child.waitForExit(AbortSignal.timeout(Math.max(1, flushTimeoutMs)))
          if (!exited) {
            await request.nativeSession?.discard?.()
            child.terminate()
            await child.waitForExit()
          }
        } else {
          await child.waitForExit()
        }
        await Promise.allSettled([child.done])
        if (!settled) settle({ output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }, false)
      })()
      return disposal
    },
  }
}
