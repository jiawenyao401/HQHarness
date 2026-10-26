import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export const PROVIDER = 'huaqing-switch'
const protocolApis = {
  'openai-chat': 'openai-completions',
  'openai-responses': 'openai-responses',
  anthropic: 'anthropic-messages',
}

/** Read only the desktop-owned local capability; vendor credentials never cross this boundary. */
export async function readSwitchManifest(path, signal) {
  if (!path || !isAbsolute(path))
    throw new Error('Invalid Huaqing Switch discovery path')
  const stat = await lstat(path)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 16384 ||
    (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))
  )
    throw new Error('Huaqing Switch discovery permissions are invalid')
  const connector = JSON.parse(await readFile(path, 'utf8'))
  if (
    connector.version !== 1 ||
    connector.product !== PROVIDER ||
    !/^[a-f0-9]{64}$/.test(connector.token) ||
    connector.endpoint !== 'http://127.0.0.1:17621'
  )
    throw new Error('Invalid Huaqing Switch discovery data')
  const response = await fetch(`${connector.endpoint}/hq/manifest`, {
    redirect: 'error',
    headers: { Authorization: `Bearer ${connector.token}` },
    signal: AbortSignal.any([
      signal ?? new AbortController().signal,
      AbortSignal.timeout(5000),
    ]),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`Huaqing Switch metadata unavailable (${response.status})`)
  }
  if (Number(response.headers.get('content-length') ?? 0) > 512 * 1024) {
    await response.body?.cancel()
    throw new Error('Huaqing Switch metadata too large')
  }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty Huaqing Switch metadata')
  let size = 0
  const chunks = []
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.length
      if (size > 512 * 1024)
        throw new Error('Huaqing Switch metadata too large')
      chunks.push(next.value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (
    value.version !== 1 ||
    value.product !== PROVIDER ||
    !Array.isArray(value.models) ||
    value.models.length > 100
  )
    throw new Error('Invalid Huaqing Switch catalog')
  const ids = new Set()
  for (const model of value.models) {
    const match =
      typeof model.id === 'string' &&
      /^hq-([a-f0-9-]{36})-v([1-9][0-9]*)$/.exec(model.id)
    if (
      !match ||
      ids.has(model.id) ||
      typeof model.name !== 'string' ||
      !model.name.trim() ||
      model.name.length > 512 ||
      !Object.hasOwn(protocolApis, model.protocol) ||
      typeof model.supportsImages !== 'boolean' ||
      !Number.isSafeInteger(model.contextWindow) ||
      model.contextWindow < 1024 ||
      model.contextWindow > 2_000_000 ||
      !Number.isSafeInteger(model.maxOutputTokens) ||
      model.maxOutputTokens < 1 ||
      model.maxOutputTokens > model.contextWindow
    )
      throw new Error('Invalid Huaqing Switch model metadata')
    const expected = `${connector.endpoint}/hq/connections/${match[1]}/${match[2]}${model.protocol === 'anthropic' ? '' : '/v1'}`
    if (model.baseUrl !== expected)
      throw new Error(
        'Huaqing Switch model must use its authenticated loopback transport',
      )
    ids.add(model.id)
  }
  if (value.defaultModel !== null && !ids.has(value.defaultModel))
    throw new Error('Invalid Huaqing Switch default model')
  return { ...value, token: connector.token }
}

export function protocolApi(protocol) {
  return protocolApis[protocol]
}
