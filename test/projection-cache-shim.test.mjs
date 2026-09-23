import assert from 'node:assert/strict'
import test from 'node:test'

import { shimProjectionCache } from '../lib/projection-cache-shim.js'

// 模拟 ctx.inject:立即执行回调并返回其清理函数
function fixture(cache) {
  const ctx = {
    inject(deps, cb) {
      assert.deepEqual(deps, ['sessionProjectionCache'])
      const inner = { get: (name) => (name === 'sessionProjectionCache' ? cache : undefined) }
      return cb(inner)
    },
  }
  shimProjectionCache(ctx)
}

function cacheWith({ record, strictHit } = {}) {
  return {
    requireTable: () => ({ get: () => record }),
    viewRecord: (rec, keys) => ({ asOfSeq: rec.rows.subagent.seq, values: { subagent: rec.rows.subagent.value } }),
    cachedSnapshot(meta, offset, keys) {
      if (strictHit) return { asOfSeq: 7, values: { subagent: { mode: 'one-shot', seq: 7 } } }
      return undefined
    },
  }
}

const seededHeader = { id: 's1', version: 3, createdAt: 100, cwd: '/w', isSeeded: true }
const seededRecord = {
  identity: { formatVersion: 3, createdAt: 100, cwd: '/w', isSeeded: true, inheritedEventCount: 40 },
  rows: { subagent: { seq: 42, value: { mode: 'continuable', label: 'child', seq: 42 } } },
}

test('seeded header + offset 0 + matching record → serves cached row', () => {
  const cache = cacheWith({ record: seededRecord })
  fixture(cache)
  const hit = cache.cachedSnapshot(seededHeader, 0, ['subagent'])
  assert.equal(hit.values.subagent.label, 'child')
  assert.equal(hit.asOfSeq, 42)
})

test('strict hit short-circuits without touching the table', () => {
  let tableReads = 0
  const cache = cacheWith({ strictHit: true })
  cache.requireTable = () => { tableReads++; return { get: () => undefined } }
  fixture(cache)
  const hit = cache.cachedSnapshot(seededHeader, 0, ['subagent'])
  assert.equal(hit.asOfSeq, 7)
  assert.equal(tableReads, 0)
})

test('unseeded header never falls back', () => {
  const cache = cacheWith({ record: { ...seededRecord, identity: { ...seededRecord.identity, isSeeded: false } } })
  fixture(cache)
  assert.equal(cache.cachedSnapshot({ ...seededHeader, isSeeded: false }, 0, ['subagent']), undefined)
})

test('nonzero offset never falls back', () => {
  const cache = cacheWith({ record: seededRecord })
  fixture(cache)
  assert.equal(cache.cachedSnapshot(seededHeader, 40, ['subagent']), undefined)
})

test('identity field mismatch → miss', () => {
  for (const drift of [{ createdAt: 999 }, { formatVersion: 4 }, { cwd: '/elsewhere' }]) {
    const record = { ...seededRecord, identity: { ...seededRecord.identity, ...drift } }
    const cache = cacheWith({ record })
    fixture(cache)
    assert.equal(cache.cachedSnapshot(seededHeader, 0, ['subagent']), undefined)
  }
})

test('absent record → miss', () => {
  const cache = cacheWith({ record: undefined })
  fixture(cache)
  assert.equal(cache.cachedSnapshot(seededHeader, 0, ['subagent']), undefined)
})

test('table read throwing → miss, never throws', () => {
  const cache = cacheWith({})
  cache.requireTable = () => { throw new Error('domain closed') }
  fixture(cache)
  assert.equal(cache.cachedSnapshot(seededHeader, 0, ['subagent']), undefined)
})

test('missing service → inject callback no-ops', () => {
  const ctx = { inject: (deps, cb) => cb({ get: () => undefined }) }
  assert.doesNotThrow(() => shimProjectionCache(ctx))
})

test('dispose restores the original method', () => {
  const cache = cacheWith({ record: seededRecord, strictHit: true })
  const original = cache.cachedSnapshot
  let dispose
  const ctx = { inject: (deps, cb) => { dispose = cb({ get: () => cache }) } }
  shimProjectionCache(ctx)
  assert.notEqual(cache.cachedSnapshot[Symbol.for('ally.seededProjectionCacheShim')], undefined)
  dispose()
  assert.equal(cache.cachedSnapshot[Symbol.for('ally.seededProjectionCacheShim')], undefined)
  // 恢复后走原实现:seeded+offset 0 不再兜底
  assert.equal(cache.cachedSnapshot(seededHeader, 0, ['subagent']).asOfSeq, 7)
})
