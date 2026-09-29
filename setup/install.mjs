#!/usr/bin/env node
/**
 * Harness联盟模式跨平台安装脚本（DSH ≥ 0.2.0 桌面版 / dsh web 通用）：
 * 1. 由 preset.yml + agent.cordis.yml 重新生成 preset.patch.yml；
 * 2. 将仓库根目录作为 dsh-ally link 依赖写入目标 Profile；
 * 3. 将 dsh-ally 加入 Profile bundle 清单并执行 pnpm install。
 *
 * 目标 Profile：`--profile <name>` 显式指定；未指定时优先 desktop（桌面版
 * 独占管理 `profiles/desktop`），其次 web。仓库不再要求克隆到
 * ~/.dsh/.agent-presets/harness-ally —— 0.2.0 起 preset 经 bundle patch 声明，
 * `link:` 指向仓库实际位置即可。
 *
 * pnpm：`--pnpm <entry>` 或环境变量 DSH_PNPM_ENTRY 指定 pnpm.cjs/pnpm.mjs
 * 入口（用当前 Node 运行）；否则依次尝试 npm 全局 pnpm、桌面版随包
 * runtime/pnpm、PATH 上的 pnpm。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_NAME = 'dsh-ally'
const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
const DSH_HOME = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))

function readFlag(name) {
  const index = process.argv.indexOf(name)
  if (index === -1) return undefined
  return process.argv[index + 1]
}
const SKIP_PNPM = process.argv.includes('--skip-pnpm')
const PNPM_ENTRY_FLAG = readFlag('--pnpm') || process.env.DSH_PNPM_ENTRY
const PROFILE_FLAG = readFlag('--profile')

const fail = (message, hint) => {
  console.error(`❌ ${message}`)
  if (hint) console.error(`   ${hint}`)
  process.exit(1)
}

function resolveProfileDir() {
  if (PROFILE_FLAG !== undefined) {
    if (!PROFILE_FLAG || PROFILE_FLAG.startsWith('-')) {
      fail('--profile 需要 Profile 名称', '例如：node setup/install.mjs --profile desktop')
    }
    const dir = join(DSH_HOME, 'profiles', PROFILE_FLAG)
    if (!existsSync(join(dir, 'package.json'))) {
      fail(`未找到 Profile「${PROFILE_FLAG}」：${dir}`, '请先运行一次对应的应用，或检查 DSH_HOME。')
    }
    return { name: PROFILE_FLAG, dir }
  }
  for (const name of ['desktop', 'web']) {
    const dir = join(DSH_HOME, 'profiles', name)
    if (existsSync(join(dir, 'package.json'))) return { name, dir }
  }
  fail(`未找到任何 DSH Profile：${join(DSH_HOME, 'profiles')}`, '请先运行一次 DSH 桌面版（或 dsh web），再重新执行安装脚本。')
}

const { name: profileName, dir: PROFILE_DIR } = resolveProfileDir()
const PROFILE_PACKAGE = join(PROFILE_DIR, 'package.json')

// 1. 刷新生成的 preset.patch.yml（agent preset 在 0.2.0 经 bundle patch 声明）。
try {
  const { generatePresetPatch } = await import(new URL('./gen-preset-patch.mjs', import.meta.url))
  generatePresetPatch(ROOT)
  console.log('→ 已生成 preset.patch.yml')
} catch (error) {
  console.warn(`⚠️  未能生成 preset.patch.yml：${error.message}`)
  if (!existsSync(join(ROOT, 'preset.patch.yml'))) {
    fail('preset.patch.yml 缺失且无法生成', '仓库不完整，请重新克隆。')
  }
  console.warn('   将沿用仓库内已有的 preset.patch.yml。')
}

// 2-3. 写入 link 依赖与 bundle 清单。
const profile = JSON.parse(readFileSync(PROFILE_PACKAGE, 'utf8'))
profile.dependencies ||= {}
profile.dsh ||= {}
profile.dsh.profile ||= {}
profile.dsh.profile.bundles ||= []

const relativeRoot = relative(PROFILE_DIR, ROOT).split(sep).join('/')
const linkTarget = `link:${relativeRoot}`
let changed = false
if (profile.dependencies[PACKAGE_NAME] !== linkTarget) {
  profile.dependencies[PACKAGE_NAME] = linkTarget
  changed = true
  console.log(`+ ${PACKAGE_NAME}: ${linkTarget}`)
} else {
  console.log(`= ${PACKAGE_NAME} link 依赖已存在`)
}
if (!profile.dsh.profile.bundles.includes(PACKAGE_NAME)) {
  profile.dsh.profile.bundles.push(PACKAGE_NAME)
  changed = true
  console.log(`+ Profile bundle: ${PACKAGE_NAME}`)
} else {
  console.log(`= Profile bundle ${PACKAGE_NAME} 已存在`)
}

if (changed) {
  const temporary = `${PROFILE_PACKAGE}.dsh-ally.tmp`
  writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, PROFILE_PACKAGE)
}

if (!SKIP_PNPM) {
  console.log('→ 执行 pnpm install 建立本地 link…')
  const appdata = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  const localappdata = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const entries = [
    PNPM_ENTRY_FLAG,
    join(appdata, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    join(localappdata, 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs'),
  ].filter((entry) => entry && existsSync(entry))
  if (entries.length) {
    execFileSync(process.execPath, [entries[0], 'install'], {
      cwd: PROFILE_DIR,
      stdio: 'inherit',
    })
  } else {
    execFileSync('pnpm', ['install'], {
      cwd: PROFILE_DIR,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  }
}

console.log('')
console.log(`✅ Harness联盟模式已安装到 Profile「${profileName}」。`)
if (profileName === 'desktop') {
  console.log('   1. 重启 DSH 桌面版应用。')
} else {
  console.log('   1. 重启现有 dsh web 进程。')
}
console.log('   2. 新建「Harness联盟模式」会话。')
console.log('   3. 在「选择Harness」中选择 DeepSeek Harness、Claude Code 或 Codex。')
console.log('   Claude Code/Codex 缺失时，可直接使用选择菜单中的「安装」按钮。')
