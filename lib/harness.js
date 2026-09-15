import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { createAsyncQueue } from './async-queue.js'
import { attachBridgeUsage, openModelBridgeRoute } from './bridge.js'
import { startCodexAppServerRun } from './codex-app-server.js'
import { startDevinAcpRun } from './devin-acp.js'
import { CLAUDE_OWN_PROVIDER, CLI_CONFIG_MODEL_ID } from './cli-own-models.js'
import { filePathFallback, requestFileInputs, requestImageInputs, resolveFileInputs, resolveImageInputs } from './image-input.js'
import { startKimiAcpRun } from './kimi-acp.js'
import { commandFromToolInput, pathsFromToolInput, summaryFromToolInput } from './work-ledger.js'

const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const DISPOSE_GRACE_MS = 3000
const CLAUDE_INVALID_RESUME = /No conversation found with session ID|--resume session load failed|Failed to resume session/i
const CLAUDE_UNKNOWN_BARE = /unknown option ['"`]?--bare/i

function emitText(state, text) {
  if (typeof text !== 'string' || !text) return
  state.emittedText += text
  state.stream.push({ type: 'text-delta', text })
}

function emitReasoning(state, text) {
  if (typeof text !== 'string' || !text) return
  state.stream.push({ type: 'reasoning-delta', text })
}

function emitToolActivity(state, block) {
  if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !block.name) return
  const paths = pathsFromToolInput(block.input)
  const command = commandFromToolInput(block.input)
  const activity = {
    type: 'activity',
    id: typeof block.id === 'string' ? block.id : '',
    name: block.name,
    summary: summaryFromToolInput(block.input),
    ...(command ? { command } : {}),
    ...(paths.length ? { paths } : {}),
  }
  if (activity.id) state.toolActivities.set(activity.id, activity)
  state.stream.push({ ...activity, status: 'running' })
}

function emitToolResultActivity(state, block) {
  if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') return
  const activity = state.toolActivities.get(block.tool_use_id)
  if (!activity) return
  state.stream.push({ ...activity, status: block.is_error ? 'failed' : 'completed' })
}

const ADAPTERS = Object.freeze({
  'claude-code': {
    provider: 'ally-claude-code',
    command: 'claude',
    argv(executable, model, bridge, nativeSession, hasImages, dropBare) {
      return [
        executable,
        '-p',
        ...(bridge ? [
          // --bare 是较新 claude 版本才有的 flag(跳过 hooks/plugins/mcp 加载);
          // 老版本报 "unknown option '--bare'" 时由 spawnAttempt 降级重试。
          ...(dropBare ? [] : ['--bare']),
          '--settings', JSON.stringify({ env: { ANTHROPIC_BASE_URL: bridge.claudeBaseUrl } }),
        ] : []),
        // 带图片时 stdin 发送一条 stream-json user 消息(image source block);
        // 无图片保持原有纯文本输入。
        '--input-format', hasImages ? 'stream-json' : 'text',
        '--output-format', 'stream-json',
        '--verbose',
        '--include-partial-messages',
        ...(nativeSession
          ? nativeSession.mode === 'resume'
            ? ['--resume', nativeSession.vendorId]
            : ['--session-id', randomUUID()]
          : ['--no-session-persistence']),
        '--permission-mode', 'bypassPermissions',
        ...(model ? ['--model', model] : []),
      ]
    },
    accept(event, state, nativeSession) {
      if (event.type === 'system' && event.subtype === 'init' && typeof event.session_id === 'string' && event.session_id) {
        state.nativeInitSeen = true
        nativeSession?.adopt(event.session_id)
      }
      const parentToolUseId = event.parent_tool_use_id ?? event.parentToolUseId
      if (event.type === 'stream_event' && !parentToolUseId) {
        const nativeEvent = event.event
        if (nativeEvent?.type === 'message_start') state.currentMessageText = ''
        if (nativeEvent?.type === 'content_block_delta'
          && nativeEvent.delta?.type === 'text_delta'
          && typeof nativeEvent.delta.text === 'string') {
          state.currentMessageText += nativeEvent.delta.text
          emitText(state, nativeEvent.delta.text)
        }
        if (nativeEvent?.type === 'content_block_delta'
          && nativeEvent.delta?.type === 'thinking_delta') {
          emitReasoning(state, nativeEvent.delta.thinking)
        }
      }
      if (event.type === 'user' && !parentToolUseId && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) emitToolResultActivity(state, block)
      }
      if (event.type === 'assistant' && !parentToolUseId && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) emitToolActivity(state, block)
        const text = event.message.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('')
        if (text.startsWith(state.currentMessageText)) emitText(state, text.slice(state.currentMessageText.length))
        else if (!state.currentMessageText) emitText(state, text)
        state.currentMessageText = ''
        if (text) state.completedText += text
        if (state.completedText) state.text = state.completedText
      }
      if (event.type === 'result') {
        if (Array.isArray(event.errors) && event.errors.some((error) => typeof error === 'string' && CLAUDE_INVALID_RESUME.test(error))) {
          state.invalidResumeError = true
        }
        if (state.completedText) state.text = state.completedText
        else if (state.emittedText) state.text = state.emittedText
        else if (typeof event.result === 'string' && event.result) state.text = event.result
        if (event.is_error || (event.subtype && event.subtype !== 'success')) {
          state.failed = true
          if (typeof event.subtype === 'string' && event.subtype) state.resultSubtype = event.subtype
        }
      }
    },
  },
  codex: {
    provider: 'ally-codex',
    command: 'codex',
  },
  'kimi-code': {
    provider: 'ally-kimi-code',
    command: 'kimi',
  },
  devin: {
    provider: 'ally-devin',
    command: 'devin',
  },
})

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

function parseLine(adapter, line, state, nativeSession) {
  if (!line.trim()) return
  try {
    adapter.accept(JSON.parse(line), state, nativeSession)
  } catch {
    state.protocolErrors += 1
  }
}

async function startProcessRun(deps, harness, request) {
  const { subprocess, sandbox, policyFor, authorize, bridge } = deps
  const adapter = ADAPTERS[harness]
  if (!adapter) throw new Error(`unknown Harness ${String(harness)}`)
  const signal = request.signal ?? new AbortController().signal
  if (signal.aborted) throw new Error(`${harness} delegation aborted before spawn`)
  const session = request.parent?.session
  authorize(session)
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new Error(`${harness} delegation requires a parent workspace`)
  const images = requestImageInputs(request)
  const files = requestFileInputs(request)
  const textBlocks = (request.prompt ?? []).filter((block) => block?.type !== 'image' && block?.type !== 'file')
  let initialPrompt = request.nativeSession?.prompt ?? (textBlocks.length ? promptText(textBlocks) : '')
  if (typeof initialPrompt !== 'string' || (!initialPrompt.trim() && images.length === 0 && files.length === 0)) {
    throw new Error('Harness task must not be empty')
  }
  if (!initialPrompt.trim()) initialPrompt = images.length ? 'See the attached image(s).' : 'See the attached file(s).'
  const resolvedImages = images.length ? await resolveImageInputs(deps, images) : []
  // 文件引用必须在最终选定的 prompt(nativeSession.prompt 可能在 resume
  // fallback 时被重写)上追加,所以这里只解析,到发 stdin 前再拼。
  const resolvedFiles = files.length ? await resolveFileInputs(deps, files) : []
  const policy = policyFor(session)
  const executable = deps.cliManager
    ? await deps.cliManager.resolve(harness)
    : await subprocess.resolveExecutable(adapter.command)
  // provider 'claude-code' = 用 CLI 自有配置:不开 bridge、不指托管
  // config 目录,让子进程读用户真实的 ~/.claude(CCSwitch 等写入的
  // endpoint/凭据/model 全部生效)。
  const ownConfig = request.provider === CLAUDE_OWN_PROVIDER
  const bridgeRoute = ownConfig ? undefined : await openModelBridgeRoute(bridge, request, session.id)
  let managedHome
  if (request.nativeSession && !ownConfig && typeof deps.stateDir === 'string') {
    managedHome = join(deps.stateDir, 'native', 'claude')
    await (deps.makeDirectory ?? mkdir)(managedHome, { recursive: true, mode: 0o700 })
  }
  const stream = createAsyncQueue()
  const state = {
    text: '',
    emittedText: '',
    completedText: '',
    currentMessageText: '',
    toolActivities: new Map(),
    stream,
    failed: false,
    protocolErrors: 0,
    nativeInitSeen: false,
    invalidResumeError: false,
  }
  let currentChild
  let disposing = false
  let routeClosed = false
  let disposal
  const closeRoute = () => {
    if (routeClosed) return
    routeClosed = true
    bridgeRoute?.close()
  }

  const spawnAttempt = (dropBare) => {
    const nativeArgv = adapter.argv(executable, ownConfig && request.model === CLI_CONFIG_MODEL_ID ? undefined : request.model, bridgeRoute, request.nativeSession, resolvedImages.length > 0, dropBare)
    let argv = nativeArgv
    // Windows: DSH subprocess 直接 child_process.spawn,不带 shell:true,
    // 启动 .cmd 会抛 spawn EINVAL。把 .cmd 替换成真实可执行文件;
    // 优先读 package.json 的 bin 字段,避免不同版本入口路径变化导致硬编码失效。
    //   claude.cmd -> @anthropic-ai/claude-code 的 bin 入口(目前是 bin/claude.exe)
    //   codex.cmd  -> @openai/codex 的 bin 入口(目前是 bin/codex.js,需 node 跑)
    //   kimi.cmd   -> @moonshot-ai/kimi-code 的 bin 入口(0.39.x 是 dist/main.mjs)
    // executable 两种 layout:
    //   全局: <prefix>/<cmd>.cmd                → nodes=dirname(executable)+'/node_modules'
    //   托管: <prefix>/node_modules/.bin/<cmd>.cmd → nodes=dirname(dirname(executable))(本身就是 node_modules)
    if (process.platform === 'win32' && typeof executable === 'string' && executable.toLowerCase().endsWith('.cmd')) {
      const cmdDir = dirname(executable)
      const base = cmdDir.toLowerCase().endsWith(`${sep}.bin`) ? dirname(cmdDir) : cmdDir
      const nodes = base.toLowerCase().endsWith(`${sep}node_modules`) ? base : join(base, 'node_modules')
      const PKG_ROOTS = {
        'claude-code': join(nodes, '@anthropic-ai', 'claude-code'),
        codex: join(nodes, '@openai', 'codex'),
        'kimi-code': join(nodes, '@moonshot-ai', 'kimi-code'),
      }
      const PKG_DEFAULTS = {
        'claude-code': join(PKG_ROOTS['claude-code'], 'bin', 'claude.exe'),
        codex: join(PKG_ROOTS.codex, 'bin', 'codex.js'),
        'kimi-code': join(PKG_ROOTS['kimi-code'], 'dist', 'main.mjs'),
      }
      const pkgRoot = PKG_ROOTS[harness]
      let entry = PKG_DEFAULTS[harness]
      if (pkgRoot && entry) {
        try {
          const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'))
          const binField = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values(pkg.bin)[0]
          if (binField) entry = join(pkgRoot, binField)
        } catch {}
        if (entry.endsWith('.js')) {
          argv = [process.execPath, entry, ...nativeArgv.slice(1)]
        } else {
          argv = [entry, ...nativeArgv.slice(1)]
        }
      }
    }
    // alliance 模式下 DSH core 给出的 sandbox policy 经常不是 danger-full-access,
    // policyFor 返回的是 session 级策略而非 profile preset 默认值;直接走 nativeArgv,
    // 外层 sandbox 由 ctx.sandboxPolicy 在更高层保证。
    const env = {
      ...(bridgeRoute ? {
        ANTHROPIC_BASE_URL: bridgeRoute.claudeBaseUrl,
        ANTHROPIC_API_KEY: bridgeRoute.token,
        ANTHROPIC_AUTH_TOKEN: bridgeRoute.token,
      } : {}),
      ...(managedHome ? { CLAUDE_CONFIG_DIR: managedHome } : {}),
    }
    const child = subprocess.spawn({
      argv,
      cwd,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs: DISPOSE_GRACE_MS,
      signal,
      env,
    })
    currentChild = child
    state.nativeInitSeen = false
    state.invalidResumeError = false
    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdoutBuffer = ''
    let stderrBuffer = ''
    child.stdout?.on('data', (chunk) => {
      stdoutBuffer += stdoutDecoder.write(chunk)
      if (Buffer.byteLength(stdoutBuffer) > MAX_LINE_BYTES) {
        state.failed = true
        stdoutBuffer = ''
        child.terminate()
        return
      }
      let newline
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline)
        stdoutBuffer = stdoutBuffer.slice(newline + 1)
        parseLine(adapter, line, state, request.nativeSession)
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (Buffer.byteLength(stderrBuffer) >= MAX_STDERR_BYTES) return
      stderrBuffer += stderrDecoder.write(chunk)
      if (Buffer.byteLength(stderrBuffer) > MAX_STDERR_BYTES) stderrBuffer = stderrBuffer.slice(-MAX_STDERR_BYTES)
    })
    child.stdin?.on('error', () => {})
    const basePrompt = request.nativeSession?.prompt ?? initialPrompt
    const prompt = resolvedFiles.length ? filePathFallback(basePrompt, resolvedFiles) : basePrompt
    if (resolvedImages.length > 0) {
      const content = [
        ...resolvedImages.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })),
        { type: 'text', text: prompt },
      ]
      child.stdin?.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`)
    } else {
      child.stdin?.end(prompt)
    }
    return Promise.resolve(child.done).then((outcome) => {
      stdoutBuffer += stdoutDecoder.end()
      stderrBuffer += stderrDecoder.end()
      if (stdoutBuffer.trim()) parseLine(adapter, stdoutBuffer, state, request.nativeSession)
      return { outcome, stderr: stderrBuffer }
    }, (error) => ({ error, stderr: stderrBuffer }))
  }

  let firstAttempt
  try {
    firstAttempt = spawnAttempt()
  } catch (error) {
    closeRoute()
    throw error
  }

  const result = (async () => {
    let attempt = await firstAttempt
    let droppedBare = false
    if (bridgeRoute && attempt.outcome?.exitCode !== 0 && !attempt.error && CLAUDE_UNKNOWN_BARE.test(attempt.stderr)) {
      droppedBare = true
      state.failed = false
      state.protocolErrors = 0
      attempt = await spawnAttempt(true)
    }
    const invalidResume = request.nativeSession?.mode === 'resume'
      && !state.nativeInitSeen
      && !state.emittedText
      && !state.completedText
      && !attempt.error
      && attempt.outcome?.exitCode !== 0
      && (state.invalidResumeError || CLAUDE_INVALID_RESUME.test(attempt.stderr))
      && !signal.aborted
      && !disposing
    if (invalidResume) {
      await request.nativeSession.fallback()
      state.failed = false
      state.protocolErrors = 0
      attempt = await spawnAttempt(droppedBare)
    }
    if (signal.aborted || disposing) {
      return { output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'aborted' }
    }
    if (attempt.error) return { output: [], stopReason: 'error', diagnostic: `${harness} 进程启动失败` }
    if (state.failed || attempt.outcome?.exitCode !== 0) {
      const subtype = state.resultSubtype ? `：${state.resultSubtype}` : ''
      return {
        output: state.text ? [{ type: 'text', text: state.text }] : [],
        stopReason: 'error',
        diagnostic: `${harness} 执行失败（exit ${String(attempt.outcome?.exitCode)}${subtype}）`,
      }
    }
    if (!state.text && state.protocolErrors > 0) {
      return { output: [], stopReason: 'error', diagnostic: `${harness} 返回了无法解析的响应` }
    }
    return { output: state.text ? [{ type: 'text', text: state.text }] : [], stopReason: 'completed' }
  })()
    .then((value) => attachBridgeUsage(bridgeRoute, value))
    .finally(() => {
      stream.end()
      closeRoute()
    })

  return {
    id: `${adapter.provider}-${randomUUID()}`,
    stream,
    result,
    dispose() {
      if (!disposal) disposal = (async () => {
        disposing = true
        closeRoute()
        currentChild?.terminate()
        if (currentChild) {
          await currentChild.waitForExit()
          await currentChild.done.catch(() => {})
        }
      })()
      return disposal
    },
  }
}

export function createHarnessGateway(deps) {
  function startAdapter(harness, request) {
    if (harness === 'codex') return startCodexAppServerRun(deps, request)
    if (harness === 'kimi-code') return startKimiAcpRun(deps, request)
    if (harness === 'devin') return startDevinAcpRun(deps, request)
    return startProcessRun(deps, harness, request)
  }

  function start(harness, request) {
    const session = request.parent?.session
    const cwd = session?.header?.cwd
    const incrementalPrompt = request.incrementalPrompt
    if (!deps.nativeSessions
      || typeof session?.id !== 'string'
      || typeof cwd !== 'string'
      || typeof request.provider !== 'string'
      || typeof request.model !== 'string'
      || typeof request.promptSignature !== 'string'
      || !Number.isSafeInteger(request.turn)
      || !Array.isArray(incrementalPrompt)) {
      return startAdapter(harness, request)
    }
    deps.authorize(session)
    const policy = deps.policyFor(session)
    return deps.nativeSessions.start({
      sessionId: session.id,
      harness,
      provider: request.provider,
      model: request.model,
      cwd,
      policyMode: policy.mode,
      workspaceRoot: policy.workspaceRoot,
      promptSignature: request.promptSignature,
      turn: request.turn,
      fullPrompt: promptText(request.prompt),
      incrementalPrompt: promptText(incrementalPrompt),
      conversation: request.conversation,
    }, (nativeSession) => startAdapter(harness, {
      ...request,
      prompt: [{ type: 'text', text: nativeSession.prompt }],
      nativeSession,
    }))
  }

  function provider(harness) {
    const adapter = ADAPTERS[harness]
    if (!adapter) throw new Error(`unknown Harness ${String(harness)}`)
    return {
      name: adapter.provider,
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start(request) {
        return start(harness, request)
      },
    }
  }

  async function available(harness) {
    const adapter = ADAPTERS[harness]
    if (!adapter) return false
    try {
      if (deps.cliManager) await deps.cliManager.resolve(harness)
      else await deps.subprocess.resolveExecutable(adapter.command)
      return true
    } catch {
      return false
    }
  }

  return {
    provider,
    providers: Object.keys(ADAPTERS).map((harness) => provider(harness)),
    start,
    available,
    async availability() {
      const [claude, codex, kimi, devin] = await Promise.all([
        available('claude-code'),
        available('codex'),
        available('kimi-code'),
        available('devin'),
      ])
      return { 'claude-code': claude, codex, 'kimi-code': kimi, devin }
    },
  }
}
