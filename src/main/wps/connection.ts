import { randomUUID } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import { readWpsFailureDetails, type WpsFailureDetails, type WpsReadbackDiagnostic } from '../../../packages/hqharness-wps/protocol.js'

export type WpsDocumentType = 'writer' | 'spreadsheet' | 'presentation'
export interface WpsDocument {
  key: string
  name: string
  path: string
  type: WpsDocumentType
  saved: boolean
  readOnly: boolean
}
interface Peer { id: string; socket: WebSocket; host: string; documents: WpsDocument[]; seen: number }
export interface WpsTarget { peer: string; document: WpsDocument }
export class WpsError extends Error {
  readonly causeCode?: string
  readonly diagnostic?: WpsReadbackDiagnostic
  constructor(readonly code: string, message: string, readonly outcome: 'not_executed' | 'unknown' | 'modified_unsaved' = 'not_executed', readonly completed?: number, details: WpsFailureDetails = {}) {
    super(message)
    const safe = readWpsFailureDetails(details)
    this.causeCode = safe.causeCode
    this.diagnostic = safe.diagnostic
  }
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
function readDocuments(value: unknown): WpsDocument[] {
  if (!Array.isArray(value) || value.length > 128) throw new WpsError('WPS_PROTOCOL_ERROR', 'Invalid WPS document list')
  const keys = new Set<string>()
  return value.map((item: unknown) => {
    if (!record(item) || typeof item.key !== 'string' || item.key.length > 256 || !item.key || keys.has(item.key)
      || typeof item.name !== 'string' || item.name.length > 1024 || typeof item.path !== 'string' || item.path.length > 4096
      || !['writer', 'spreadsheet', 'presentation'].includes(String(item.type)) || typeof item.saved !== 'boolean' || typeof item.readOnly !== 'boolean') throw new WpsError('WPS_PROTOCOL_ERROR', 'Invalid WPS document identity')
    keys.add(item.key)
    return { key: item.key, name: item.name, path: item.path, type: item.type as WpsDocumentType, saved: item.saved, readOnly: item.readOnly }
  })
}

/** Private authenticated Add-in channel. It never evaluates code or retries input. */
export class WpsConnection {
  private peers = new Map<string, Peer>()
  private pending = new Map<string, { peer: string; resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; dispose: () => void }>()
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false })
  constructor(private readonly server: Server, private readonly secret: string, private readonly origin: () => string, private readonly timeoutMs = 15_000) {
    server.on('upgrade', this.upgrade)
  }
  private upgrade = (request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): void => {
    const match = new RegExp(`^/${this.secret}/bridge/(et|wps|wpp)$`, 'u').exec(request.url ?? '')
    if (!match || request.headers.host !== this.origin().slice(7) || request.headers.origin !== this.origin() || this.peers.size >= 12) {
      if (match) console.warn('[wps] Add-in bridge rejected:', request.headers.origin === undefined ? 'missing-origin' : request.headers.origin === 'null' ? 'null-origin' : 'unexpected-origin-or-capacity')
      socket.destroy(); return
    }
    this.sockets.handleUpgrade(request, socket, head, ws => {
      const peer: Peer = { id: randomUUID(), socket: ws, host: match[1] ?? '', documents: [], seen: Date.now() }
      const helloTimer = setTimeout(() => ws.close(1008), 5000)
      let registered = false
      ws.on('message', data => {
        try {
          const message: unknown = JSON.parse(data.toString())
          if (!record(message)) throw new Error('Invalid message')
          if (message.type === 'hello') {
            if (registered || message.protocol !== 1 || message.host !== peer.host) throw new Error('Invalid handshake')
            peer.documents = readDocuments(message.documents)
            peer.seen = Date.now(); registered = true; clearTimeout(helloTimer); this.peers.set(peer.id, peer)
            console.info('[wps] Add-in bridge connected:', peer.host)
          } else if (!registered) throw new Error('Handshake required')
          else if (message.type === 'documents') { peer.documents = readDocuments(message.documents); peer.seen = Date.now() }
          else if (message.type === 'result' && typeof message.id === 'string') {
            const pending = this.pending.get(message.id)
            if (!pending || pending.peer !== peer.id) return
            pending.dispose(); this.pending.delete(message.id)
            if (!record(message.result)) pending.reject(new WpsError('WPS_PROTOCOL_ERROR', 'Invalid WPS result', 'unknown'))
            else if (message.result.ok === true && record(message.result.value)) pending.resolve(message.result.value)
            else {
              const code = typeof message.result.code === 'string' && /^WPS_[A-Z_]{1,64}$/u.test(message.result.code) ? message.result.code : 'WPS_OPERATION_FAILED'
              const outcome = message.result.outcome === 'not_executed' || message.result.outcome === 'modified_unsaved' ? message.result.outcome : 'unknown'
              const details = readWpsFailureDetails({ causeCode: code, completed: message.result.completed, diagnostic: message.result.diagnostic })
              pending.reject(new WpsError(code, 'WPS could not confirm the requested operation. Inspect the document before continuing.', outcome,
                details.completed, details))
            }
          } else throw new Error('Unexpected message')
        } catch { ws.close(1008) }
      })
      ws.once('close', () => {
        clearTimeout(helloTimer); this.peers.delete(peer.id)
        for (const [id, item] of this.pending) if (item.peer === peer.id) { item.dispose(); this.pending.delete(id); item.reject(new WpsError('WPS_NOT_CONNECTED', 'The WPS Add-in disconnected during the operation', 'unknown')) }
      })
      ws.on('error', () => ws.close())
    })
  }
  documents(): WpsTarget[] {
    // Native WPS throttles background-page timers, particularly while the
    // Desktop authorization dialog is open. Metadata age is not a disconnect.
    // Each RPC resolves its native target again and has a bounded deadline.
    return [...this.peers.values()].filter(peer => peer.socket.readyState === WebSocket.OPEN).flatMap(peer => peer.documents.map(document => ({ peer: peer.id, document: { ...document } })))
  }
  components(): string[] { return [...new Set([...this.peers.values()].filter(peer => peer.socket.readyState === WebSocket.OPEN).map(peer => peer.host))].sort() }
  resolve(target: WpsTarget): WpsDocument {
    const peer = this.peers.get(target.peer)
    const document = peer?.documents.find(item => item.key === target.document.key)
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) throw new WpsError('WPS_NOT_CONNECTED', 'Open the document in WPS with the Huaqing Desktop Add-in loaded')
    if (!document) throw new WpsError('WPS_STALE_DOCUMENT', 'The WPS document identity changed while waiting for authorization. List documents again before continuing.')
    return document
  }
  async execute(target: WpsTarget, operation: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    signal.throwIfAborted(); this.resolve(target)
    const peer = this.peers.get(target.peer)
    if (!peer) throw new WpsError('WPS_NOT_CONNECTED', 'WPS is not connected')
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        this.pending.delete(id); dispose()
        reject(new WpsError('WPS_UNKNOWN_OUTCOME', 'WPS may have started this operation. It was not replayed.', 'unknown'))
      }
      const timer = setTimeout(abort, this.timeoutMs)
      const dispose = (): void => { clearTimeout(timer); signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      this.pending.set(id, { peer: peer.id, resolve, reject, dispose })
      // Once send is attempted, a transport error cannot prove non-execution.
      peer.socket.send(JSON.stringify({ type: 'execute', id, operation: { ...operation, key: target.document.key } }), error => { if (error) abort() })
    })
  }
  stop(): void {
    for (const [id, item] of this.pending) { item.dispose(); this.pending.delete(id); item.reject(new WpsError('WPS_UNKNOWN_OUTCOME', 'WPS automation stopped; an in-flight operation may still complete', 'unknown')) }
  }
  async close(): Promise<void> {
    this.stop(); this.server.off('upgrade', this.upgrade)
    for (const client of this.sockets.clients) client.terminate()
    this.peers.clear()
    await new Promise<void>(resolve => this.sockets.close(() => resolve()))
  }
}
