import assert from 'node:assert/strict'
import test from 'node:test'

import { trustedMutation } from '../lib/index.js'

function request(host, origin = `http://${host}`) {
  return { headers: {
    host,
    origin,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  } }
}

test('selection mutation accepts the current loopback Web authority', () => {
  assert.equal(trustedMutation(request('127.0.0.1:3080')), true)
  assert.equal(trustedMutation(request('localhost:3080')), true)
})

test('selection mutation rejects DNS-rebinding and mismatched origins', () => {
  assert.equal(trustedMutation(request('attacker.example:3080')), false)
  // fork 语义:loopback Host + same-origin 元数据 + JSON Content-Type 即放行,
  // Origin host 不一致由 dsh-bridge 的 cookie/token_and_password 在更外层兜底。
  assert.equal(trustedMutation(request('127.0.0.1:3080', 'http://127.0.0.1:9999')), true)
  assert.equal(trustedMutation({ headers: { ...request('127.0.0.1:3080').headers, 'sec-fetch-site': 'cross-site' } }), false)
})
