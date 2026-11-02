import { app, BrowserWindow, Menu } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parseArgs, isDeepStrictEqual } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { DesktopWpsService } from '../../src/main/wps/service'
import { WPS_INPUT_SCHEMA, WPS_RAW_TOOL_NAME, readWpsFailureDetails, type WpsFailureDetails, type WpsOperation } from '../../packages/hqharness-wps/protocol.js'

type Matrix = (string | number | boolean | null)[][]
type Fixture = { type: 'writer'; file: string; marker: string; replacement: string }
  | { type: 'spreadsheet'; file: string; sheet: string; range: 'A1:B2'; before: Matrix; after: Matrix }
  | { type: 'presentation'; file: string; slideId: number; shapeId: number; marker: string; replacement: string }
interface Step extends WpsFailureDetails { fixture: string; action: string; status: 'running' | 'passed' | 'failed'; durationMs?: number; code?: string }
interface Report extends WpsFailureDetails {
  version: 1
  status: 'running' | 'passed' | 'failed' | 'timed_out'
  startedAt: string
  completedAt?: string
  platform: string
  arch: string
  electron: string
  fixtureDir: string
  userData: string
  registrationRequested: boolean
  registrationConfirmed: boolean
  registrationRemoved: false
  nativeConsent: 'production_dialogs_not_mocked'
  phase: string
  code?: string
  failedReadback?: { fixture: string; values: Matrix; formulas: Matrix; numberFormats: Matrix; hasFormulas: Matrix }
  fixtures: { file: string; type: string; readbackVerified: boolean; saved: boolean; diskSha256?: string }[]
  steps: Step[]
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const inside = (parent: string, child: string): boolean => { const part = relative(parent, child); return part !== '' && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part) }
const folded = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

class SmokeFailure extends Error {
  constructor(readonly code: string, readonly details: WpsFailureDetails = {}) { super(code) }
}

function assert(condition: unknown, code: string): asserts condition {
  if (!condition) throw new SmokeFailure(code)
}

function fixtureText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0')
}

function matrix(value: unknown): value is Matrix {
  return Array.isArray(value) && value.length === 2 && value.every(row => Array.isArray(row) && row.length === 2 && row.every(cell => cell === null || typeof cell === 'boolean' || typeof cell === 'number' && Number.isFinite(cell) || typeof cell === 'string' && cell.length <= 4096 && !cell.includes('\0')))
}

function fixturesFrom(value: unknown): Fixture[] {
  assert(record(value) && value.version === 1 && Array.isArray(value.fixtures) && value.fixtures.length > 0 && value.fixtures.length <= 3, 'INVALID_MANIFEST')
  const files = new Set<string>()
  const fixtures: Fixture[] = []
  for (const item of value.fixtures) {
    assert(record(item) && typeof item.file === 'string' && /^huaqing-wps-[a-zA-Z0-9_-]+\.(docx|xlsx|pptx)$/u.test(item.file) && !files.has(item.file), 'INVALID_FIXTURE_FILE')
    files.add(item.file)
    if (item.type === 'spreadsheet') {
      assert(item.file.endsWith('.xlsx') && fixtureText(item.sheet) && item.range === 'A1:B2' && matrix(item.before) && matrix(item.after) && !isDeepStrictEqual(item.before, item.after), 'INVALID_SPREADSHEET_FIXTURE')
      fixtures.push({ type: 'spreadsheet', file: item.file, sheet: item.sheet, range: 'A1:B2', before: item.before, after: item.after })
    } else {
      assert(fixtureText(item.marker) && fixtureText(item.replacement) && item.marker !== item.replacement, 'INVALID_TEXT_FIXTURE')
      if (item.type === 'writer') {
        assert(item.file.endsWith('.docx'), 'INVALID_WRITER_FIXTURE')
        fixtures.push({ type: 'writer', file: item.file, marker: item.marker, replacement: item.replacement })
      } else {
        assert(item.type === 'presentation' && item.file.endsWith('.pptx') && Number.isSafeInteger(item.slideId) && Number(item.slideId) > 0 && Number.isSafeInteger(item.shapeId) && Number(item.shapeId) > 0, 'INVALID_PRESENTATION_FIXTURE')
        fixtures.push({ type: 'presentation', file: item.file, marker: item.marker, replacement: item.replacement, slideId: Number(item.slideId), shapeId: Number(item.shapeId) })
      }
    }
  }
  return fixtures
}

async function checkedFile(directory: string, file: string): Promise<string> {
  const path = join(directory, file)
  const info = await lstat(path)
  assert(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= 16 * 1024 * 1024, 'UNSAFE_FIXTURE_FILE')
  const canonical = await realpath(path)
  assert(inside(directory, canonical) && folded(canonical) === folded(path), 'FIXTURE_ESCAPES_TEMP_ROOT')
  return canonical
}

function snapshot(value: Record<string, unknown>): string {
  assert(typeof value.snapshot === 'string' && value.snapshot.length > 0, 'MISSING_NATIVE_SNAPSHOT')
  return value.snapshot
}

function toolValue(value: unknown): Record<string, unknown> {
  assert(record(value), 'INVALID_MCP_RESPONSE')
  if (value.isError === true) {
    const block = Array.isArray(value.content) ? value.content.find(item => record(item) && item.type === 'text') : undefined
    let code = 'MCP_TOOL_FAILED'
    let details: WpsFailureDetails = {}
    if (record(block) && typeof block.text === 'string' && block.text.length <= 65_536) {
      try {
        const failure: unknown = JSON.parse(block.text)
        if (record(failure) && typeof failure.code === 'string' && /^WPS_[A-Z_]{1,64}$/u.test(failure.code)) { code = failure.code; details = readWpsFailureDetails(failure) }
      } catch { /* Do not print raw provider text or headers. */ }
    }
    throw new SmokeFailure(code, details)
  }
  assert(record(value.structuredContent), 'MISSING_MCP_STRUCTURED_CONTENT')
  return value.structuredContent
}

async function run(): Promise<number> {
  const { values } = parseArgs({ args: process.argv.slice(2), options: {
    'fixture-dir': { type: 'string' }, report: { type: 'string' }, register: { type: 'boolean', default: false }, 'timeout-ms': { type: 'string', default: '600000' }, 'force-renderer-accessibility': { type: 'boolean' }
  } })
  assert(values['fixture-dir'] && isAbsolute(values['fixture-dir']) && values.report && isAbsolute(values.report), 'ABSOLUTE_SMOKE_PATHS_REQUIRED')
  const userData = process.env.HQ_WPS_SMOKE_USER_DATA
  assert(userData && isAbsolute(userData) && basename(userData).startsWith('huaqing-wps-native-profile-'), 'ISOLATED_USER_DATA_REQUIRED')
  app.setPath('userData', userData)
  app.setName('Huaqing WPS native smoke')
  const fixtureDir = await realpath(values['fixture-dir'])
  const tempRoots = [await realpath(tmpdir()), ...(process.platform === 'win32' ? [] : [await realpath('/tmp')])]
  assert(tempRoots.some(root => inside(root, fixtureDir)) && tempRoots.some(root => inside(root, userData)), 'FIXTURES_AND_PROFILE_MUST_BE_TEMPORARY')
  assert(!(await lstat(values['fixture-dir'])).isSymbolicLink(), 'FIXTURE_DIRECTORY_IS_SYMLINK')
  const manifestPath = join(fixtureDir, 'manifest.json')
  const manifestInfo = await lstat(manifestPath)
  assert(manifestInfo.isFile() && !manifestInfo.isSymbolicLink() && manifestInfo.size <= 65_536, 'INVALID_MANIFEST_FILE')
  const fixtures = fixturesFrom(JSON.parse(await readFile(manifestPath, 'utf8')))
  for (const fixture of fixtures) await checkedFile(fixtureDir, fixture.file)
  const reportPath = join(await realpath(dirname(values.report)), basename(values.report))
  assert(!reportPath.split(/[\\/]/u).some(part => part.toLowerCase() === 'deliverables'), 'REPORT_MUST_BE_OUTSIDE_DELIVERABLES')
  const timeoutMs = Number(values['timeout-ms'])
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600_000, 'INVALID_SMOKE_TIMEOUT')
  const deadline = Date.now() + timeoutMs
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(new SmokeFailure('SMOKE_TIMEOUT')), timeoutMs)
  const report: Report = {
    version: 1, status: 'running', startedAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
    electron: process.versions.electron, fixtureDir, userData, registrationRequested: values.register, registrationConfirmed: false,
    registrationRemoved: false, nativeConsent: 'production_dialogs_not_mocked', phase: 'starting_electron',
    fixtures: fixtures.map(fixture => ({ file: fixture.file, type: fixture.type, readbackVerified: false, saved: false })), steps: []
  }
  let window: BrowserWindow | undefined
  let service: DesktopWpsService | undefined
  let client: Client | undefined
  const status = (): void => {
    // No service URL, environment, document inventories, tokens or raw errors.
    console.log(JSON.stringify({ status: report.status, phase: report.phase, completedSteps: report.steps.filter(step => step.status === 'passed').length, elapsedSeconds: Math.round((Date.now() - Date.parse(report.startedAt)) / 1000) }))
    if (window && !window.isDestroyed()) void window.webContents.executeJavaScript(`document.getElementById('status').textContent=${JSON.stringify(report.phase)}`).catch(() => { /* Window can close while an update is queued. */ })
  }
  const heartbeat = setInterval(status, 10_000)
  async function step(fixture: Fixture, action: string, operation: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
    report.phase = `${fixture.type}:${action}`
    status()
    const entry: Step = { fixture: fixture.file, action, status: 'running' }
    report.steps.push(entry)
    const started = Date.now()
    try { const value = await operation(); entry.status = 'passed'; return value }
    catch (error) { entry.status = 'failed'; entry.code = error instanceof SmokeFailure ? error.code : 'NATIVE_STEP_FAILED'; if (error instanceof SmokeFailure) Object.assign(entry, error.details); throw error }
    finally { entry.durationMs = Date.now() - started }
  }
  try {
    await app.whenReady()
    Menu.setApplicationMenu(null)
    window = new BrowserWindow({ width: 650, height: 360, show: true, title: 'Huaqing WPS native smoke', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } })
    window.once('close', () => controller.abort(new SmokeFailure('SMOKE_WINDOW_CLOSED')))
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><title>Huaqing WPS native smoke</title><style>body{font:16px system-ui;padding:24px;line-height:1.6}code{overflow-wrap:anywhere}</style><h1>WPS 原生验收</h1><p>只处理 manifest 指定的临时 huaqing-wps-* 测试文件。请按终端提示重新打开 WPS，并打开这些测试文件。</p><p>真实的本机授权对话框将显示在此窗口；本程序不会关闭 WPS。</p><p>阶段：<code id="status">starting</code></p>'))
    report.phase = 'starting_production_wps_service'
    status()
    service = new DesktopWpsService(join(userData, 'wps'), () => window, () => 'zh')
    await service.start()
    const initial = service.status()
    assert(initial.supported === true && !initial.error, typeof initial.error === 'string' && /^WPS_[A-Z_]+$/u.test(initial.error) ? initial.error : 'WPS_SERVICE_UNAVAILABLE')
    if (values.register) {
      report.phase = 'registering_native_addin_quit_wps_first'
      status()
      await service.enableAddin()
      report.registrationConfirmed = service.status().registered === true
      assert(report.registrationConfirmed, 'REGISTRATION_NOT_CONFIRMED')
    }
    const environment = service.environment()
    const endpoint = environment.HQHARNESS_WPS_URL
    const bearer = environment.HQHARNESS_WPS_TOKEN
    assert(typeof endpoint === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u.test(endpoint) && typeof bearer === 'string' && /^[a-f0-9]{64}$/u.test(bearer), 'MISSING_PRIVATE_MCP_ENDPOINT')
    report.phase = 'connecting_authenticated_mcp_sdk'
    status()
    client = new Client({ name: 'huaqing-wps-native-smoke', version: '0.1.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}`, 'x-hq-wps-client': randomUUID() } },
      reconnectionOptions: { initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
      fetch: (input, init) => fetch(input, { ...init, redirect: 'error' })
    })
    await client.connect(transport, { signal: controller.signal, timeout: Math.min(15_000, deadline - Date.now()) })
    report.phase = 'discovering_production_mcp_tool_contract'
    status()
    const listed = await client.listTools(undefined, { signal: controller.signal, timeout: 15_000, cacheMode: 'refresh' })
    const definition = listed.tools[0]
    assert(listed.tools.length === 1 && definition?.name === WPS_RAW_TOOL_NAME && isDeepStrictEqual(definition.inputSchema, WPS_INPUT_SCHEMA), 'MCP_TOOL_CONTRACT_MISMATCH')
    const meta = { owner: randomUUID(), policy: { mode: 'workspace-write', workspaceRoot: fixtureDir } }
    const call = async (operation: WpsOperation): Promise<Record<string, unknown>> => {
      controller.signal.throwIfAborted()
      assert(client, 'MCP_CLIENT_CLOSED')
      return toolValue(await client.callTool({ name: WPS_RAW_TOOL_NAME, arguments: operation, _meta: { huaqing: meta } }, { signal: controller.signal, timeout: Math.max(1, Math.min(175_000, deadline - Date.now())), toolDefinition: definition }))
    }
    for (const fixture of fixtures) {
      const ownedPath = await checkedFile(fixtureDir, fixture.file)
      report.phase = `waiting_for_owned_${fixture.type}_fixture`
      status()
      let key: string | undefined
      while (!key) {
        controller.signal.throwIfAborted()
        const inventory = await call({ action: 'documents' })
        assert(Array.isArray(inventory.documents), 'INVALID_NATIVE_DOCUMENT_INVENTORY')
        const matches: Record<string, unknown>[] = []
        for (const document of inventory.documents) {
          if (!record(document) || typeof document.path !== 'string' || !isAbsolute(document.path)) continue
          // Inspect only our exact basename, then verify its physical local path.
          if (basename(document.path) !== fixture.file) continue
          const physical = await realpath(document.path)
          if (folded(physical) === folded(ownedPath)) matches.push(document)
        }
        assert(matches.length <= 1, 'AMBIGUOUS_OWNED_FIXTURE')
        const match = matches[0]
        if (match) {
          assert(match.type === fixture.type && match.supported !== false && typeof match.key === 'string' && !match.readOnly && !match.frozen, 'OWNED_FIXTURE_NOT_WRITABLE')
          key = match.key
        } else await delay(2000, undefined, { signal: controller.signal })
      }
      const inspectAction: WpsOperation = fixture.type === 'spreadsheet'
        ? { action: 'sheet_read', key, sheet: fixture.sheet, range: fixture.range } : { action: 'inspect', key }
      const before = await step(fixture, inspectAction.action, () => call(inspectAction))
      let mutation: WpsOperation
      let expectedWriter: string | undefined
      if (fixture.type === 'writer') {
        assert(typeof before.text === 'string' && before.truncated === false, 'WRITER_BODY_UNAVAILABLE')
        const offset = before.text.indexOf(fixture.marker)
        assert(offset >= 0 && before.text.indexOf(fixture.marker, offset + 1) === -1, 'WRITER_FIXTURE_MARKER_NOT_UNIQUE')
        expectedWriter = before.text.slice(0, offset) + fixture.replacement + before.text.slice(offset + fixture.marker.length)
        mutation = { action: 'writer_replace', key, snapshot: snapshot(before), oldText: fixture.marker, replaceText: fixture.replacement }
      } else if (fixture.type === 'spreadsheet') {
        assert(isDeepStrictEqual(before.values, fixture.before), 'SPREADSHEET_FIXTURE_PRECONDITION_FAILED')
        mutation = { action: 'sheet_write', key, snapshot: snapshot(before), sheet: fixture.sheet, range: fixture.range, values: fixture.after }
      } else {
        assert(Array.isArray(before.items) && before.items.some(item => record(item) && item.slideId === fixture.slideId && item.shapeId === fixture.shapeId && item.text === fixture.marker && item.truncated === false), 'OWNED_PRESENTATION_SHAPE_NOT_FOUND')
        mutation = { action: 'slide_text', key, snapshot: snapshot(before), slideId: fixture.slideId, shapeId: fixture.shapeId, text: fixture.replacement }
      }
      await checkedFile(fixtureDir, fixture.file)
      try { await step(fixture, mutation.action, () => call(mutation)) }
      catch (error) {
        const failedPhase = report.phase
        // This smoke owns and checked this exact temporary file/range. A fresh
        // bounded read may explain the failure; it never retries a write/save.
        if (fixture.type === 'spreadsheet') {
          try {
            await checkedFile(fixtureDir, fixture.file)
            const observed = await step(fixture, 'readback_after_failure', () => call(inspectAction))
            if (matrix(observed.values) && matrix(observed.formulas) && matrix(observed.numberFormats) && matrix(observed.hasFormulas)) {
              report.failedReadback = { fixture: fixture.file, values: observed.values, formulas: observed.formulas, numberFormats: observed.numberFormats, hasFormulas: observed.hasFormulas }
            }
          } catch { /* Preserve the original failure even when this read fails. */ }
          finally { report.phase = failedPhase }
        }
        throw error
      }
      const after = await step(fixture, 'independent_readback', () => call(inspectAction))
      if (fixture.type === 'writer') assert(after.text === expectedWriter && after.truncated === false, 'WRITER_READBACK_MISMATCH')
      else if (fixture.type === 'spreadsheet') assert(isDeepStrictEqual(after.values, fixture.after), 'SPREADSHEET_READBACK_MISMATCH')
      else assert(Array.isArray(after.items) && after.items.some(item => record(item) && item.slideId === fixture.slideId && item.shapeId === fixture.shapeId && item.text === fixture.replacement && item.truncated === false), 'PRESENTATION_READBACK_MISMATCH')
      const summary = report.fixtures.find(item => item.file === fixture.file)
      assert(summary, 'FIXTURE_REPORT_MISSING')
      summary.readbackVerified = true
      await checkedFile(fixtureDir, fixture.file)
      const saved = await step(fixture, 'save', () => call({ action: 'save', key, snapshot: snapshot(after) }))
      const diskHash = sha256(await readFile(await checkedFile(fixtureDir, fixture.file)))
      assert(saved.saved === true && saved.verification === 'wps_api_and_local_file' && saved.sha256 === diskHash, 'SAVED_FILE_VERIFICATION_FAILED')
      summary.saved = true
      summary.diskSha256 = diskHash
    }
    report.status = 'passed'
    report.phase = 'native_read_modify_readback_save_completed'
  } catch (error) {
    report.status = controller.signal.aborted && controller.signal.reason instanceof SmokeFailure && controller.signal.reason.code === 'SMOKE_TIMEOUT' ? 'timed_out' : 'failed'
    report.code = error instanceof SmokeFailure ? error.code : controller.signal.aborted ? 'NATIVE_SMOKE_ABORTED' : 'NATIVE_SMOKE_FAILED'
    if (error instanceof SmokeFailure) Object.assign(report, error.details)
  } finally {
    clearTimeout(timeout)
    clearInterval(heartbeat)
    try { await client?.close() } catch { report.status = 'failed'; report.code ??= 'MCP_CLIENT_CLEANUP_FAILED' }
    try { await service?.close() } catch { report.status = 'failed'; report.code ??= 'WPS_SERVICE_CLEANUP_FAILED' }
    report.completedAt = new Date().toISOString()
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    status()
  }
  return report.status === 'passed' ? 0 : 1
}

void run().then(code => app.exit(code), () => { console.error(JSON.stringify({ status: 'failed', phase: 'invalid_smoke_configuration' })); app.exit(1) })
