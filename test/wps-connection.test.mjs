import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { WebSocket } from 'ws'
import { WpsConnection } from '../src/main/wps/connection.ts'

const cleanups = []
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() }
  finally { vi.restoreAllMocks() }
})

async function fixture(timeout = 1000) {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const origin = `http://127.0.0.1:${server.address().port}`
  const secret = randomBytes(32).toString('hex')
  const connection = new WpsConnection(server, secret, () => origin, timeout)
  cleanups.push(() => connection.close())
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/${secret}/bridge/et`, { origin })
  cleanups.push(async () => { socket.terminate() })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  socket.send(JSON.stringify({ type: 'hello', protocol: 1, host: 'et', documents: [{ key: 'native-document', name: 'Book.xlsx', path: '', type: 'spreadsheet', readOnly: false, saved: false }] }))
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Missing Add-in handshake')), 1000)
    const poll = setInterval(() => {
      if (connection.documents().length) { clearInterval(poll); clearTimeout(timeout); resolve() }
    }, 5)
    cleanups.push(async () => { clearInterval(poll); clearTimeout(timeout) })
  })
  return { connection, socket, target: connection.documents()[0] }
}

function receive(socket) {
  return new Promise(resolve => socket.once('message', value => resolve(JSON.parse(value.toString()))))
}
function reply(socket, request, result) {
  socket.send(JSON.stringify({ type: 'result', id: request.id, result }))
}

describe('native WPS connection failure boundaries', () => {
  it('keeps an open peer usable when background throttling leaves metadata older than one minute', async () => {
    const f = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    // No documents heartbeat is sent after advancing the clock. Authorization
    // waits must not turn a live native socket into a stale metadata failure.
    expect(f.socket.readyState).toBe(WebSocket.OPEN)
    expect(f.connection.documents()).toEqual([f.target])
    expect(f.connection.components()).toEqual(['et'])
    expect(f.connection.resolve(f.target)).toEqual(f.target.document)
    const incoming = receive(f.socket)
    const pending = f.connection.execute(f.target, { action: 'inspect', snapshot: 'after-consent' }, new AbortController().signal)
    const request = await incoming
    expect(request.operation).toEqual({ action: 'inspect', snapshot: 'after-consent', key: 'native-document' })
    reply(f.socket, request, { ok: true, value: { snapshot: 'after-consent' } })
    await expect(pending).resolves.toEqual({ snapshot: 'after-consent' })
  })
  it('still rejects a disconnected peer after metadata has aged without dispatching an operation', async () => {
    const f = await fixture()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    const received = vi.fn()
    f.socket.on('message', received)
    const closed = new Promise(resolve => f.socket.once('close', resolve))
    f.socket.close()
    await closed
    await vi.waitFor(() => expect(f.connection.documents()).toEqual([]))
    expect(f.connection.components()).toEqual([])
    expect(() => f.connection.resolve(f.target)).toThrowError(expect.objectContaining({ code: 'WPS_NOT_CONNECTED', outcome: 'not_executed' }))
    await expect(f.connection.execute(f.target, { action: 'inspect' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WPS_NOT_CONNECTED', outcome: 'not_executed' })
    expect(received).not.toHaveBeenCalled()
  })
  it('rejects a removed document key as stale before dispatch while the same peer remains usable', async () => {
    const f = await fixture()
    const received = vi.fn()
    f.socket.on('message', received)
    f.socket.send(JSON.stringify({ type: 'documents', documents: [{ ...f.target.document, key: 'replacement-document' }] }))
    await vi.waitFor(() => expect(f.connection.documents()[0]?.document.key).toBe('replacement-document'))
    expect(f.connection.components()).toEqual(['et'])
    expect(() => f.connection.resolve(f.target)).toThrowError(expect.objectContaining({ code: 'WPS_STALE_DOCUMENT', outcome: 'not_executed' }))
    await expect(f.connection.execute(f.target, { action: 'sheet_write' }, new AbortController().signal)).rejects.toMatchObject({ code: 'WPS_STALE_DOCUMENT', outcome: 'not_executed' })
    expect(received).not.toHaveBeenCalled()
    const incoming = receive(f.socket)
    const pending = f.connection.execute(f.connection.documents()[0], { action: 'inspect', snapshot: 'replacement' }, new AbortController().signal)
    const request = await incoming
    expect(received).toHaveBeenCalledTimes(1)
    expect(request.operation.key).toBe('replacement-document')
    reply(f.socket, request, { ok: true, value: { snapshot: 'replacement' } })
    await expect(pending).resolves.toEqual({ snapshot: 'replacement' })
  })
  it('reports a timed-out write as unknown, ignores a late result and never replays it', async () => {
    const f = await fixture(250)
    const incoming = receive(f.socket)
    const write = f.connection.execute(f.target, { action: 'sheet_write', key: 'untrusted-model-key', snapshot: 's', nextSnapshot: 'n' }, new AbortController().signal)
    const assertion = expect(write).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown' })
    const request = await incoming
    expect(request.operation.key).toBe('native-document')
    await assertion
    const nextIncoming = receive(f.socket)
    const inspect = f.connection.execute(f.target, { action: 'inspect', snapshot: 'fresh' }, new AbortController().signal)
    const next = await nextIncoming
    expect(next.id).not.toBe(request.id)
    reply(f.socket, request, { ok: true, value: { snapshot: 'late' } })
    reply(f.socket, next, { ok: true, value: { snapshot: 'fresh' } })
    await expect(inspect).resolves.toEqual({ snapshot: 'fresh' })
  })
  it('rejects disconnection during dispatch as an unknown outcome', async () => {
    const f = await fixture()
    const incoming = receive(f.socket)
    const pending = f.connection.execute(f.target, { action: 'save' }, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'WPS_NOT_CONNECTED', outcome: 'unknown' })
    await incoming
    f.socket.close()
    await assertion
  })
  it('keeps a provider-confirmed not-executed result distinct from an unconfirmed failure', async () => {
    const f = await fixture()
    for (const outcome of ['not_executed', 'modified_unsaved', 'unknown']) {
      const incoming = receive(f.socket)
      const pending = f.connection.execute(f.target, { action: 'writer_replace' }, new AbortController().signal)
      const assertion = expect(pending).rejects.toMatchObject({ code: 'WPS_UNSUPPORTED', outcome })
      const request = await incoming
      reply(f.socket, request, { ok: false, code: 'WPS_UNSUPPORTED', outcome })
      await assertion
    }
  })
  it('stop settles all pending calls without closing user WPS document connections', async () => {
    const f = await fixture()
    const incoming = receive(f.socket)
    const pending = f.connection.execute(f.target, { action: 'sheet_write' }, new AbortController().signal)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'WPS_UNKNOWN_OUTCOME', outcome: 'unknown' })
    await incoming
    f.connection.stop()
    await assertion
    expect(f.socket.readyState).toBe(WebSocket.OPEN)
    expect(f.connection.documents()).toHaveLength(1)
  })
})
