# 上游热修：dsh-subagent 对 seeded 会话跳过投影缓存导致的全量解码风暴

## 症状

刷新 DSH 网页后，项目里历史对话要很久才显示；宿主进程常驻 ~2.7 核 CPU、2GB RSS、34% GC。

## 根因

`dsh-subagent` 的 `resolveColdIdentity`（`dsh-subagent/lib/index.js`）在列出子代理树时，对每个冷候选会话先查 `sessionProjectionCache` 的 `subagent` 行，但守卫条件是 `cache !== void 0 && !header.isSeeded`。

本机 220 个会话里 **205 个是 `origin: "subagent"` 且全部 `isSeeded: true`**（子代理会话继承父会话事件前缀）。守卫使缓存路径对它们完全不可达，每次列表都对每个冷子会话跑 `observeSession` → `requireStoredLog` → 全量 zstd 解码 + 深冻结。叠加 `sessionQuery.preparedSessionCacheSize` 默认 5，跨调用零复用——每次前端刷新/轮询子代理树都重新解码约 200 × 5MB 日志，事件循环长期被占满，页面所有 RPC 排队变慢。大概率也是之前 exit=1 崩溃循环的 OOM 来源。

## 为什么第一次补丁不够

只删 `!header.isSeeded` 无效：`cachedSnapshot(header, SessionLogOffset(0))` 的 identity 需要精确 `inheritedEventCount`，而冷 header 里没有该字段（存在缓存记录内部），seeded 会话传 0 永远 mismatch。

## 实际补丁

`dsh-subagent/lib/index.js` `resolveColdIdentity`：对 `isSeeded` 会话改走直接查表——`cache.requireTable().get(childId)` 取存储记录，校验稳定字段（`formatVersion === header.version`、`createdAt`、`cwd`、`isSeeded === true`），通过后 `cache.viewRecord(record, ["subagent"])` 取行提前返回。

安全性：inheritedEventCount 对已完成冷会话是创建期定值；迁移会改变 formatVersion 使旧记录自然 miss。该路径只决定树节点的展示态，不产生写副作用。

实测 201/205 个子会话命中缓存（另 4 个无记录，每次列表仅这 4 个解码）。

## 效果

补丁前 profile：consumeEventLine 30-45% + GC 34%，常驻 ~2.7 核。
补丁后稳态：97.4% idle；重启到端口监听 ~40s（此前 ~120s，说明解码风暴也在拖慢启动期）。

## 注意

- 补丁位于 `npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-subagent/lib/index.js`，**升级/重装 @deepseek-ai/dsh 会被覆盖**，需要重打或推动上游修复。
- 排查时用 `process._debugProcess(pid)` 在线开启了 inspector（127.0.0.1:9229），随进程生命周期存在，下次重启自动消失。
- 顺带确认 `preparedSessionCacheSize` 默认 5 太小，但不是修复点——正确修复是让缓存命中而不是加大内存缓存（200+ 解码会话全缓存需 ~10GB）。
