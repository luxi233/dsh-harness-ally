// 外部 CLI「自有配置」模型 provider:把 Claude Code / Codex 自己可用的模型
// 注册进 DSH 模型选择器。选中该 provider 时对应 adapter 跳过 DSH model
// bridge,子进程直接用自己的 settings/config(CCSwitch 等工具写入的
// endpoint/key/model 全部生效);模型 id 显式下发(--model / thread model)。
//
// 这些 provider 不接受真实 llm 请求:被其它 Harness 选中执行时 stream 给出
// 明确的切换 Harness 报错。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'

import { ALLY_VERSION } from './version.js'

// provider id 与 harness id 同名:adapter 用 `request.provider === <harness id>`
// 判定「该走自有配置」。
export const CLAUDE_OWN_PROVIDER = 'claude-code'
export const CODEX_OWN_PROVIDER = 'codex'

// 「跟随 CLI 配置」占位条目:不额外下发模型名,完全由 CLI 自己的配置决定。
export const CLI_CONFIG_MODEL_ID = 'cli-config'

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

// Claude Code 的用户配置:`~/.claude/settings.json`(或 $CLAUDE_CONFIG_DIR),
// CCSwitch 往 env 里写 ANTHROPIC_BASE_URL/AUTH_TOKEN,模型在顶层 `model`
// 或 env.ANTHROPIC_MODEL。
export function claudeConfiguredModel(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  const settings = readJson(join(configDir, 'settings.json'))
  return settings?.env?.ANTHROPIC_MODEL ?? settings?.model ?? env.ANTHROPIC_MODEL
}

// Codex 的用户配置:`~/.codex/config.toml`(或 $CODEX_HOME)顶层 model。
export function codexConfiguredModel(env = process.env) {
  const configDir = env.CODEX_HOME || join(homedir(), '.codex')
  try {
    const match = /^model\s*=\s*"([^"]+)"/m.exec(readFileSync(join(configDir, 'config.toml'), 'utf8'))
    return match?.[1] ?? env.CODEX_MODEL
  } catch {
    return env.CODEX_MODEL
  }
}

// Claude Code 接受的模糊模型名(family alias),与 relay 插件的 DEFAULT_MODELS 对齐。
const CLAUDE_MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet', description: 'Claude Code default balanced model' },
  { id: 'opus', name: 'Claude Opus', description: 'Claude Code high-capability model' },
  { id: 'haiku', name: 'Claude Haiku', description: 'Claude Code fast model' },
]

// 一次性 `codex app-server` 握手拿账号级模型目录(model/list),超时/未登录/
// 解析失败回退为「跟随 CLI 配置」。
async function codexAccountModels(deps) {
  const executable = deps.cliManager
    ? await deps.cliManager.resolve(CODEX_OWN_PROVIDER)
    : await deps.subprocess.resolveExecutable('codex')
  const child = deps.subprocess.spawn({
    argv: [executable, 'app-server'],
    cwd: deps.cwd ?? homedir(),
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 64 * 1024 } },
    graceMs: 2000,
  })
  let nextId = 1
  const pending = new Map()
  const send = (method, params) => {
    const id = nextId++
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }
  let response
  try {
    response = await new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      const timeout = setTimeout(() => reject(new Error('codex model/list timeout')), 10000)
      const finish = (value, error) => {
        clearTimeout(timeout)
        for (const waiter of pending.values()) waiter.reject(new Error('codex app-server closed'))
        error ? reject(error) : resolve(value)
      }
      child.stdout?.on('data', (chunk) => {
        buffer += decoder.write(chunk)
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            continue
          }
          if (message.id !== undefined && pending.has(message.id)) {
            const waiter = pending.get(message.id)
            pending.delete(message.id)
            message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result)
            if (pending.size === 0 && message.id === 2) finish(message.result)
          }
        }
      })
      child.done.then(() => finish(undefined, new Error('codex app-server exited early')), () => {})
      send('initialize', { clientInfo: { name: 'dsh-ally', version: ALLY_VERSION }, capabilities: { experimentalApi: true } })
        .then(() => {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`)
          return send('model/list', { limit: 50, includeHidden: false })
        })
        .catch((error) => finish(undefined, error))
    })
  } finally {
    child.terminate()
  }
  const rows = Array.isArray(response?.data) ? response.data : Array.isArray(response) ? response : []
  const models = rows
    .filter((row) => row && typeof row.id === 'string' && row.id)
    .map((row) => ({
      provider: CODEX_OWN_PROVIDER,
      id: row.id,
      name: row.displayName ?? row.name ?? row.id,
      ...typeof row.description === 'string' && row.description ? { description: row.description } : {},
      ...Array.isArray(row.inputModalities) ? { inputModalities: row.inputModalities } : {},
      ...row.supportedReasoningEfforts || row.defaultReasoningEffort
        ? { supportedReasoningEfforts: row.supportedReasoningEfforts, defaultReasoningEffort: row.defaultReasoningEffort }
        : {},
    }))
  return models
}

function reasoningMetadata(row) {
  const efforts = Array.isArray(row?.supportedReasoningEfforts) ? row.supportedReasoningEfforts : []
  if (!efforts.length) return {}
  return {
    reasoning: {
      efforts: efforts.map((effort) => ({
        id: effort.reasoningEffort ?? effort.id ?? String(effort),
        name: effort.reasoningEffort ?? effort.id ?? String(effort),
      })),
      ...row.defaultReasoningEffort ? { defaultEffort: row.defaultReasoningEffort } : {},
    },
  }
}

// 通用自有配置 provider;modelList 可选动态目录,否则只列「跟随 CLI 配置」。
export function createOwnConfigAdapter({ provider, name, readModel, modelList }) {
  let cached
  const list = async () => {
    if (cached) return cached
    try {
      const listed = modelList ? await modelList() : []
      if (listed?.length) {
        cached = listed
        return cached
      }
    } catch {
      // 目录查询失败(未登录/CLI 缺失)回退到占位条目
    }
    const configured = readModel?.()
    const entries = [{
      provider,
      id: CLI_CONFIG_MODEL_ID,
      name: `${name} 配置`,
      description: `使用 ${name} 自己配置的模型执行，不经过 DSH 模型 bridge`,
    }]
    if (configured) entries.unshift({ provider, id: configured, name: configured })
    return entries
  }
  return {
    providerId: provider,
    providerInfo(id) {
      return { id, name: `${name}（CLI 配置）` }
    },
    providerRetryPolicy() {
      return undefined
    },
    imageRequestPricing() {
      return undefined
    },
    listModels() {
      return list()
    },
    async resolveModel(id, model) {
      const entry = (await list()).find((item) => item.id === model)
      return { provider: id, id: model, name: entry?.name ?? model }
    },
    async prepareCall(id, model) {
      const resolved = await this.resolveModel(id, model)
      return { model: resolved, stream: (options) => this.stream(options) }
    },
    async *stream() {
      throw new Error(`${name}（CLI 配置）provider 只由 ${name} Harness 执行：请把 Harness 切换过去`)
    },
  }
}

// Claude:family alias 列表 + 已配置模型(若不在列表内,例如 CCSwitch 写的
// 具体版本名)。选中具体 alias 时 adapter 以 --model 下发。
export function createClaudeOwnConfigAdapter() {
  const adapter = createOwnConfigAdapter({
    provider: CLAUDE_OWN_PROVIDER,
    name: 'Claude Code',
    readModel: claudeConfiguredModel,
  })
  adapter.listModels = async () => {
    const configured = claudeConfiguredModel()
    const entries = [
      { provider: CLAUDE_OWN_PROVIDER, id: CLI_CONFIG_MODEL_ID, name: 'Claude Code 配置', description: '使用 Claude Code 自己配置的模型执行，不经过 DSH 模型 bridge' },
      ...CLAUDE_MODELS.map((model) => ({ provider: CLAUDE_OWN_PROVIDER, ...model })),
    ]
    if (configured && !entries.some((entry) => entry.id === configured)) {
      entries.splice(1, 0, { provider: CLAUDE_OWN_PROVIDER, id: configured, name: configured, description: '当前 ~/.claude/settings.json 配置的模型' })
    }
    return entries
  }
  return adapter
}

// Codex:app-server model/list 账号目录(含 reasoning efforts);失败回退
// 「跟随配置」+ config.toml 里读到的当前模型。
export function createCodexOwnConfigAdapter(deps) {
  const rows = new Map()
  const adapter = createOwnConfigAdapter({
    provider: CODEX_OWN_PROVIDER,
    name: 'Codex',
    readModel: codexConfiguredModel,
    modelList: deps ? () => codexAccountModels(deps) : undefined,
  })
  const baseList = adapter.listModels.bind(adapter)
  adapter.listModels = async () => {
    const listed = await baseList()
    for (const row of listed) rows.set(row.id, row)
    return listed
  }
  adapter.resolveModel = async (id, model) => {
    await adapter.listModels()
    const row = rows.get(model)
    return {
      provider: id,
      id: model,
      name: row?.name ?? model,
      ...row?.inputModalities ? { inputModalities: row.inputModalities } : {},
      ...reasoningMetadata(row),
    }
  }
  return adapter
}

export function ownConfigAdapters(deps) {
  return [
    createClaudeOwnConfigAdapter(),
    createCodexOwnConfigAdapter(deps),
  ]
}
