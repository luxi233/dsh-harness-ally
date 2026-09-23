// dsh-session-projection-cache 的 cachedSnapshot 身份校验要求调用方传入
// inheritedEventCount(精确继承前缀长度),参与构成生命周期身份
// (identityMatches: formatVersion + createdAt + cwd + isSeeded +
// inheritedEventCount 全部相等才命中)。
//
// 冷会话 header 里没有 inheritedEventCount 字段——它只存在缓存记录内部。
// 子代理会话全是 seeded(继承父会话事件前缀),而 dsh-subagent 的列表路径
// 只能传 offset 0 → 身份校验必然 miss → 每个冷子会话退化为
// observeSession 全量解码 zstd 日志。本机 205 个子代理会话时,每次刷新/
// 列表触发 ~200 × 5MB 解码 + 深冻结,CPU 持续 2-3 核、GC ~34%。
//
// 绕不开校验的只是「调用方不知道 inheritedEventCount」这一件事——记录的
// 其余身份字段足以区分同一 id 下的不同生命周期。本 shim 在严格路径 miss
// 且 caller 传 offset 0 的 seeded header 上,直接查表验证稳定字段后走
// viewRecord,与上游在 dsh-subagent 内的修复语义一致,但挂在服务实例上,
// DSH 升级不会丢。
//
// ctx.inject 确保:服务后挂载时 shim 自动生效;服务重挂载时 cordis 会
// dispose 本 fiber(走返回的清理恢复原始方法)再以新实例重跑回调。

const SHIM_MARK = Symbol.for('ally.seededProjectionCacheShim')

const shimState = { armed: false, hits: 0, misses: 0 }
export const shimStatus = () => ({ ...shimState })

export function shimProjectionCache(ctx) {
  ctx.inject(['sessionProjectionCache'], (innerCtx) => {
    const cache = innerCtx.get('sessionProjectionCache')
    if (cache === undefined
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.requireTable !== 'function'
      || typeof cache.viewRecord !== 'function') return undefined
    if (cache.cachedSnapshot[SHIM_MARK] === true) return undefined
    const original = cache.cachedSnapshot.bind(cache)
    const wrapped = (meta, inheritedEventCount, keys) => {
      const hit = original(meta, inheritedEventCount, keys)
      // 只在「严格路径 miss + seeded header + caller 无法提供继承前缀
      // (offset 0)」时兜底;caller 传了非零 offset 仍 miss 说明记录属于
      // 另一条继承前缀不同的生命周期,尊重 miss。
      if (hit !== undefined || meta?.isSeeded !== true || Number(inheritedEventCount) !== 0) return hit
      try {
        const record = cache.requireTable().get(meta.id)
        const identity = record?.identity
        if (identity === undefined
          || identity.formatVersion !== meta.version
          || identity.createdAt !== meta.createdAt
          || (identity.isSeeded ?? false) !== true
          || (meta.cwd !== undefined && identity.cwd !== meta.cwd)) {
          shimState.misses++
          return hit
        }
        const view = cache.viewRecord(record, keys)
        if (view !== undefined) shimState.hits++
        return view
      } catch {
        return hit
      }
    }
    wrapped[SHIM_MARK] = true
    cache.cachedSnapshot = wrapped
    shimState.armed = true
    innerCtx.logger?.info?.('ally: seeded projection-cache fallback armed')
    return () => {
      shimState.armed = false
      if (cache.cachedSnapshot === wrapped) cache.cachedSnapshot = original
    }
  })
}
