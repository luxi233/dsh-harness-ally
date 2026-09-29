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

test('desktop shell forwards carry no Origin but stay trusted over loopback', () => {
  // dsh-app:// 协议代理会剥掉 origin/sec-fetch-site/host 后再转发；
  // 转发后的请求带 loopback Host、无 Origin。
  const forwarded = { headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' } }
  assert.equal(trustedMutation(forwarded), true)
  // 非回环入口仍然要求 Origin
  const remote = { headers: { host: '113.31.118.243:3002', 'content-type': 'application/json' } }
  assert.equal(trustedMutation(remote), false)
})
