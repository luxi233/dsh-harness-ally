// 外部 CLI「自有配置」模型 provider:把 Claude Code / Codex 自己配置的模型
// 注册进 DSH 模型选择器。选中该 provider 时对应 adapter 跳过 DSH model
// bridge,子进程直接用自己的 settings/config(CCSwitch 等工具写入的
// endpoint/key/model 全部生效)。
//
// 这些 provider 不接受真实 llm 请求:被其它 Harness 选中执行时 stream 给出
// 明确的切换 Harness 报错。

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// provider id 与 harness id 同名:adapter 用 `request.provider === <harness id>`
// 判定「该走自有配置」。
export const CLAUDE_OWN_PROVIDER = 'claude-code'
export const CODEX_OWN_PROVIDER = 'codex'

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

// 通用自有配置 provider:listModels 只列一项「该 CLI 当前配置的模型」,
// stream 永远拒绝并提示切 Harness。
export function createOwnConfigAdapter({ provider, name, readModel }) {
  return {
    providerId: provider,
    providerInfo(id) {
      return { id, name: `${name}（CLI 配置）` }
    },
    async listModels() {
      const configured = readModel?.()
      return [{
        provider,
        id: configured ?? 'cli-config',
        name: configured ?? 'CLI 配置',
        description: `使用 ${name} 自己的配置与凭据执行，不经过 DSH 模型 bridge`,
      }]
    },
    async resolveModel(id, model) {
      return { provider: id, id: model, name: model }
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

export function ownConfigAdapters() {
  return [
    createOwnConfigAdapter({ provider: CLAUDE_OWN_PROVIDER, name: 'Claude Code', readModel: claudeConfiguredModel }),
    createOwnConfigAdapter({ provider: CODEX_OWN_PROVIDER, name: 'Codex', readModel: codexConfiguredModel }),
  ]
}
