# devin-acp:剥离 IDE 泄漏的 WINDSURF_EXT_HOST_PID,修复"提前退出 exit 0"

## 现象

2026-09-27 起,DSH 里所有 devin 回合在握手后 ~2s 失败,诊断为
`Devin ACP 提前退出（exit 0）`。直接命令行握手、认证、session/new、
session/prompt 全部正常,凭据有效。

## 根因

devin acp 的宿主看门狗**不监视 OS 父进程**,而是读环境变量
`WINDSURF_EXT_HOST_PID`(Devin/Windsurf IDE 的扩展宿主 PID)。该变量
从 IDE 终端上下文泄漏进 DSH 进程环境(DSH/supervisor 是从 IDE 内启动的),
DSH spawn devin 时透传。当天 IDE 重启导致 PID 4744 死亡后,每个 devin
进程在 ~2s 检查时误判"宿主已退出"而自杀 exit 0——进程 stdout 的
`target-exit` 由存活的 job-runner 正常上报,因此插件侧只看到 exit 0。

证据:

- 失败 devin 日志全部打印 `ppid=4744 Parent process exited`,同一值,
  但 4744 在各次失败的时间点之间仍在"产生"新 devin —— 说明它不是
  OS 父进程,而是 env 里的陈旧值
- 二进制 strings 里存在 `WINDSURF_EXT_HOST_PID`
- 离线复现:父进程存活 + env 设死 PID → devin ~3s 自杀 exit 0;
  删除该变量 → 正常应答 session/new 且持续存活
- 我手动测试通过的原因:我的 shell 里该变量指向当前活着的 ext host

## 修复

`subprocess.spawn` 的 `env` 里传 `WINDSURF_EXT_HOST_PID: undefined`。
Windows job-runner 路径 `targetEnvironment()` 过滤 undefined 值;
fallback 的 node `spawn` 同样丢弃 undefined env 值(已验证)。两条路径
下该变量都不会出现在 devin 的环境中,看门狗无从触发。

## 为什么不选其它方案

- keeper/cmd 包裹父进程:无效——看门狗盯的是 env 里的 PID,不是 OS
  父进程
- 清 DSH 进程环境:不可行,插件不能改宿主环境,且 supervisor 重启
  会重新继承
- 同时剥 WINDSURF_IDE_TYPE / ACP_BACKEND:没有证据表明它们有害,
  保持最小变更

## 运维注意

- 若 devin CLI 未来引入其它 IDE 泄漏变量的看门狗,同类故障会复发——
  届时在 spawn env 里追加对应 `undefined` 条目即可
- 该问题只在"DSH 从 IDE 终端启动且 IDE 重启过"时触发;纯命令行启动
  DSH 不受影响
- `提前退出 exit 0` 诊断已带 stderr 尾部(ea21860 之后),但这次
  devin 不写 stderr——真相只在 CLI 自己的 log 文件里
  (`%APPDATA%/devin/cli/logs/`)
