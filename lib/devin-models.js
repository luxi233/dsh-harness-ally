// Devin 账号模型目录注册为 DSH provider "devin":模型选择器列出 devin
// 账号可用的模型,选中后 request.provider==='devin' 由 devin ACP adapter
// 翻译成 `devin acp --model`。该 provider 不参与 llm 请求——
// stream/prepareCall 永远给出明确报错,引导把 Harness 切到 Devin。

import { homedir } from 'node:os'

export const DEVIN_PROVIDER = 'devin'

const LIST_MAX_BYTES = 256 * 1024
const LIST_TIMEOUT_MS = 10000
// `devin models list` 需要登录,输出是账号级目录。登录不可用或解析失败时
// 给一份 `devin acp --model` 帮助文档列出的 family 兜底,保证选择器不为空;
// --model 接受模糊名,家族 slug 总会解析。
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4', name: 'Claude Sonnet 4' },
  { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
  { id: 'codex', name: 'Codex' },
]

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
        if (outcome.exitCode !== 0 || !text.trim()) return FALLBACK_MODELS.map((m) => ({ provider: DEVIN_PROVIDER, ...m }))
        const found = []
        try {
          collectModels(JSON.parse(text), found, new Set())
        } catch {
          return FALLBACK_MODELS.map((m) => ({ provider: DEVIN_PROVIDER, ...m }))
        }
        return found.length ? found : FALLBACK_MODELS.map((m) => ({ provider: DEVIN_PROVIDER, ...m }))
      } catch {
        return FALLBACK_MODELS.map((m) => ({ provider: DEVIN_PROVIDER, ...m }))
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
