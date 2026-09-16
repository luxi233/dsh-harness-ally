import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { claudeConfiguredModel, codexConfiguredModel, ownConfigAdapters } from '../lib/cli-own-models.js'

function tempHome() {
  return mkdtempSync(join(tmpdir(), 'ally-own-'))
}

test('claudeConfiguredModel reads settings.json model and env.ANTHROPIC_MODEL', () => {
  const dir = tempHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'claude-opus-4-6' }))
  assert.equal(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir }), 'claude-opus-4-6')

  const dir2 = tempHome()
  writeFileSync(join(dir2, 'settings.json'), JSON.stringify({ env: { ANTHROPIC_MODEL: 'sonnet-from-switch' } }))
  assert.equal(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir2 }), 'sonnet-from-switch')
})

test('claudeConfiguredModel falls back to ANTHROPIC_MODEL env then undefined', () => {
  const dir = tempHome()
  assert.equal(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir, ANTHROPIC_MODEL: 'env-model' }), 'env-model')
  assert.equal(claudeConfiguredModel({ CLAUDE_CONFIG_DIR: dir }), undefined)
})

test('codexConfiguredModel reads config.toml model', () => {
  const dir = tempHome()
  writeFileSync(join(dir, 'config.toml'), 'model_provider = "openai"\nmodel = "gpt-5.5"\nmodel_reasoning_effort = "medium"\n')
  assert.equal(codexConfiguredModel({ CODEX_HOME: dir }), 'gpt-5.5')
  assert.equal(codexConfiguredModel({ CODEX_HOME: tempHome(), CODEX_MODEL: 'env-codex' }), 'env-codex')
  assert.equal(codexConfiguredModel({ CODEX_HOME: tempHome() }), undefined)
})

test('own-config adapters list the configured model and refuse llm calls', async () => {
  const dir = tempHome()
  writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5.5"\n')
  const adapters = ownConfigAdapters()
  const codex = adapters.find((a) => a.providerId === 'codex')
  const claude = adapters.find((a) => a.providerId === 'claude-code')

  const prev = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const models = await codex.listModels('codex')
    // 无 deps 时 codex 目录回退:配置模型 + 「跟随配置」占位
    assert.deepEqual(models.map((model) => model.id), ['gpt-5.5', 'cli-config'])
    assert.equal(models.every((model) => model.provider === 'codex'), true)
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  }

  const listed = await claude.listModels('claude-code')
  // Claude:占位条目 + family alias(sonnet/opus/haiku)
  assert.deepEqual(listed.map((model) => model.id), ['cli-config', 'sonnet', 'opus', 'haiku'])
  assert.equal(listed.every((model) => model.provider === 'claude-code'), true)

  await assert.rejects(async () => {
    for await (const chunk of codex.stream({})) void chunk
  }, /Harness 切换/)
  assert.deepEqual(await claude.resolveModel('claude-code', 'x'), { provider: 'claude-code', id: 'x', name: 'x' })
})

test('own-config adapters expose the llm adapter contract hooks', () => {
  for (const adapter of ownConfigAdapters()) {
    // registerAdapter 在 prepareRoutes 阶段调用 providerRetryPolicy,token meter
    // 调用 imageRequestPricing——缺一个都会让注册静默失败。
    assert.equal(adapter.providerRetryPolicy('x'), undefined)
    assert.equal(adapter.imageRequestPricing('x', 'y'), undefined)
    assert.equal(typeof adapter.providerInfo, 'function')
    assert.equal(typeof adapter.prepareCall, 'function')
  }
})

test('claude own-config list merges the configured model ahead of aliases', async () => {
  const dir = tempHome()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ model: 'claude-custom-1' }))
  const prev = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = dir
  try {
    const [claude] = ownConfigAdapters()
    const models = await claude.listModels('claude-code')
    assert.deepEqual(models.map((model) => model.id), ['cli-config', 'claude-custom-1', 'sonnet', 'opus', 'haiku'])
    assert.match(models[1].description ?? '', /settings\.json/)
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
})

// 模拟 codex app-server:JSON-RPC initialize → initialized → model/list
function codexCatalogDeps(rows, { fail } = {}) {
  const writes = []
  const stdout = new PassThrough()
  const child = {
    stdin: {
      write(text) {
        writes.push(text)
        const message = JSON.parse(text.trim())
        queueMicrotask(() => {
          if (message.method === 'initialize') {
            stdout.write(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex/1' } })}\n`)
          } else if (message.method === 'model/list') {
            if (fail) stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32000, message: 'no auth' } })}\n`)
            else stdout.write(`${JSON.stringify({ id: message.id, result: { data: rows } })}\n`)
          }
        })
        return true
      },
    },
    stdout,
    terminate() {},
    done: new Promise(() => {}),
  }
  return {
    writes,
    deps: {
      subprocess: { async resolveExecutable() { return '/bin/codex' }, spawn() { return child } },
    },
  }
}

test('codex own-config lists the account catalog from model/list with reasoning metadata', async () => {
  const { deps, writes } = codexCatalogDeps([
    { id: 'gpt-6-astra', displayName: 'GPT-6 Astra', description: 'frontier', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }], defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] },
    { id: 'gpt-5.5', displayName: 'GPT-5.5' },
    { id: '' },
    'not-an-object',
  ])
  const [claude, codex] = ownConfigAdapters(deps)
  assert.equal(claude.providerId, 'claude-code')

  const models = await codex.listModels('codex')
  assert.deepEqual(models.map((model) => model.id), ['gpt-6-astra', 'gpt-5.5'])
  assert.equal(models[0].name, 'GPT-6 Astra')
  assert.equal(models[0].description, 'frontier')
  assert.deepEqual(models[0].inputModalities, ['text', 'image'])
  assert.ok(writes.some((line) => line.includes('"model/list"')))
  assert.ok(writes.some((line) => line.includes('"initialized"')))

  const resolved = await codex.resolveModel('codex', 'gpt-6-astra')
  assert.equal(resolved.name, 'GPT-6 Astra')
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'high'])
  assert.equal(resolved.reasoning.defaultEffort, 'high')
})

// 模拟 kimi acp:JSON-RPC initialize → session/new(configOptions 携带
// model select + thought_level 档位)。fail 时 session/new 返回认证错误。
function kimiCatalogDeps({ fail } = {}) {
  const writes = []
  const stdout = new PassThrough()
  const configOptions = [
    { type: 'select', id: 'mode', currentValue: 'default', options: [{ value: 'auto', name: 'Auto' }] },
    { type: 'select', id: 'model', category: 'model', currentValue: 'kimi-code/kimi-for-coding', options: [
      { value: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview' },
      { value: 'kimi-code/k3', name: 'K3' },
    ] },
    { type: 'select', id: 'thinking', category: 'thought_level', currentValue: 'max', options: [
      { value: 'low', name: 'Thinking Low' },
      { value: 'high', name: 'Thinking High' },
      { value: 'max', name: 'Thinking Max' },
    ] },
  ]
  const child = {
    stdin: {
      write(text) {
        writes.push(text)
        const message = JSON.parse(text.trim())
        queueMicrotask(() => {
          if (message.method === 'initialize') {
            stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } })}\n`)
          } else if (message.method === 'session/new') {
            if (fail) stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } })}\n`)
            else stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1', configOptions } })}\n`)
          }
        })
        return true
      },
    },
    stdout,
    terminate() {},
    done: new Promise(() => {}),
  }
  return {
    writes,
    deps: {
      subprocess: { async resolveExecutable() { return '/bin/kimi' }, spawn() { return child } },
    },
  }
}

test('kimi own-config lists the account catalog from ACP configOptions with thinking efforts', async () => {
  const { deps, writes } = kimiCatalogDeps()
  const kimi = ownConfigAdapters(deps).find((adapter) => adapter.providerId === 'kimi-code')

  const models = await kimi.listModels('kimi-code')
  assert.deepEqual(models.map((model) => model.id), ['kimi-code/kimi-for-coding', 'kimi-code/k3'])
  assert.equal(models[0].name, 'K2.8 Preview')
  assert.ok(writes.some((line) => line.includes('"initialize"')))
  assert.ok(writes.some((line) => line.includes('"session/new"')))

  const resolved = await kimi.resolveModel('kimi-code', 'kimi-code/k3')
  assert.equal(resolved.name, 'K3')
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'high', 'max'])
  assert.equal(resolved.reasoning.defaultEffort, 'max')
})

test('kimi own-config falls back to the cli-config placeholder when unauthenticated', async () => {
  const { deps } = kimiCatalogDeps({ fail: true })
  const kimi = ownConfigAdapters(deps).find((adapter) => adapter.providerId === 'kimi-code')
  const models = await kimi.listModels('kimi-code')
  assert.deepEqual(models.map((model) => model.id), ['cli-config'])
})

test('codex own-config falls back to the configured model when model/list fails', async () => {
  const dir = tempHome()
  writeFileSync(join(dir, 'config.toml'), 'model = "gpt-5.5"\n')
  const { deps } = codexCatalogDeps([], { fail: true })
  const [, codex] = ownConfigAdapters(deps)
  const prev = process.env.CODEX_HOME
  process.env.CODEX_HOME = dir
  try {
    const models = await codex.listModels('codex')
    assert.deepEqual(models.map((model) => model.id), ['gpt-5.5', 'cli-config'])
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  }
})
