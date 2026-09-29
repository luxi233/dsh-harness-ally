#!/usr/bin/env node
/**
 * 由 preset.yml + agent.cordis.yml 重新生成 preset.patch.yml。
 *
 * DSH ≥ 0.2.0 不再扫描 $DSH_HOME/.agent-presets/<id> 目录：agent preset 必须
 * 作为 `@deepseek-ai/dsh-agent-preset` 的 insert 行声明在 profile bundle patch
 * 里，完整组合以内联方式放在 `config.plugins` 下（与官方 standard preset 一致）。
 * preset.patch.yml 是生成产物，随仓库提交并由安装脚本刷新，请勿手改。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PRESET_ID = 'harness-ally'
export const PRESET_ORDER = 10
const GENERATOR_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))

function readPresetMeta(file) {
  const meta = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Za-z_][\w-]*):\s+(.+?)\s*$/.exec(line)
    if (match && meta[match[1]] === undefined) meta[match[1]] = match[2]
  }
  if (!meta.name || !meta.description) {
    throw new Error(`${file}: 缺少顶层 name/description 字段`)
  }
  return meta
}

/**
 * 生成 preset.patch.yml 内容。agent.cordis.yml 原样内联进 config.plugins：
 * 其中的 `./ally-prompt.mjs` 按 patch 文件所在目录（即本包根目录）解析，
 * 所以 link 或打包安装两种形态下都能定位。
 */
export function generatePresetPatch(root = GENERATOR_ROOT) {
  const meta = readPresetMeta(join(root, 'preset.yml'))
  const composition = readFileSync(join(root, 'agent.cordis.yml'), 'utf8')
  const plugins = composition
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.length ? `          ${line}` : line))
    .join('\n')
  const output = [
    '# GENERATED FILE — do not edit.',
    '# Regenerate with: node setup/gen-preset-patch.mjs',
    '# Sources: preset.yml (display metadata) + agent.cordis.yml (agent-plane',
    '# composition). DSH >= 0.2.0 declares agent presets as an insert row of',
    '# @deepseek-ai/dsh-agent-preset inside a profile bundle patch; the legacy',
    '# $DSH_HOME/.agent-presets/<id> directory scan no longer exists.',
    '- insert:',
    `    - id: preset-${PRESET_ID}`,
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    `        id: ${PRESET_ID}`,
    `        order: ${PRESET_ORDER}`,
    `        name: ${JSON.stringify(meta.name)}`,
    `        description: ${JSON.stringify(meta.description)}`,
    '        plugins:',
    plugins,
    '',
  ].join('\n')
  writeFileSync(join(root, 'preset.patch.yml'), output)
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  generatePresetPatch()
  console.log('✅ 已生成 preset.patch.yml')
}
