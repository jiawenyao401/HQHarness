import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocket } from 'ws'
import { expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }, dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() }
}))
import { DesktopWpsService } from '../src/main/wps/service.ts'
import { WpsDocuments } from '../src/main/wps/documents.ts'

it('executes installed WPS tools through real Harness Agent, MCP and isolated PTC boundaries', async () => {
  const root = path.resolve(import.meta.dirname, '..')
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'huaqing-wps-harness-')))
  const workspace = path.join(home, 'workspace')
  await mkdir(workspace)
  await mkdir(path.join(home, 'policy-fallback'))
  const service = new DesktopWpsService(path.join(home, 'connector'), () => ({ isDestroyed: () => false, show() {}, focus() {} }), () => 'en')
  const audit = vi.spyOn(WpsDocuments.prototype, 'execute')
  const operations = []
  let socket
  let child
  let heartbeat
  try {
    await service.start()
    const env = service.environment()
    if (!env.HQHARNESS_WPS_URL || !env.HQHARNESS_WPS_TOKEN) throw new Error('Missing local fixture MCP endpoint')
    const { secret } = JSON.parse(await readFile(path.join(home, 'connector', 'connection.json'), 'utf8'))
    const origin = new URL(env.HQHARNESS_WPS_URL).origin
    const documentPath = path.join(workspace, 'fixture.docx')
    await writeFile(documentPath, 'Owned temporary document for transport qualification')
    socket = new WebSocket(`${origin.replace('http:', 'ws:')}/${secret}/bridge/wps`, { origin })
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
    socket.on('message', data => {
      const message = JSON.parse(data.toString())
      if (message.type !== 'execute') return
      operations.push(message.operation)
      socket.send(JSON.stringify({ type: 'result', id: message.id, result: { ok: true, value: { snapshot: message.operation.snapshot, text: 'old' } } }))
    })
    const documents = [{ key: 'native-fixture-document', name: 'fixture.docx', path: documentPath, type: 'writer', saved: true, readOnly: false }]
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, host: 'wps', documents }))
    await vi.waitFor(() => expect(service.status().connectedDocuments).toBe(1))
    // Keep only the fake Add-in's heartbeat alive during real PTC process boot.
    heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'documents', documents })) }, 2000)
    const moduleUrl = name => pathToFileURL(path.join(root, 'node_modules', name, 'lib/index.js')).href
    const config = path.join(home, 'cordis.yml')
    await writeFile(config, JSON.stringify([
      { id: 'prompt', name: moduleUrl('@deepseek-ai/dsh-system-prompt') },
      { id: 'tools', name: moduleUrl('@deepseek-ai/dsh-tools'), config: { mode: 'both' } },
      ...['dsh-session-projection', 'dsh-session', 'dsh-agent', 'dsh-llm', 'dsh-agent-loop', 'dsh-fs-local', 'dsh-subprocess-local', 'dsh-sandbox-local'].map(name => ({ id: name, name: moduleUrl('@deepseek-ai/' + name) })),
      { id: 'policy', name: moduleUrl('@deepseek-ai/dsh-sandbox-policy'), config: { mode: 'workspace-write', workspaceRoot: path.join(home, 'policy-fallback') } },
      { id: 'ptc', name: moduleUrl('@deepseek-ai/dsh-ptc-runtime-node') },
      { id: 'automation', name: pathToFileURL(path.join(root, 'packages/hqharness-automation/index.js')).href },
      { id: 'wps', name: pathToFileURL(path.join(root, 'packages/hqharness-wps/index.js')).href }
    ]))
    let stdout = ''
    let stderr = ''
    try {
      const result = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, [path.join(root, 'build/harness-node-entry.mjs'), path.join(root, 'test/fixtures/wps-harness.mjs'), config, workspace], {
          cwd: home, env: { ...process.env, ...env, DSH_HOME: home }, stdio: ['ignore', 'pipe', 'pipe']
        })
        const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Real WPS Harness qualification timed out')) }, 30_000)
        child.stdout.on('data', data => { stdout += data; if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL') })
        child.stderr.on('data', data => { stderr += data; if (stderr.length > 2 * 1024 * 1024) child.kill('SIGKILL') })
        child.once('error', error => { clearTimeout(deadline); reject(error) })
        child.once('close', (code, signal) => { clearTimeout(deadline); resolve({ code, signal }) })
      })
      expect(result.code, stderr + stdout).toBe(0)
      expect(stdout.includes('WPS_REAL_HARNESS_PASS ')).toBe(true)
    } finally { clearInterval(heartbeat) }
    const calls = audit.mock.calls.map(([operation, meta]) => ({ action: operation.action, ...meta }))
    expect(calls.some(call => call.action === 'status' && call.owner === 'wps-agent-native')).toBe(true)
    expect(calls.some(call => call.action === 'documents' && call.owner === 'wps-agent-native')).toBe(true)
    expect(calls.some(call => call.action === 'writer_replace' && call.owner === 'wps-agent-readonly' && call.policy.mode === 'read-only')).toBe(true)
    for (const call of calls) {
      expect(['wps-agent-native', 'wps-agent-readonly']).toContain(call.owner)
      expect(call.policy.workspaceRoot).toBe(workspace)
      expect(call.policy.mode).toBe(call.owner === 'wps-agent-readonly' ? 'read-only' : 'workspace-write')
    }
    expect(operations.some(operation => operation.action === 'inspect')).toBe(true)
    expect(operations.every(operation => operation.key === 'native-fixture-document')).toBe(true)
    expect(operations.some(operation => operation.action === 'writer_replace')).toBe(false)
  } finally {
    clearInterval(heartbeat)
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    socket?.terminate()
    await service.close()
    audit.mockRestore()
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 45_000)
