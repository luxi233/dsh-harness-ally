import { readFile } from 'node:fs/promises'

export const IMAGE_UNRESOLVABLE = '外部 Harness 无法解析图片附件，请为本回合切换到 DSH'

// 收集 prompt block 里的图片输入:已 admission 的 attachment 引用,或内联 base64。
export function collectImageInputs(blocks) {
  const images = []
  for (const block of blocks ?? []) {
    if (block?.type !== 'image') continue
    if (block.attachment && typeof block.attachment === 'object' && block.attachment.attachmentId) {
      images.push({ attachment: block.attachment })
    } else if (typeof block.data === 'string' && block.data) {
      images.push({ data: block.data, mediaType: block.mediaType })
    }
  }
  return images
}

// 前台回合的图片由 runtime 从 canonical 视图收集后放在 request.images;
// one-shot provider 路径直接从 request.prompt blocks 提取。
export function requestImageInputs(request) {
  return request.images?.length ? request.images : collectImageInputs(request.prompt)
}

// 解析为 { data(base64), path?, mediaType }:attachment ref 经 attachments
// 服务映射到宿主机文件路径并读出字节;内联 data 原样透传。
export async function resolveImageInputs(deps, images) {
  const resolved = []
  for (const image of images ?? []) {
    if (typeof image?.data === 'string' && image.data) {
      resolved.push({ data: image.data, mediaType: image.mediaType || 'image/png' })
      continue
    }
    const ref = image?.attachment
    const path = ref ? deps.attachments?.imageHostPath?.(ref) : undefined
    if (typeof path !== 'string' || !path) throw new Error(IMAGE_UNRESOLVABLE)
    const buffer = await (deps.readFile ?? readFile)(path)
    resolved.push({ path, data: buffer.toString('base64'), mediaType: ref.mediaType || 'image/png' })
  }
  return resolved
}

// 图片通道不可用时的兜底:attachment 引用始终有宿主路径,把路径写进
// prompt 文本让模型用自己的文件工具读图;纯内联 data 无路径可引用,只能拒绝。
export function imagePathFallback(prompt, resolved) {
  const paths = resolved.map((image) => image.path).filter(Boolean)
  if (paths.length !== resolved.length || paths.length === 0) throw new Error(IMAGE_UNRESOLVABLE)
  const list = paths.map((path) => `- ${path}`).join('\n')
  return `${prompt}\n\nThe user attached image file(s) on the host filesystem. Inspect them with your file-read tool before answering:\n${list}`
}

export const FILE_UNRESOLVABLE = '外部 Harness 无法解析文件附件，请为本回合切换到 DSH'

// 收集 prompt block 里的文件附件:文件永远是已 admission 的 attachment 引用,
// 没有内联形态。无 ref 的畸形块不收集,由调用方决定拒绝。
export function collectFileInputs(blocks) {
  const files = []
  for (const block of blocks ?? []) {
    if (block?.type !== 'file') continue
    const ref = block.attachment
    if (ref && typeof ref === 'object' && ref.attachmentId) files.push({ attachment: ref })
  }
  return files
}

export function requestFileInputs(request) {
  return request.files?.length ? request.files : collectFileInputs(request.prompt)
}

// 文件只走宿主路径引用:attachment ref 经 attachments.fileHostPath 映射到
// 宿主机绝对路径。小文件直接读出字节 inline 进 prompt——路径引用依赖模型
// 主动调用读文件工具,实测弱模型会忽略指令直接复述上下文;内容内联后
// 模型必然能看到。超过 INLINE 上限或读失败的仍退化为路径引用。
const FILE_INLINE_BYTES = 64 * 1024

function looksTextual(buffer) {
  const sample = buffer.subarray(0, 512)
  for (const byte of sample) {
    if (byte === 0) return false
  }
  try {
    new TextDecoder('utf8', { fatal: true }).decode(sample)
    return true
  } catch {
    return false
  }
}

export async function resolveFileInputs(deps, files) {
  const resolved = []
  for (const file of files ?? []) {
    const ref = file?.attachment
    const path = ref ? deps.attachments?.fileHostPath?.(ref) : undefined
    if (typeof path !== 'string' || !path) throw new Error(FILE_UNRESOLVABLE)
    const entry = { path, name: typeof ref.name === 'string' ? ref.name : undefined }
    if (typeof ref.bytes === 'number' && ref.bytes <= FILE_INLINE_BYTES) {
      try {
        const buffer = await (deps.readFile ?? readFile)(path)
        if (buffer.byteLength <= FILE_INLINE_BYTES && looksTextual(buffer)) entry.content = buffer.toString('utf8')
      } catch {}
    }
    resolved.push(entry)
  }
  return resolved
}

export function filePathFallback(prompt, resolved) {
  if (!resolved.length || resolved.some((file) => typeof file.path !== 'string' || !file.path)) {
    throw new Error(FILE_UNRESOLVABLE)
  }
  const sections = resolved.map((file) => {
    const label = file.name ?? file.path
    if (typeof file.content === 'string') {
      return `--- ${label} (${file.path}) ---\n${file.content}\n--- end of ${label} ---`
    }
    return `--- ${label} ---\nBinary or large file on the host filesystem at ${file.path}. Inspect it with your file-read tool before answering.`
  })
  return `${prompt}\n\nThe user attached file(s). Their contents follow; use them before answering:\n${sections.join('\n\n')}`
}
