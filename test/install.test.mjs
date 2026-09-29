import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

async function copyInstaller(repoRoot) {
  const setupDir = join(repoRoot, 'setup')
  await mkdir(setupDir, { recursive: true })
  await copyFile(join(ROOT, 'setup', 'install.mjs'), join(setupDir, 'install.mjs'))
  await copyFile(join(ROOT, 'setup', 'gen-preset-patch.mjs'), join(setupDir, 'gen-preset-patch.mjs'))
  await copyFile(join(ROOT, 'preset.yml'), join(repoRoot, 'preset.yml'))
  await copyFile(join(ROOT, 'agent.cordis.yml'), join(repoRoot, 'agent.cordis.yml'))
}

async function writeProfile(dir, name = 'fixture-profile') {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name,
    private: true,
    dependencies: { existing: '1.0.0' },
    dsh: { profile: { bundles: ['existing'] } },
  }, null, 2))
}

test('Windows installer invokes pnpm through Node instead of pnpm.cmd', async () => {
  const source = await readFile(join(ROOT, 'setup', 'install.mjs'), 'utf8')

  assert.match(source, /execFileSync\(process\.execPath/)
  assert.match(source, /'node_modules', 'pnpm', 'bin', 'pnpm\.cjs'/)
  assert.doesNotMatch(source, /execFileSync\('pnpm\.cmd'/)
})

test('installer links one fixed harness-ally preset into the Web Profile idempotently', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ally-install-'))
  const presetRoot = join(dshHome, '.agent-presets', 'harness-ally')
  const profileDir = join(dshHome, 'profiles', 'web')
  await copyInstaller(presetRoot)
  await writeProfile(profileDir, 'fixture-web-profile')

  const run = () => spawnSync(process.execPath, [join(presetRoot, 'setup', 'install.mjs'), '--skip-pnpm'], {
    env: { ...process.env, DSH_HOME: dshHome },
    encoding: 'utf8',
  })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  const installed = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.equal(installed.dependencies['dsh-ally'], 'link:../../.agent-presets/harness-ally')
  assert.deepEqual(installed.dsh.profile.bundles, ['existing', 'dsh-ally'])

  const second = run()
  assert.equal(second.status, 0, second.stderr)
  assert.deepEqual(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')), installed)

  const presetPatch = await readFile(join(presetRoot, 'preset.patch.yml'), 'utf8')
  assert.match(presetPatch, /id: preset-harness-ally/)
  assert.match(presetPatch, /name: '@deepseek-ai\/dsh-agent-preset'/)
  assert.match(presetPatch, /id: harness-ally/)
})

test('installer prefers the desktop profile and accepts --profile override', async () => {
  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-ally-desktop-'))
  const repoRoot = join(dshHome, 'src', 'dsh-harness-ally')
  await copyInstaller(repoRoot)
  const webDir = join(dshHome, 'profiles', 'web')
  const desktopDir = join(dshHome, 'profiles', 'desktop')
  await writeProfile(webDir, 'fixture-web-profile')
  await writeProfile(desktopDir, 'fixture-desktop-profile')
  const installer = join(repoRoot, 'setup', 'install.mjs')
  const env = { ...process.env, DSH_HOME: dshHome }

  // 两个 Profile 都存在时默认写入 desktop（桌面版独占管理该目录）。
  const defaulted = spawnSync(process.execPath, [installer, '--skip-pnpm'], { env, encoding: 'utf8' })
  assert.equal(defaulted.status, 0, defaulted.stderr)
  const desktop = JSON.parse(await readFile(join(desktopDir, 'package.json'), 'utf8'))
  assert.equal(desktop.dependencies['dsh-ally'], 'link:../../src/dsh-harness-ally')
  assert.deepEqual(desktop.dsh.profile.bundles, ['existing', 'dsh-ally'])
  const web = JSON.parse(await readFile(join(webDir, 'package.json'), 'utf8'))
  assert.equal(web.dependencies['dsh-ally'], undefined)

  // 显式 --profile 仍可指向 web。
  const explicit = spawnSync(process.execPath, [installer, '--profile', 'web', '--skip-pnpm'], { env, encoding: 'utf8' })
  assert.equal(explicit.status, 0, explicit.stderr)
  const webAfter = JSON.parse(await readFile(join(webDir, 'package.json'), 'utf8'))
  assert.equal(webAfter.dependencies['dsh-ally'], 'link:../../src/dsh-harness-ally')

  // 不存在的 Profile 直接报错。
  const missing = spawnSync(process.execPath, [installer, '--profile', 'nope', '--skip-pnpm'], { env, encoding: 'utf8' })
  assert.notEqual(missing.status, 0)
  assert.match(missing.stderr, /未找到 Profile/)
})
