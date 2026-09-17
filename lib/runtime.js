import { createHash, randomUUID } from 'node:crypto'

import { CLAUDE_OWN_PROVIDER, CODEX_OWN_PROVIDER, KIMI_OWN_PROVIDER } from './cli-own-models.js'
import { DEVIN_PROVIDER } from './devin-models.js'
import { normalizeLedgerText, renderWorkLedger, workLedgerFromActivities } from './work-ledger.js'

export const ALLY_PRESET = 'harness-ally'
export const HARNESSES = Object.freeze(['dsh', 'claude-code', 'codex', 'kimi-code', 'devin'])
const HARNESS_LABELS = Object.freeze({ 'claude-code': 'Claude Code', codex: 'Codex', 'kimi-code': 'Kimi Code', devin: 'Devin' })
// own-config provider 与 Harness 一一绑定:选了某个 CLI 的模型时自动把
// Harness 切到该 CLI(切换失败才报错)——否则外部 CLI 会一直重试
// 打不通的 bridge 端点,回合静默空转。
const OWN_PROVIDER_HARNESSES = Object.freeze({
  [DEVIN_PROVIDER]: 'devin',
  [CLAUDE_OWN_PROVIDER]: 'claude-code',
  [CODEX_OWN_PROVIDER]: 'codex',
  [KIMI_OWN_PROVIDER]: 'kimi-code',
})
// 外部 CLI 不回报 token 用量(usage 全 0)。圆环的分子 pressureTokens
// 取最近一次 usage 的 inputTokens+cache 量,全 0 意味着外部 Harness
// 回合后圆环回落到只反映 surface 增量,严重低估——插件派发时发的
// prompts.full 本就是全量渲染历史,正好约等于 CLI 侧累积的上下文,
// 用它估算 inputTokens 比 0 更接近真实。
// 估算启发式:CJK 字符 ~1.5 字/token,其余 ~4 字符/token。
function estimateTokens(text) {
  if (typeof text !== 'string' || !text) return 0
  let cjk = 0
  for (const ch of text) if (ch.codePointAt(0) >= 0x2e80) cjk++
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4)
}
function isReportedUsage(usage) {
  return Boolean(usage) && (usage.inputTokens > 0 || usage.outputTokens > 0 || usage.contextInputTokens > 0)
}
function estimateUsage(promptText, outputText) {
  return {
    inputTokens: estimateTokens(promptText),
    outputTokens: estimateTokens(outputText),
    contextInputTokens: estimateTokens(promptText),
    contextOutputTokens: estimateTokens(outputText),
  }
}

function getSessionEvents(session) {
  if (!session) return []
  if (Array.isArray(session.events)) return session.events
  if (typeof session.snapshotEvents === 'function') {
    try { return session.snapshotEvents() } catch { return [] }
  }
  if (session.events && typeof session.events[Symbol.iterator] === 'function') return session.events
  if (Array.isArray(session.log)) return session.log
  return []
}

function selectedPreset(session) {
  let preset = session.header?.agentPreset
  for (const event of getSessionEvents(session)) {
    if (event.type === 'agent-preset/selected' && typeof event.data?.agentPreset === 'string') {
      preset = event.data.agentPreset
    }
  }
  return preset
}

export function isAllianceSession(session) {
  return Boolean(session && selectedPreset(session) === ALLY_PRESET)
}

function currentBoundary(session) {
  let turn
  let step
  for (const event of getSessionEvents(session)) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn
      step = undefined
    } else if (event.type === 'step/start' && event.data?.turn === turn) {
      step = event.data?.step
    }
  }
  return { turn, step }
}

// DSH agent-loop commits this exact turn/end reason before the next turn can start.
function completedTurns(session) {
  const outcomes = new Map()
  for (const event of getSessionEvents(session)) {
    if (event.type === 'turn/end' && Number.isSafeInteger(event.data?.turn)) {
      outcomes.set(event.data.turn, event.data?.reason?.kind)
    }
  }
  return new Set([...outcomes].filter(([, kind]) => kind === 'completed').map(([turn]) => turn))
}

function conversationProvenance(session, dispatches, currentHarness) {
  const harnessByTurn = new Map((dispatches ?? []).map((dispatch) => [dispatch.turn, HARNESS_LABELS[dispatch.harness] ?? String(dispatch.harness)]))
  const boundary = currentBoundary(session)
  if (Number.isSafeInteger(boundary.turn)) harnessByTurn.set(boundary.turn, HARNESS_LABELS[currentHarness] ?? String(currentHarness))
  const turnsByMessage = new Map()
  let activeTurn
  for (const event of getSessionEvents(session)) {
    if (event.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) activeTurn = event.data.turn
    else if (event.type === 'user/message' && typeof event.data?.id === 'string' && Number.isSafeInteger(activeTurn)) {
      turnsByMessage.set(event.data.id, activeTurn)
    } else if ((event.type === 'assistant/message' || event.type === 'tool/result')
      && typeof event.data?.message?.id === 'string'
      && Number.isSafeInteger(event.data?.turn)) {
      turnsByMessage.set(event.data.message.id, event.data.turn)
    }
  }
  return new Map([...turnsByMessage].map(([messageId, turn]) => [messageId, {
    turn,
    harness: harnessByTurn.get(turn) ?? 'DeepSeek Harness',
  }]))
}

function promptPrefix(options, harness) {
  const harnessLabel = HARNESS_LABELS[harness] ?? String(harness)
  const parts = [[
    'HARNESS INSTRUCTION',
    `The active execution Harness for this turn is ${harnessLabel}.`,
    'DeepSeek Harness (DSH) remains the host for conversation history, model selection, permissions, cancellation, and records.',
    `When asked about the current Harness or execution environment, identify ${harnessLabel} as the executor and DSH as the host.`,
    'Conversation messages may identify the execution Harness that produced them. First-person identity or memory claims belong only to that labeled Harness; never adopt them as another Harness\'s identity.',
    'Act as the selected coding Harness for this request. Use your native tools when useful.',
    'Return the final response for the user; do not describe this transport wrapper unless the user asks about the execution environment.',
  ].join('\n')]
  if (options.system) parts.push(`SYSTEM\n${options.system}`)
  return parts.join('\n\n')
}

function conversationBlockText(block, toolNames) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text') return typeof block.text === 'string' ? block.text : ''
  if (block.type === 'reasoning') return ''
  // 历史里的图片/文件必须渲染出与请求时刻相同的确定性标记,否则水位线
  // digest 会在下一轮失配,native resume 永远无法命中。
  if (block.type === 'image') {
    const ref = block.attachment
    if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
      return `[image attached${typeof ref.name === 'string' && ref.name ? `: ${ref.name}` : ''}]`
    }
    return '[image omitted from external Harness history]'
  }
  if (block.type === 'file') {
    const ref = block.attachment
    if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
      return `[file attached${typeof ref.name === 'string' && ref.name ? `: ${ref.name}` : ''}]`
    }
    return '[file omitted from external Harness history]'
  }
  if (block.type === 'tool-call') {
    const name = String(block.name ?? 'unknown')
    if (typeof block.id === 'string' && block.id) toolNames.set(block.id, name)
    const args = typeof block.arguments === 'string' ? block.arguments : ''
    return `[tool call: ${name}]${args ? `\n${args}` : ''}`
  }
  if (block.type === 'tool-result') {
    const body = Array.isArray(block.content)
      ? block.content.map((item) => conversationBlockText(item, toolNames)).filter(Boolean).join('\n')
      : ''
    const name = toolNames.get(block.toolCallId) ?? String(block.name ?? 'unknown')
    return `[tool result: ${name}]${body ? `\n${body}` : ''}`
  }
  return ''
}

function digestMessages(messages) {
  return createHash('sha256').update(JSON.stringify(messages)).digest('hex')
}

function isHumanMessage(message) {
  const hasToolResult = (message?.content ?? []).some((block) => block?.type === 'tool-result')
  return message?.role === 'user'
    && (message?.source?.kind === 'user' || (message?.source === undefined && !hasToolResult))
}

function renderConversationMessage(role, content, provenance) {
  const message = `${String(role ?? 'message').toUpperCase()}\n${content}`
  if (!provenance) return message
  return `[DSH TURN ${provenance.turn} · EXECUTION HARNESS: ${provenance.harness}]\n${message}`
}

function isSpineMessage(message) {
  const source = message?.source
  if (source === undefined) return true
  if (source.kind === 'user' || source.kind === 'model' || source.kind === 'tool') return true
  return source.kind === 'plugin' && (source.form === 'notice' || source.form === 'relay' || source.form === 'recall')
}

export function createConversationView(messages, { completedTurns: cleanTurns, provenance, workLedgers } = {}) {
  const source = messages ?? []
  let rawRequestIndex = -1
  for (let index = source.length - 1; index >= 0; index -= 1) {
    if (isHumanMessage(source[index])) {
      rawRequestIndex = index
      break
    }
  }
  const toolNames = new Map()
  const allEntries = []
  // 最新请求的图片 attachment 引用会随 dispatch 原样传给外部 Harness,
  // canonical 文本里保留确定性标记(参与水位线/签名,避免"只换图"的
  // 两个请求产生相同渲染)。
  const requestImages = []
  const requestFiles = []
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const message = source[sourceIndex]
    const content = (message?.content ?? []).map((block) => {
      if (sourceIndex === rawRequestIndex && block?.type === 'image') {
        const ref = block.attachment
        if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
          requestImages.push({ attachment: ref })
          return `[image attached${typeof ref.name === 'string' && ref.name ? `: ${ref.name}` : ''}]`
        }
        if (typeof block.data === 'string' && block.data) {
          requestImages.push({ data: block.data, mediaType: block.mediaType })
          return '[image attached]'
        }
        throw new Error('外部 Harness 暂不支持图片输入，请为本回合切换到 DSH')
      }
      if (sourceIndex === rawRequestIndex && block?.type === 'file') {
        const ref = block.attachment
        if (ref && typeof ref === 'object' && typeof ref.attachmentId === 'string') {
          requestFiles.push({ attachment: ref })
          return `[file attached${typeof ref.name === 'string' && ref.name ? `: ${ref.name}` : ''}]`
        }
        throw new Error('外部 Harness 暂不支持文件输入，请为本回合切换到 DSH')
      }
      return conversationBlockText(block, toolNames)
    }).filter(Boolean).join('\n')
    if (!content) continue
    const messageProvenance = provenance instanceof Map ? provenance.get(message?.id) : undefined
    const text = renderConversationMessage(message.role, content, messageProvenance)
    allEntries.push({
      text,
      provenance: messageProvenance,
      human: isHumanMessage(message),
      role: message?.role,
      sourceKind: message?.source?.kind,
      spine: isSpineMessage(message),
    })
  }
  const fullWorkLedger = renderWorkLedger(workLedgers)
  if (fullWorkLedger) {
    const insertionIndex = allEntries.findLastIndex((entry) => entry.human)
    const ledgerEntry = {
      text: fullWorkLedger,
      provenance: undefined,
      human: false,
      role: 'user',
      sourceKind: 'plugin',
      spine: false,
    }
    if (insertionIndex >= 0) allEntries.splice(insertionIndex, 0, ledgerEntry)
    else allEntries.push(ledgerEntry)
  }
  const entries = allEntries.filter((entry) => entry.spine)
  const rendered = entries.map((entry) => entry.text)
  const allRendered = allEntries.map((entry) => entry.text)
  let requestIndex = -1
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index].human) {
      requestIndex = index
      break
    }
  }
  function hasCleanCompletedHistory(fromIndex, toIndex) {
    for (let index = fromIndex; index < toIndex; index += 1) {
      if (!entries[index].human) continue
      let nextHuman = toIndex
      for (let cursor = index + 1; cursor < toIndex; cursor += 1) {
        if (entries[cursor].human) {
          nextHuman = cursor
          break
        }
      }
      const lastMeaningful = entries.slice(index + 1, nextHuman)
        .filter((entry) => entry.sourceKind !== 'plugin')
        .at(-1)
      if (lastMeaningful?.role !== 'assistant') return false
    }
    return true
  }
  function hasCleanTurnGap(boundary) {
    if (!boundary) return false
    if (boundary.beforeTurn - boundary.afterTurn <= 1) return true
    if (!(cleanTurns instanceof Set)) return false
    for (let turn = boundary.afterTurn + 1; turn < boundary.beforeTurn; turn += 1) {
      if (!cleanTurns.has(turn)) return false
    }
    return true
  }
  return {
    messages: allRendered,
    requestImages,
    requestFiles,
    currentPrompt() {
      return requestIndex >= 0 ? rendered.slice(requestIndex).join('\n\n') || undefined : undefined
    },
    watermarkAfter(assistantOutput) {
      // runtime.route commits outputText() as one trimmed assistant text block.
      const assistantText = typeof assistantOutput === 'string' ? assistantOutput.trim() : outputText(assistantOutput)
      if (!assistantText) return undefined
      const assistantMessage = renderConversationMessage('assistant', assistantText, entries[requestIndex]?.provenance)
      const anchored = [...rendered, assistantMessage]
      return { messageCount: anchored.length, digest: digestMessages(anchored) }
    },
    resumeFrom(watermark, boundary) {
      if (!watermark || !Number.isSafeInteger(watermark.messageCount) || watermark.messageCount < 1) return undefined
      if (watermark.messageCount >= rendered.length || requestIndex < watermark.messageCount) return undefined
      if (digestMessages(rendered.slice(0, watermark.messageCount)) !== watermark.digest) return undefined
      const history = rendered.slice(watermark.messageCount, requestIndex)
      const current = rendered.slice(requestIndex)
      if (history.length === 0) return current.join('\n\n') || undefined
      if (!hasCleanTurnGap(boundary)) return undefined
      if (!hasCleanCompletedHistory(watermark.messageCount, requestIndex)) return undefined
      const resumedHarness = entries[requestIndex]?.provenance?.harness ?? 'selected Harness'
      const workLedger = renderWorkLedger(workLedgers, boundary)
      return [
        'HARNESS HANDOFF',
        'While this Harness was parked, DSH recorded the following canonical messages. Treat them as intervening history and do not repeat completed work. The workspace is authoritative; inspect it when details are uncertain.',
        'IDENTITY ISOLATION',
        `You are resuming the ${resumedHarness} lane. In the history below, first-person identity claims belong to the labeled other Harness that produced them. Never adopt another Harness's identity, persona, code name, or private memory as your own; preserve this lane's prior identity.`,
        workLedger,
        history.join('\n\n'),
        `CURRENT REQUEST FOR RESUMED HARNESS: ${resumedHarness}`,
        current.join('\n\n'),
      ].filter(Boolean).join('\n\n')
    },
  }
}

function harnessPrompts(options, harness, session, dispatches) {
  const prefix = promptPrefix(options, harness)
  const conversation = createConversationView(options.messages, {
    completedTurns: completedTurns(session),
    provenance: conversationProvenance(session, dispatches, harness),
    workLedgers: dispatches,
  })
  const incremental = conversation.currentPrompt()
  return {
    full: [prefix, ...conversation.messages].join('\n\n'),
    incremental,
    conversation,
    signature: createHash('sha256').update(prefix).digest('hex'),
  }
}

function outputText(output) {
  return (output ?? [])
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim()
}

async function settleRun(run) {
  const execution = await Promise.resolve(run.result).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const disposal = await Promise.resolve().then(() => run.dispose()).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  )
  if (!execution.ok) throw execution.error
  if (!disposal.ok) throw disposal.error
  return execution.value
}

function failure(message, code = 'ALLY_HARNESS_ERROR') {
  return { message, code }
}

export function createAllianceRuntime({ sessions, agents, gateway, state, isAgentLoopRequest, llm }) {
  const active = new Map()
  const selections = new Map()
  const startups = new Set()
  const runs = new Set()
  let closing = false

  function sessionFor(sessionId) {
    const session = sessions.get(sessionId)
    if (!session) {
      const error = new Error('会话不存在或当前未加载')
      error.code = 'SESSION_NOT_FOUND'
      throw error
    }
    return session
  }

  function assertEligible(session) {
    if (isAllianceSession(session)) return
    const error = new Error('只有 Harness联盟模式 会话可以切换 Harness')
    error.code = 'PRESET_REQUIRED'
    throw error
  }

  async function snapshot(sessionId) {
    const session = sessionFor(sessionId)
    const current = active.get(sessionId)
    const availability = await gateway.availability()
    return {
      eligible: isAllianceSession(session),
      harness: state.harness(sessionId),
      providers: { dsh: true, ...availability },
      dispatches: state.dispatches(sessionId),
      active: current ? { runId: current.runId, harness: current.harness } : null,
    }
  }

  async function select({ sessionId, harness }) {
    if (!HARNESSES.includes(harness)) {
      const error = new Error('未知 Harness')
      error.code = 'INVALID_HARNESS'
      throw error
    }
    const session = sessionFor(sessionId)
    assertEligible(session)
    if (selections.has(sessionId)) {
      const error = new Error('已有 Harness 切换正在进行')
      error.code = 'TURN_OPEN'
      throw error
    }
    const agent = agents.get(sessionId)
    if (!agent) {
      const error = new Error('当前会话 Agent 未运行')
      error.code = 'AGENT_NOT_FOUND'
      throw error
    }
    if (closing || agent.status !== 'idle' || active.has(sessionId)) {
      const error = new Error('运行期间不能切换 Harness')
      error.code = 'TURN_OPEN'
      throw error
    }
    let operation
    try {
      operation = agent.runMaintenance(async (signal) => {
        signal.throwIfAborted()
        if (harness !== 'dsh' && !(await gateway.available(harness))) {
          const error = new Error(`${harness} CLI 当前不可用`)
          error.code = 'PROVIDER_UNAVAILABLE'
          throw error
        }
        signal.throwIfAborted()
        await state.setHarness(sessionId, harness)
        return { harness }
      })
    } catch (cause) {
      const error = new Error('运行期间不能切换 Harness', { cause })
      error.code = 'TURN_OPEN'
      throw error
    }
    selections.set(sessionId, operation)
    try {
      return await operation
    } finally {
      if (selections.get(sessionId) === operation) selections.delete(sessionId)
    }
  }

  // Note: 压缩摘要派发给执行历史的 Harness —— 见
  // .agents/notes/implemented/bug-fix/2026-09-17-compaction-summarization-routes-to-harness.md
  // 压缩摘要(purpose:'compaction')派发给 Harness:让执行历史的模型
  // 自己压缩自己的历史。不带 incrementalPrompt/promptSignature/turn
  // → gateway 绕过 nativeSessions,每次 session/new 起独立一次性会话,
  // 不往正在使用的 CLI 线程注入摘要指令。
  // 目标选择:当前路由的模型装不下重放区间时(典型场景:从 1M 窗口模型
  // 切到 swe-2 这种小窗口模型后触发压缩),挑会话历史里最近一个窗口装
  // 得下摘要 prompt 的模型——绑定 Harness 的进绑定 CLI,委派过的通用
  // 模型进当初执行它的 Harness,原生 provider 模型改 options 走 next()。
  function routeHistory(session) {
    const out = []
    for (const event of getSessionEvents(session)) {
      if (event?.type !== 'request/context') continue
      const { provider, model, contextWindow } = event.data ?? {}
      if (typeof provider === 'string' && provider && typeof model === 'string' && model) {
        out.push({ provider, model, contextWindow })
      }
    }
    return out
  }

  async function contextWindowOf(provider, model, hint) {
    if (Number.isInteger(hint) && hint > 0) return hint
    try {
      return (await llm?.resolveModelInfo(provider, model))?.context?.contextWindow
    } catch {
      return undefined
    }
  }

  function candidateExecution(candidate, currentHarness, dispatches) {
    const bound = OWN_PROVIDER_HARNESSES[candidate.provider]
    if (bound) return { kind: 'harness', harness: bound }
    const ran = [...(dispatches ?? [])].reverse().find(
      (item) => item.provider === candidate.provider && item.model === candidate.model
    )
    if (ran) return { kind: 'harness', harness: ran.harness }
    return { kind: 'native' }
  }

  async function pickCompactionTarget(options, session, prompt) {
    const dispatches = state.dispatches(options.sessionId)
    const current = state.harness(options.sessionId)
    const needed = estimateTokens(prompt) + (options.maxTokens ?? 0)
    const seen = new Set()
    const usable = []
    const consider = async (provider, model, contextWindow) => {
      const key = `${provider}/${model}`
      if (!provider || !model || seen.has(key)) return
      seen.add(key)
      const exec = candidateExecution({ provider, model }, current, dispatches)
      if (exec.kind === 'harness' && !(await gateway.available(exec.harness))) return
      usable.push({
        provider,
        model,
        exec,
        contextWindow: await contextWindowOf(provider, model, contextWindow),
      })
    }
    await consider(options.provider, options.model)
    const history = routeHistory(session)
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index]
      await consider(entry.provider, entry.model, entry.contextWindow)
    }
    const current_ = usable.find((c) => c.provider === options.provider && c.model === options.model)
    if (current_?.contextWindow !== undefined && current_.contextWindow > needed) return current_
    const fitting = usable.find((c) => c.contextWindow !== undefined && c.contextWindow > needed)
    if (fitting) return fitting
    return usable.reduce(
      (best, c) => ((c.contextWindow ?? 0) > (best?.contextWindow ?? 0) ? c : best),
      current_ ?? usable[0] ?? null
    )
  }

  async function* routeCompaction(options, next) {
    const session = sessions.get(options.sessionId)
    if (!isAllianceSession(session)) {
      yield* next()
      return
    }
    const conversation = createConversationView(options.messages ?? [])
    const prompt = conversation.messages.join('\n\n')
    if (!prompt) {
      yield* next()
      return
    }
    const target = await pickCompactionTarget(options, session, prompt)
    if (!target || (target.exec.kind === 'native' && Object.isFrozen(options))) {
      yield* next()
      return
    }
    if (target.exec.kind === 'native') {
      // 原生 provider 模型:改写 provider/model 后交回 DSH 自己的 llm 链路,
      // 让真实 API 承担摘要(归属和配额都正确)。reasoningEffort 可能对新
      // 模型非法,一并清掉。
      options.provider = target.provider
      options.model = target.model
      delete options.reasoningEffort
      yield* next()
      return
    }
    const harness = target.exec.harness
    if (harness === 'dsh' || !agents.get(options.sessionId)) {
      yield* next()
      return
    }
    const signal = options.signal ?? new AbortController().signal
    let run
    try {
      run = await gateway.start(harness, {
        parent: agents.get(options.sessionId),
        prompt: [{ type: 'text', text: prompt }],
        ...(conversation.requestImages.length ? { images: conversation.requestImages } : {}),
        ...(conversation.requestFiles.length ? { files: conversation.requestFiles } : {}),
        signal,
        model: target.model,
        provider: target.provider,
        // 档位只对原模型有效:换到历史模型时透传会拼出非法变体
        // (devin <model>-<effort> slug 不存在、codex effort 被上游拒绝)。
        ...(target.provider === options.provider && target.model === options.model
          ? { reasoningEffort: options.reasoningEffort }
          : {}),
        maxTokens: options.maxTokens,
        stop: options.stop,
      })
    } catch (cause) {
      const message = cause instanceof Error && cause.message ? cause.message : String(cause)
      yield { type: 'finish', reason: { kind: 'error', failure: failure(`${HARNESS_LABELS[harness] ?? harness} 摘要启动失败：${message}`) } }
      return
    }
    runs.add(run)
    try {
      // 摘要只消费最终文本:流事件照常排空(不转发增量,中间态不外泄)。
      const drain = (async () => {
        if (!run?.stream) return
        for await (const event of run.stream) void event
      })()
      const result = await settleRun(run)
      await drain.catch(() => {})
      const text = outputText(result.output)
      const usage = isReportedUsage(result.usage) ? result.usage : estimateUsage(prompt, text)
      if (signal.aborted || result.stopReason === 'aborted') {
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('Harness 摘要已停止', 'ABORTED') } }
        return
      }
      if (result.stopReason !== 'completed') {
        yield { type: 'finish', reason: { kind: 'error', failure: failure(result.diagnostic || `${HARNESS_LABELS[harness] ?? harness} 摘要执行失败`) } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      if (run) {
        try {
          await run.dispose()
        } finally {
          runs.delete(run)
        }
      }
    }
  }

  async function* route(options, next) {
    if (options?.purpose === 'compaction') {
      yield* routeCompaction(options, next)
      return
    }
    if (!isAgentLoopRequest(options) || options.purpose || !options.sessionId) {
      yield* next()
      return
    }
    const session = sessions.get(options.sessionId)
    if (!isAllianceSession(session)) {
      yield* next()
      return
    }
    if (closing) {
      yield { type: 'finish', reason: { kind: 'aborted', failure: failure('Harness 联盟正在关闭', 'ABORTED') } }
      return
    }
    const selection = selections.get(options.sessionId)
    if (selection) await selection.catch(() => {})
    let harness = state.harness(options.sessionId)
    const requiredHarness = OWN_PROVIDER_HARNESSES[options.provider]
    if (requiredHarness && requiredHarness !== harness) {
      // 选了 other-CLI provider 的模型 → 自动把 Harness 切到绑定的 CLI。
      // 不能走 select():agent-loop 请求发生时 agent 正处于 turn phase
      // (status 'running'),runMaintenance 必抛 "already has active work"。
      // 这里直接校验 CLI 可用性 + 持久化切换;失败才回落到 mismatch 报错。
      const label = HARNESS_LABELS[requiredHarness] ?? requiredHarness
      try {
        if (!(await gateway.available(requiredHarness))) {
          throw new Error(`${label} CLI 当前不可用`)
        }
        await state.setHarness(options.sessionId, requiredHarness)
        harness = requiredHarness
      } catch (cause) {
        const current = HARNESS_LABELS[harness] ?? String(harness)
        const detail = cause instanceof Error && cause.message ? `（${cause.message}）` : ''
        yield {
          type: 'finish',
          reason: { kind: 'error', failure: failure(`模型 provider「${options.provider}」只由 ${label} 执行：自动切换 Harness 失败${detail}，请手动把 Harness 从 ${current} 切换到 ${label}`, 'ALLY_HARNESS_MISMATCH') },
        }
        return
      }
    }
    if (harness === 'dsh') {
      yield* next()
      return
    }
    const agent = agents.get(options.sessionId)
    if (!agent) {
      yield { type: 'finish', reason: { kind: 'error', failure: failure('Harness联盟 Agent 已离线', 'ALLY_AGENT_OFFLINE') } }
      return
    }

    const runId = `ally-${randomUUID()}`
    const signal = options.signal ?? new AbortController().signal
    const boundary = currentBoundary(session)
    if (!Number.isSafeInteger(boundary.turn) || !Number.isSafeInteger(boundary.step)) {
      throw new Error('Agent-loop Harness 请求缺少有效 turn/step 边界')
    }
    const prompts = harnessPrompts(options, harness, session, state.dispatches(options.sessionId))
    const dispatch = {
      ...boundary,
      runId,
      harness,
      provider: options.provider,
      model: options.model,
      started: false,
    }
    let run
    const startup = (async () => {
      const priorDispatch = state.dispatches(options.sessionId).find((item) => item.turn === boundary.turn && item.started === true)
      if (!priorDispatch) await state.recordDispatch(options.sessionId, dispatch)
      const startedRun = await gateway.start(harness, {
        parent: agent,
        prompt: [{ type: 'text', text: prompts.full }],
        ...(prompts.incremental ? { incrementalPrompt: [{ type: 'text', text: prompts.incremental }] } : {}),
        conversation: prompts.conversation,
        images: prompts.conversation.requestImages,
        files: prompts.conversation.requestFiles,
        promptSignature: prompts.signature,
        turn: boundary.turn,
        signal,
        model: options.model,
        provider: options.provider,
        reasoningEffort: options.reasoningEffort,
        temperature: options.temperature,
        maxTokens: options.maxTokens,
        stop: options.stop,
      })
      runs.add(startedRun)
      run = startedRun
      await state.recordDispatch(options.sessionId, { ...dispatch, started: true })
      return startedRun
    })()
    startups.add(startup)

    try {
      try {
        run = await startup
      } finally {
        startups.delete(startup)
      }
      active.set(options.sessionId, { runId, harness, run })
      let streamedText = ''
      let textStarted = false
      const executorTitle = HARNESS_LABELS[harness] ?? String(harness)
      const startingStatus = `${executorTitle} · 正在执行`
      let reasoningText = startingStatus
      let lastWasActivity = true
      const seenActivities = new Map()
      yield { type: 'block-start', index: 1, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 1, text: startingStatus }
      if (run.stream) {
        for await (const event of run.stream) {
          if (event?.type === 'text-delta' && typeof event.text === 'string' && event.text) {
            if (!textStarted) {
              textStarted = true
              yield { type: 'block-start', index: 0, blockType: 'text' }
            }
            streamedText += event.text
            yield { type: 'text-delta', index: 0, text: event.text }
            continue
          }
          let reasoningDelta = ''
          if (event?.type === 'reasoning-delta' && typeof event.text === 'string' && event.text) {
            reasoningDelta = `${lastWasActivity && reasoningText ? '\n\n' : ''}${event.text}`
            lastWasActivity = false
          } else if (event?.type === 'activity' && typeof event.name === 'string') {
            const name = normalizeLedgerText(event.name, 48)
            const summary = normalizeLedgerText(event.summary, 180)
            const command = normalizeLedgerText(event.command)
            const paths = Array.isArray(event.paths)
              ? event.paths.map((path) => normalizeLedgerText(path)).filter(Boolean)
              : []
            const activityId = typeof event.id === 'string' && event.id ? event.id : `${name}:${summary}`
            const status = event.status === 'completed' || event.status === 'failed' ? event.status : 'running'
            const snapshot = `${name}\u0000${summary}\u0000${command}\u0000${status}\u0000${paths.join('\u0000')}`
            if (!name || seenActivities.get(activityId)?.snapshot === snapshot) continue
            seenActivities.set(activityId, { snapshot, activity: { name, summary, command, paths, status } })
            const statusText = status === 'completed' ? '已完成' : status === 'failed' ? '失败' : ''
            reasoningDelta = `${reasoningText ? '\n\n' : ''}${name}${summary ? ` · ${summary}` : ''}${statusText ? ` · ${statusText}` : ''}`
            lastWasActivity = true
          } else {
            continue
          }
          reasoningText += reasoningDelta
          yield { type: 'reasoning-delta', index: 1, text: reasoningDelta }
        }
      }
      const result = await settleRun(run) // settles only after both execution and clean disposal succeed
      const cleanCompleted = result.stopReason === 'completed' && !signal.aborted
      if (cleanCompleted) {
        const ledger = workLedgerFromActivities([...seenActivities.values()].map((entry) => entry.activity))
        if (ledger) await state.recordDispatch(options.sessionId, { ...dispatch, started: true, ledger })
      }
      const text = outputText(result.output)
      const usage = isReportedUsage(result.usage) ? result.usage : estimateUsage(prompts.full, text || streamedText)
      const processText = reasoningText.slice(startingStatus.length).replace(/^\n\n/, '')
      if (result.stopReason === 'aborted' || (!cleanCompleted && signal.aborted)) {
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 已停止` } }
        if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: failure('Harness 请求已停止', 'ABORTED') } }
        return
      }
      if (result.stopReason === 'error') {
        yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 执行失败` } }
        if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: streamedText } }
        yield { type: 'usage', usage }
        yield { type: 'finish', reason: { kind: 'error', failure: failure(result.diagnostic || '外部 Harness 执行失败') } }
        return
      }
      const tail = !streamedText ? text : text.startsWith(streamedText) ? text.slice(streamedText.length) : ''
      if (tail) {
        if (!textStarted) {
          textStarted = true
          yield { type: 'block-start', index: 0, blockType: 'text' }
        }
        streamedText += tail
        yield { type: 'text-delta', index: 0, text: tail }
      }
      const finalText = text || streamedText
      yield { type: 'block-end', index: 1, block: { type: 'reasoning', text: processText || `${executorTitle} · 已完成` } }
      if (textStarted) yield { type: 'block-end', index: 0, block: { type: 'text', text: finalText } }
      yield { type: 'usage', usage }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally {
      if (active.get(options.sessionId)?.runId === runId) active.delete(options.sessionId)
      if (run) {
        try {
          await run.dispose()
        } finally {
          runs.delete(run)
        }
      }
    }
  }

  async function shutdown() {
    closing = true
    while (selections.size > 0 || startups.size > 0) {
      await Promise.allSettled([...selections.values(), ...startups])
    }
    active.clear()
    const results = await Promise.allSettled([...runs].map((run) => run.dispose()))
    const failureResult = results.find((result) => result.status === 'rejected')
    if (failureResult) throw failureResult.reason
  }

  return { snapshot, select, route, shutdown }
}
