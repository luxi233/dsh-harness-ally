import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { startDevinAcpRun } from '../lib/devin-acp.js'

async function collect(iterable) {
  const values = []
  for await (const value of iterable) values.push(value)
  return values
}

function fixture({
  env = { DEVIN_API_KEY: 'test-key' },
  credentialsToml,
  authenticateFails = false,
  authRequiredOnNew = false,
  resumeAdvertised = true,
  resumeFails = false,
  nativeSession,
  modeOptions = [{ value: 'normal', name: 'Normal' }, { value: 'bypass', name: 'Bypass' }],
  sessionFlushTimeoutMs,
  imageCapable = true,
  attachments,
  readFile,
} = {}) {
  const messages = []
  const spawns = []
  let terminal
  const terminalGate = new Promise((resolve) => { terminal = resolve })
  const controller = new AbortController()
  let promptRequest
  const subprocess = {
    async resolveExecutable(command) { return `/bin/${command}` },
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let input = ''
      let resolveDone
      let terminated = 0
      const done = new Promise((resolve) => { resolveDone = resolve })
      stdin.on('finish', () => queueMicrotask(() => {
        if (terminated > 0) return
        stdout.end()
        stderr.end()
        resolveDone({ exitCode: 0, signal: null })
      }))
      const send = (value) => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`)
      const configOptions = Array.isArray(modeOptions)
        ? [{ type: 'select', id: 'mode', currentValue: 'normal', options: modeOptions }]
        : []
      stdin.on('data', (chunk) => {
        input += chunk.toString('utf8')
        let newline
        while ((newline = input.indexOf('\n')) >= 0) {
          const line = input.slice(0, newline)
          input = input.slice(newline + 1)
          if (!line) continue
          const message = JSON.parse(line)
          messages.push(message)
          if (message.method === 'initialize') {
            send({ id: message.id, result: {
              protocolVersion: 1,
              agentCapabilities: { loadSession: resumeAdvertised, promptCapabilities: { image: imageCapable } },
              authMethods: [{ id: 'devin-browser', name: 'Log in with browser' }],
              agentInfo: { name: 'Devin Agent', version: 'test' },
            } })
          } else if (message.method === 'authenticate') {
            if (authenticateFails) send({ id: message.id, error: { code: -32000, message: 'Authentication required: invalid api key' } })
            else send({ id: message.id, result: {} })
          } else if (message.method === 'session/new') {
            if (authRequiredOnNew) {
              send({ id: message.id, error: { code: -32000, message: 'ACP host has not authenticated. Call the `authenticate` ACP method with `meta.api_key` set.' } })
            } else {
              send({ id: message.id, result: { sessionId: 'session-devin', configOptions } })
            }
          } else if (message.method === 'session/load') {
            if (resumeFails) send({ id: message.id, error: { code: -32602, message: 'session not found' } })
            else {
              send({
                method: 'session/update',
                params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLAY' } } },
              })
              send({ id: message.id, result: { sessionId: message.params.sessionId, configOptions } })
            }
          } else if (message.method === 'session/set_config_option') {
            send({ id: message.id, result: {} })
          } else if (message.method === 'session/prompt') {
            promptRequest = message
            queueMicrotask(() => {
              send({ id: 99, method: 'session/request_permission', params: { sessionId: message.params.sessionId, options: [
                { optionId: 'approve_once', name: 'Approve once', kind: 'allow_once' },
                { optionId: 'approve_always', name: 'Approve for this session', kind: 'allow_always' },
                { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
              ], toolCall: { toolCallId: '1:tool-1', title: 'Bash' } } })
              send({ id: 100, method: 'session/request_permission', params: { sessionId: message.params.sessionId, options: [
                { optionId: 'answer_a', name: 'Answer A', kind: 'allow_once' },
                { optionId: 'dismiss', name: 'Dismiss', kind: 'reject_once' },
              ], toolCall: { toolCallId: '1:question-1', title: 'Ask user' } } })
              send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Inspect files.' } } } })
              send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: '1:tool-1', title: '统计项目文件夹数量', kind: 'execute', status: 'in_progress', rawInput: { command: 'find . -type d' } } } })
              send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hel' } } } })
              send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } } } })
              send({ method: 'session/update', params: { sessionId: message.params.sessionId, update: { sessionUpdate: 'tool_call_update', toolCallId: '1:tool-1', status: 'completed' } } })
              terminal()
            })
          } else if (message.method === 'session/cancel') {
            if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'cancelled' } })
          }
        }
      })
      const handle = {
        stdin, stdout, stderr, done, pid: 44,
        terminate() {
          if (terminated > 0) return
          terminated += 1
          stdout.end()
          stderr.end()
          resolveDone({ exitCode: 0, signal: null })
        },
        async waitForExit(signal) {
          if (!signal) { await done; return true }
          return Promise.race([
            done.then(() => true),
            new Promise((resolve) => signal.addEventListener('abort', () => resolve(false), { once: true })),
          ])
        },
        get terminated() { return terminated },
        send,
        complete() {
          if (promptRequest) send({ id: promptRequest.id, result: { stopReason: 'end_turn' } })
        },
      }
      spawns.push({ spec, handle })
      return handle
    },
  }
  const deps = {
    subprocess,
    sessionFlushTimeoutMs,
    authorize() {},
    cliManager: { async resolve() { return '/bin/devin' } },
    env,
    homedir: '/home/test',
    readTextFile(path) {
      if (typeof credentialsToml === 'string' && /credentials\.toml$/.test(path)) return credentialsToml
      throw new Error(`missing ${path}`)
    },
    attachments,
    readFile,
  }
  const request = {
    parent: { session: { id: 'session-1', header: { cwd: '/workspace', agentPreset: 'harness-ally' } } },
    prompt: [{ type: 'text', text: 'do work' }],
    provider: 'provider',
    model: 'model',
    signal: controller.signal,
    ...(nativeSession ? { nativeSession } : {}),
  }
  return { deps, request, messages, spawns, terminalGate, controller }
}

function nativeResume(overrides = {}) {
  return {
    mode: 'resume',
    vendorId: 'vendor-devin-1',
    prompt: 'RESUME PROMPT',
    adopted: [],
    adopt(id) { this.adopted.push(id) },
    async fallback() {
      this.mode = 'fresh'
      this.vendorId = undefined
      this.prompt = 'FULL PROMPT'
    },
    async discard() {},
    ...overrides,
  }
}

test('Devin ACP authenticates, picks a permissive mode, and streams text/thought/tool activity', async () => {
  const f = fixture()
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate

  assert.equal(await Promise.race([run.result.then(() => 'done'), Promise.resolve('pending')]), 'pending')
  f.spawns[0].handle.complete()
  const [events, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.deepEqual(events, [
    { type: 'reasoning-delta', text: 'Inspect files.' },
    { type: 'activity', id: '1:tool-1', name: 'Bash', summary: '统计项目文件夹数量', command: 'find . -type d', status: 'running' },
    { type: 'text-delta', text: 'Hel' },
    { type: 'text-delta', text: 'lo' },
    { type: 'activity', id: '1:tool-1', name: 'Bash', summary: '统计项目文件夹数量', command: 'find . -type d', status: 'completed' },
  ])
  assert.deepEqual(result, { output: [{ type: 'text', text: 'Hello' }], stopReason: 'completed' })
  assert.deepEqual(f.spawns[0].spec.argv, ['/bin/devin', 'acp'])
  assert.equal(f.spawns[0].spec.cwd, '/workspace')
  const methods = f.messages.filter((message) => message.method).map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize', 'authenticate', 'session/new', 'session/set_config_option', 'session/prompt',
  ])
  const authenticate = f.messages.find((message) => message.method === 'authenticate')
  assert.equal(authenticate.params.methodId, 'devin-browser')
  assert.equal(authenticate.params._meta.api_key, 'test-key')
  const mode = f.messages.find((message) => message.method === 'session/set_config_option')
  assert.deepEqual(mode.params, { sessionId: 'session-devin', configId: 'mode', value: 'bypass' })
  // canonical 工具审批自动 allow_once;用户提问类请求不代答。
  const approval = f.messages.find((message) => message.id === 99)
  assert.deepEqual(approval.result.outcome, { outcome: 'selected', optionId: 'approve_once' })
  const question = f.messages.find((message) => message.id === 100)
  assert.deepEqual(question.result.outcome, { outcome: 'cancelled' })
})

test('Devin API key falls back to devin auth login credentials.toml', async () => {
  const f = fixture({
    env: {},
    credentialsToml: 'windsurf_api_key = "file-key"\napi_server_url = "https://server.example"\n',
  })
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const authenticate = f.messages.find((message) => message.method === 'authenticate')
  assert.equal(authenticate.params._meta.api_key, 'file-key')
})

test('missing credentials surfaces a login diagnostic instead of hanging', async () => {
  const f = fixture({ env: {}, authRequiredOnNew: true })

  const run = await startDevinAcpRun(f.deps, f.request)
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /devin auth login|DEVIN_API_KEY/)
  assert.equal(f.messages.some((message) => message.method === 'authenticate'), false)
  assert.equal(f.messages.some((message) => message.method === 'session/new'), true)
})

test('rejected API key reports a credential diagnostic', async () => {
  const f = fixture({ authenticateFails: true })

  const run = await startDevinAcpRun(f.deps, f.request)
  const result = await run.result
  await run.dispose()

  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /凭据失效|auth login|DEVIN_API_KEY/)
})

test('Devin ACP resumes a parked native session through session/load without replaying history', async () => {
  const nativeSession = nativeResume()
  const f = fixture({ nativeSession })
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [events, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  const methods = f.messages.filter((message) => message.method).map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize', 'authenticate', 'session/load', 'session/set_config_option', 'session/prompt',
  ])
  const load = f.messages.find((message) => message.method === 'session/load')
  assert.equal(load.params.sessionId, 'vendor-devin-1')
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.equal(prompt.params.prompt[0].text, 'RESUME PROMPT')
  assert.deepEqual(nativeSession.adopted, ['vendor-devin-1'])
  assert.equal(events.some((event) => event.type === 'text-delta' && event.text.includes('OLD REPLAY')), false)
  assert.equal(result.stopReason, 'completed')
})

test('failed session/load falls back to a fresh native session', async () => {
  const nativeSession = nativeResume()
  const f = fixture({ nativeSession, resumeFails: true })
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  const methods = f.messages.filter((message) => message.method).map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize', 'authenticate', 'session/load', 'session/new', 'session/set_config_option', 'session/prompt',
  ])
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.equal(prompt.params.prompt[0].text, 'FULL PROMPT')
  assert.equal(nativeSession.mode, 'fresh')
  assert.deepEqual(nativeSession.adopted, ['session-devin'])
  assert.equal(result.stopReason, 'completed')
})

test('abort sends session/cancel and reports aborted', async () => {
  const f = fixture()
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate

  f.controller.abort()
  const [events, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'aborted')
  assert.equal(f.messages.some((message) => message.method === 'session/cancel'
    && message.params.sessionId === 'session-devin'), true)
  assert.equal(events.at(-1)?.type, 'activity')
})

test('a turn without tool work still completes on end_turn', async () => {
  const f = fixture({ modeOptions: null })
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  assert.equal(f.messages.some((message) => message.method === 'session/set_config_option'), false)
})

test('Devin ACP sends attached images as native image content blocks', async () => {
  const f = fixture({
    attachments: { imageHostPath: (ref) => ref?.attachmentId === 'img-1' ? '/host/img.png' : undefined },
    readFile: async (path) => { assert.equal(path, '/host/img.png'); return Buffer.from('PNGDATA') },
  })
  f.request.images = [{ attachment: { attachmentId: 'img-1', mediaType: 'image/png', bytes: 7, width: 1, height: 1 } }]

  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.deepEqual(prompt.params.prompt, [
    { type: 'image', data: Buffer.from('PNGDATA').toString('base64'), mimeType: 'image/png' },
    { type: 'text', text: 'do work' },
  ])
})

test('Devin ACP degrades to host path references when the image capability is missing', async () => {
  const f = fixture({
    imageCapable: false,
    attachments: { imageHostPath: () => '/host/img.png' },
    readFile: async () => Buffer.from('PNGDATA'),
  })
  f.request.images = [{ attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }]

  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.equal(prompt.params.prompt.length, 1)
  assert.equal(prompt.params.prompt[0].type, 'text')
  assert.match(prompt.params.prompt[0].text, /\/host\/img\.png/)
})

test('Devin ACP accepts inline base64 image blocks without an attachment service', async () => {
  const f = fixture()

  const run = await startDevinAcpRun(f.deps, {
    ...f.request,
    prompt: [
      { type: 'image', data: 'aW5saW5l', mediaType: 'image/png' },
      { type: 'text', text: 'describe' },
    ],
  })
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.deepEqual(prompt.params.prompt, [
    { type: 'image', data: 'aW5saW5l', mimeType: 'image/png' },
    { type: 'text', text: 'describe' },
  ])
})

test('Devin API key falls back to WINDSURF_API_KEY when DEVIN_API_KEY is absent', async () => {
  const f = fixture({ env: { WINDSURF_API_KEY: 'wind-key' } })
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const authenticate = f.messages.find((message) => message.method === 'authenticate')
  assert.equal(authenticate.params._meta.api_key, 'wind-key')
})

test('Devin ACP auto-approves canonical tool permissions and declines user-question requests', async () => {
  const f = fixture()
  const run = await startDevinAcpRun(f.deps, f.request)
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const toolApproval = f.messages.find((message) => message.id === 99)
  const questionRequest = f.messages.find((message) => message.id === 100)
  assert.deepEqual(toolApproval.result, { outcome: { outcome: 'selected', optionId: 'approve_once' } })
  assert.deepEqual(questionRequest.result, { outcome: { outcome: 'cancelled' } })
})

test('Devin ACP sends images on a resumed native session through session/load', async () => {
  const nativeSession = nativeResume()
  const f = fixture({
    nativeSession,
    attachments: { imageHostPath: (ref) => ref?.attachmentId === 'img-1' ? '/host/img.png' : undefined },
    readFile: async () => Buffer.from('PNGDATA'),
  })
  const run = await startDevinAcpRun(f.deps, {
    ...f.request,
    images: [{ attachment: { attachmentId: 'img-1', mediaType: 'image/png' } }],
  })
  const eventPromise = collect(run.stream)
  await f.terminalGate
  f.spawns[0].handle.complete()
  const [, result] = await Promise.all([eventPromise, run.result])
  await run.dispose()

  assert.equal(result.stopReason, 'completed')
  const methods = f.messages.filter((message) => message.method).map((message) => message.method)
  assert.deepEqual(methods, [
    'initialize', 'authenticate', 'session/load', 'session/set_config_option', 'session/prompt',
  ])
  const prompt = f.messages.find((message) => message.method === 'session/prompt')
  assert.deepEqual(prompt.params.prompt[0], {
    type: 'image',
    data: Buffer.from('PNGDATA').toString('base64'),
    mimeType: 'image/png',
  })
})
