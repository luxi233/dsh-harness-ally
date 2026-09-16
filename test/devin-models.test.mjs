import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createDevinModelAdapter, DEVIN_PROVIDER } from '../lib/devin-models.js'

function fixture({ modelsJson, exitCode = 0, spawnError, acpCatalog, env } = {}) {
  const spawns = []
  const subprocess = {
    async resolveExecutable(command) { return `/bin/${command}` },
    spawn(spec) {
      if (spawnError) throw spawnError
      spawns.push(spec)
      if (spec.argv.includes('acp')) {
        // 伪 ACP server:按收到的 request id 回 initialize/authenticate/session/new。
        const child = {
          stdin: { write(text) {
            for (const line of text.split('\n').filter(Boolean)) {
              const message = JSON.parse(line)
              if (message.method === 'initialize') {
                child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1 } }) + '\n'))
              } else if (message.method === 'authenticate') {
                child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n'))
              } else if (message.method === 'session/new') {
                const configOptions = acpCatalog
                  ? [{ id: 'model', category: 'model', type: 'select', options: acpCatalog }]
                  : []
                child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's1', configOptions } }) + '\n'))
              }
            }
          }, on() {}, end() {} },
          stdout: new EventEmitter(),
          stderr: new EventEmitter(),
          done: new Promise(() => {}),
          terminate() {},
          waitForExit: async () => true,
        }
        return child
      }
      return {
        done: Promise.resolve({ exitCode }),
        collected: { stdout: { readFrom: () => ({ text: modelsJson ?? '', nextOffset: 0, lossy: false }) } },
        terminate() {},
      }
    },
  }
  const cliManager = { async resolve(harness) { assert.equal(harness, DEVIN_PROVIDER); return '/bin/devin' } }
  const adapter = createDevinModelAdapter({ subprocess, cliManager, env: env ?? {}, readTextFile: () => { throw new Error('no credentials') } })
  return { adapter, spawns }
}

const ACCOUNT_CATALOG = JSON.stringify({
  families: [
    { name: 'Claude', models: [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'fast' },
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
    ] },
    { name: 'GPT', models: [{ slug: 'codex', name: 'Codex' }] },
  ],
})

test('devin provider lists the account model catalog from devin models list', async () => {
  const { adapter, spawns } = fixture({ modelsJson: ACCOUNT_CATALOG })

  const models = await adapter.listModels(DEVIN_PROVIDER)

  assert.deepEqual(spawns[0].argv.slice(1), ['models', 'list', '--format', 'json'])
  assert.deepEqual(models, [
    { provider: 'devin', id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: 'fast' },
    { provider: 'devin', id: 'claude-opus-4.6', name: 'Claude Opus 4.6' },
    { provider: 'devin', id: 'codex', name: 'Codex' },
  ])
})

test('devin provider falls back to documented model families when the CLI is unavailable', async () => {
  const { adapter, spawns } = fixture({ spawnError: new Error('spawn devin ENOENT') })

  const models = await adapter.listModels(DEVIN_PROVIDER)

  assert.equal(spawns.length, 0)
  assert.equal(models.length > 0, true)
  assert.equal(models.every((model) => model.provider === 'devin'), true)
})

test('devin provider falls back when models list exits non-zero or returns unparseable output', async () => {
  for (const f of [fixture({ modelsJson: 'not json' }), fixture({ modelsJson: '{}', exitCode: 1 })]) {
    const models = await f.adapter.listModels(DEVIN_PROVIDER)
    assert.equal(models.length > 0, true)
  }
})

test('devin provider discovers the account catalog via ACP session configOptions when models list fails', async () => {
  const acpCatalog = [
    { value: 'swe-2-high', name: 'SWE-2 High' },
    { value: 'claude-opus-5-medium', name: 'Claude Opus 5 Medium' },
    { value: 'claude-opus-5-medium', name: 'Duplicate' },
  ]
  const { adapter, spawns } = fixture({ modelsJson: '', exitCode: 1, acpCatalog })

  const models = await adapter.listModels(DEVIN_PROVIDER)

  assert.equal(spawns.length, 2)
  assert.deepEqual(spawns[1].argv.slice(1), ['acp'])
  assert.deepEqual(models, [
    { provider: 'devin', id: 'swe-2-high', name: 'SWE-2 High' },
    { provider: 'devin', id: 'claude-opus-5-medium', name: 'Claude Opus 5 Medium' },
  ])
})

test('devin provider resolveModel returns catalog entries or a minimal identity', async () => {
  const { adapter } = fixture({ modelsJson: ACCOUNT_CATALOG })

  assert.deepEqual(await adapter.resolveModel('devin', 'claude-opus-4.6'), {
    provider: 'devin', id: 'claude-opus-4.6', name: 'Claude Opus 4.6',
  })
  assert.deepEqual(await adapter.resolveModel('devin', 'unknown-x'), {
    provider: 'devin', id: 'unknown-x', name: 'unknown-x',
  })
})

test('devin provider stream refuses with a harness-switch diagnostic', async () => {
  const { adapter } = fixture()

  await assert.rejects(async () => {
    for await (const chunk of adapter.stream({ provider: 'devin', model: 'opus' })) void chunk
  }, /Devin Harness/)
})

test('prepareCall binds the resolved model and a stream entry', async () => {
  const { adapter } = fixture({ modelsJson: ACCOUNT_CATALOG })

  const call = await adapter.prepareCall('devin', 'claude-sonnet-4')
  assert.equal(call.model.id, 'claude-sonnet-4')
  await assert.rejects(async () => {
    for await (const chunk of call.stream({})) void chunk
  }, /Devin Harness/)
})

test('devin provider adapter exposes the registration contract hooks', () => {
  const { adapter } = fixture()
  // registerAdapter 的 prepareRoutes 调 providerRetryPolicy,token meter 调
  // imageRequestPricing——缺一个都会让注册静默失败。
  assert.equal(adapter.providerRetryPolicy('devin'), undefined)
  assert.equal(adapter.imageRequestPricing('devin', 'claude-sonnet-4'), undefined)
  assert.equal(typeof adapter.providerInfo, 'function')
  assert.equal(typeof adapter.resolveModel, 'function')
})
