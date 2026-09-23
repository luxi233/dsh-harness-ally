# 投影缓存 seeded 兜底 shim（替代 node_modules 补丁）

## 问题

刷新页面后历史对话/子代理树加载极慢。根因：`dsh-subagent` 的 `resolveColdIdentity`
对每个冷子会话调 `cache.cachedSnapshot(header, offset0, ['subagent'])`，而上游
`identityMatches` 要求 `inheritedEventCount` 精确相等——冷 header 里没有这个字段
（只在缓存记录内部），seeded 子会话必然 miss → 退化为 `observeSession` 全量解码
zstd 日志。本机 205 个子代理会话 × ~5MB → 每次列表 ~2.7 核 CPU + 34% GC。

## 为什么选 shim 而不是继续打 node_modules 补丁

最初修复直接改了 `dsh-subagent/lib/index.js`（2026-09-22 hotfix），但每次升级
`@deepseek-ai/dsh` 会被覆盖。shim 方案把同样的语义挂到 `sessionProjectionCache`
**服务实例**上——cordis `ctx.get` 返回的就是这个实例，包装其 `cachedSnapshot`
即对所有调用方生效，插件随 fork 发布，升级无损。

## 实现（lib/projection-cache-shim.js）

- `ctx.inject(['sessionProjectionCache'], cb)`：服务缺席时安静跳过（不阻塞
  插件加载）；cordis `notify → fiber._refresh` 使服务重挂载时自动重新武装，
  返回的 disposer 恢复原始方法。
- 兜底仅在 `严格 miss && meta.isSeeded && offset === 0` 时触发：直接查
  `requireTable().get(id)`，验证 `formatVersion/createdAt/cwd/isSeeded` 后
  `viewRecord(record, keys)`。`inheritedEventCount` 是唯一无法验证的字段，
  但同 id 不同生命周期必在 `createdAt` 上区分，语义与上游校验等价。
- caller 传非零 offset 仍 miss 时**不**兜底——那说明记录属于继承前缀不同的
  另一条生命周期，尊重严格校验的结论。
- `SHIM_MARK` 防止重复包装（HMR/二次 apply）。
- `shimStatus()` 暴露 `{armed, hits, misses}`，挂进 `/ally/model-diag` 便于
  观测（supervisor 下子进程 stdout 不落盘，HTTP 是唯一可靠观测面）。

## 放弃的方案

- **包装 `sessionQuery.observeSession`**：返回合成 observation 可满足
  resolveColdIdentity，但该方法也被会话恢复等真实读路径调用，伪造对象会
  破坏其它消费者。风险太大。
- **改 `preparedSessionCacheSize` 配置**：只是把重解码从「每次列表」摊薄成
  「每 5 条」，不治本。
- **同时兜底 `cachedPredecessorTitle`**：其身份语义是「上一代生命周期」
  （`formatVersion < expected`），与 seeded 当前生命周期正交，硬套会改变
  语义。留待上游。

## 验证

- 9 个单测覆盖：命中短路/seeded 兜底/字段漂移/无记录/表读异常/dispose 恢复。
- 实机：node_modules 补丁已回退，重启后 `armed: true`；刷新页面触发列表后
  `hits` 应跳至 ~200（201/205 子会话有缓存记录）。

## 注意

- 上游若修复（给 header 带 inheritedEventCount 或放宽校验），shim 退化为
  no-op，无副作用。
- exit=1 的周期性崩溃（启动后 ~70s）在 shim 之前就存在，仍需观察是否与
  解码风暴同源。
