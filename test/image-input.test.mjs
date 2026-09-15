import assert from 'node:assert/strict'
import test from 'node:test'

import {
  collectImageInputs,
  imagePathFallback,
  requestImageInputs,
  resolveImageInputs,
} from '../lib/image-input.js'

test('collectImageInputs picks attachment refs and inline data, skipping other blocks', () => {
  const blocks = [
    { type: 'text', text: 'look at this' },
    { type: 'image', attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    { type: 'reasoning', text: 'noise' },
    { type: 'image', data: 'aW5saW5l', mediaType: 'image/jpeg' },
    { type: 'image' },
    { type: 'image', attachment: {} },
  ]
  assert.deepEqual(collectImageInputs(blocks), [
    { attachment: { attachmentId: 'a1', mediaType: 'image/png' } },
    { data: 'aW5saW5l', mediaType: 'image/jpeg' },
  ])
})

test('requestImageInputs prefers request.images over prompt blocks', () => {
  const viaImages = { images: [{ attachment: { attachmentId: 'x' } }], prompt: [{ type: 'image', data: 'aGk=' }] }
  assert.deepEqual(requestImageInputs(viaImages), [{ attachment: { attachmentId: 'x' } }])
  const viaPrompt = { prompt: [{ type: 'image', data: 'aGk=' }] }
  assert.deepEqual(requestImageInputs(viaPrompt), [{ data: 'aGk=', mediaType: undefined }])
  assert.deepEqual(requestImageInputs({ prompt: [{ type: 'text', text: 'plain' }] }), [])
})

test('resolveImageInputs resolves attachment refs through the attachments service', async () => {
  const deps = {
    attachments: { imageHostPath: (ref) => `/host/${ref.attachmentId}.png` },
    async readFile(path) { return Buffer.from(`BYTES:${path}`) },
  }
  const resolved = await resolveImageInputs(deps, [
    { attachment: { attachmentId: 'img-1', mediaType: 'image/png' } },
    { attachment: { attachmentId: 'img-2', mediaType: 'image/webp' } },
    { data: 'aW5saW5l', mediaType: 'image/jpeg' },
  ])
  assert.deepEqual(resolved, [
    { path: '/host/img-1.png', data: Buffer.from('BYTES:/host/img-1.png').toString('base64'), mediaType: 'image/png' },
    { path: '/host/img-2.png', data: Buffer.from('BYTES:/host/img-2.png').toString('base64'), mediaType: 'image/webp' },
    { data: 'aW5saW5l', mediaType: 'image/jpeg' },
  ])
})

test('resolveImageInputs fails closed when the attachments service is absent or cannot map the ref', async () => {
  await assert.rejects(
    resolveImageInputs({}, [{ attachment: { attachmentId: 'x' } }]),
    /无法解析图片附件/,
  )
  await assert.rejects(
    resolveImageInputs({ attachments: { imageHostPath: () => undefined } }, [{ attachment: { attachmentId: 'x' } }]),
    /无法解析图片附件/,
  )
})

test('resolveImageInputs propagates read failures', async () => {
  const deps = {
    attachments: { imageHostPath: () => '/host/img.png' },
    async readFile() { throw new Error('ENOENT') },
  }
  await assert.rejects(resolveImageInputs(deps, [{ attachment: { attachmentId: 'x' } }]), /ENOENT/)
})

test('imagePathFallback appends host paths when every image has one', () => {
  const text = imagePathFallback('do work', [
    { path: '/host/a.png', data: 'x', mediaType: 'image/png' },
    { path: '/host/b.png', data: 'y', mediaType: 'image/png' },
  ])
  assert.match(text, /^do work/)
  assert.match(text, /- \/host\/a\.png\n- \/host\/b\.png/)
})

test('imagePathFallback refuses when an image has no host path (inline-only)', () => {
  assert.throws(
    () => imagePathFallback('do work', [{ data: 'x', mediaType: 'image/png' }]),
    /无法解析图片附件/,
  )
})

import {
  collectFileInputs,
  filePathFallback,
  requestFileInputs,
  resolveFileInputs,
} from '../lib/image-input.js'

test('collectFileInputs picks file attachment refs only', () => {
  const blocks = [
    { type: 'file', attachment: { attachmentId: 'f1', name: 'a.pdf' } },
    { type: 'text', text: 'read it' },
    { type: 'image', attachment: { attachmentId: 'i1' } },
    { type: 'file' },
    { type: 'file', attachment: {} },
  ]
  assert.deepEqual(collectFileInputs(blocks), [{ attachment: { attachmentId: 'f1', name: 'a.pdf' } }])
})

test('requestFileInputs prefers request.files over prompt blocks', () => {
  const viaFiles = { files: [{ attachment: { attachmentId: 'x' } }], prompt: [{ type: 'file', attachment: { attachmentId: 'y' } }] }
  assert.deepEqual(requestFileInputs(viaFiles), [{ attachment: { attachmentId: 'x' } }])
  const viaPrompt = { prompt: [{ type: 'file', attachment: { attachmentId: 'y' } }] }
  assert.deepEqual(requestFileInputs(viaPrompt), [{ attachment: { attachmentId: 'y' } }])
})

test('resolveFileInputs maps refs to host paths and inlines small text files', async () => {
  const deps = {
    attachments: { fileHostPath: (ref) => `/host/${ref.attachmentId}` },
    readFile: async (path) => path === '/host/f1' ? Buffer.from('SECRET_WORD') : Buffer.from([0, 1, 2, 255]),
  }
  const resolved = await resolveFileInputs(deps, [
    { attachment: { attachmentId: 'f1', name: 'a.txt', bytes: 11 } },
    { attachment: { attachmentId: 'f2', name: 'a.bin', bytes: 4 } },
    { attachment: { attachmentId: 'f3' } },
  ])
  assert.deepEqual(resolved, [
    { path: '/host/f1', name: 'a.txt', content: 'SECRET_WORD' },
    { path: '/host/f2', name: 'a.bin' },
    { path: '/host/f3', name: undefined },
  ])
})

test('resolveFileInputs keeps path-only when the read fails or the file is too large', async () => {
  const deps = {
    attachments: { fileHostPath: (ref) => `/host/${ref.attachmentId}` },
    readFile: async () => { throw new Error('EACCES') },
  }
  const resolved = await resolveFileInputs(deps, [
    { attachment: { attachmentId: 'f1', bytes: 10 } },
    { attachment: { attachmentId: 'big', bytes: 128 * 1024 } },
  ])
  assert.deepEqual(resolved, [
    { path: '/host/f1', name: undefined },
    { path: '/host/big', name: undefined },
  ])
})

test('resolveFileInputs fails closed without a host path', async () => {
  await assert.rejects(() => resolveFileInputs({}, [{ attachment: { attachmentId: 'x' } }]), /无法解析文件附件/)
  const deps = { attachments: { fileHostPath: () => undefined } }
  await assert.rejects(() => resolveFileInputs(deps, [{ attachment: { attachmentId: 'x' } }]), /无法解析文件附件/)
})

test('filePathFallback inlines content and falls back to paths for binary files', () => {
  const text = filePathFallback('read this', [
    { path: '/host/a.txt', name: 'a.txt', content: 'SECRET_WORD' },
    { path: '/host/b.bin', name: 'b.bin' },
  ])
  assert.match(text, /^read this/)
  assert.match(text, /--- a\.txt \(\/host\/a\.txt\) ---\nSECRET_WORD\n--- end of a\.txt ---/)
  assert.match(text, /file-read tool/)
  assert.match(text, /\/host\/b\.bin/)
})
