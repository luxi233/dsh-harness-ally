import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    assert.deepEqual(models, [{
      provider: 'codex',
      id: 'gpt-5.5',
      name: 'gpt-5.5',
      description: '使用 Codex 自己的配置与凭据执行，不经过 DSH 模型 bridge',
    }])
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = prev
  }

  const listed = await claude.listModels('claude-code')
  assert.equal(listed.length, 1)
  assert.equal(listed[0].provider, 'claude-code')

  await assert.rejects(async () => {
    for await (const chunk of codex.stream({})) void chunk
  }, /Harness 切换/)
  assert.deepEqual(await claude.resolveModel('claude-code', 'x'), { provider: 'claude-code', id: 'x', name: 'x' })
})
