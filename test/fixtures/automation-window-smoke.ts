import { app } from 'electron'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ComputerAutomation } from '../../src/main/automation/computer'
import { AutomationError, type AutomationOperation, type AutomationResult } from '../../src/shared/automation'

app.on('window-all-closed', () => undefined)
interface FixtureReady { pid: number; window: string; title: string; keeper: string }
function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected fixture JSON object')
  return value as Record<string, unknown>
}
async function readReady(directory: string, pid: number, title: string): Promise<FixtureReady> {
  const deadline = performance.now() + 20_000
  for (;;) {
    let data: unknown
    try { data = JSON.parse(await readFile(path.join(directory, 'ready.json'), 'utf8')) }
    catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
      if (performance.now() >= deadline) throw new Error('The owned WinForms fixture did not open in 20 seconds; an interactive Windows desktop is required')
      await delay(100)
      continue
    }
    const ready = record(data)
    assert.equal(ready.pid, pid, 'The window must belong to the fixture child process')
    assert.equal(ready.title, title)
    assert(typeof ready.window === 'string' && /^[1-9]\d*$/u.test(ready.window))
    assert(typeof ready.keeper === 'string' && /^[1-9]\d*$/u.test(ready.keeper))
    assert.notEqual(ready.keeper, ready.window)
    assert.equal(ready.foreground, ready.keeper, 'The owned keeper must actually hold foreground before semantic-click acceptance')
    return { pid, window: ready.window, title, keeper: ready.keeper }
  }
}
async function main(): Promise<void> {
  assert.equal(process.platform, 'win32', 'This acceptance verifies the Windows native UIA backend')
  const directory = process.env.HQ_WINDOW_FIXTURE_DIRECTORY
  const title = process.env.HQ_WINDOW_FIXTURE_TITLE
  const pid = Number(process.env.HQ_WINDOW_FIXTURE_PID)
  assert(directory && title && Number.isSafeInteger(pid) && pid > 0, 'Use the owned fixture launcher')
  await app.whenReady()
  const ready = await readReady(directory, pid, title)
  const computer = new ComputerAutomation()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new AutomationError('TIMEOUT', 'Native window fixture exceeded its acceptance deadline')), 45_000)
  const stages: { stage: string; elapsed_ms: number; images: number; operations: number }[] = []
  let operations = 0
  let images = 0
  const execute = async (operation: AutomationOperation): Promise<AutomationResult> => {
    operations++
    const result = await computer.execute('native-window-acceptance', operation, controller.signal)
    if (result.image) images++
    return result
  }
  const measured = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now(); const beforeImages = images; const beforeOps = operations
    const result = await work()
    const timing = { stage, elapsed_ms: Math.round(performance.now() - started), images: images - beforeImages, operations: operations - beforeOps }
    stages.push(timing)
    console.log('WINDOW_LOCAL_STAGE ' + JSON.stringify(timing))
    return result
  }
  try {
    const found = await measured('discover-owned-native-window', () => execute({ action: 'windows', pid }))
    assert(Array.isArray(found.windows))
    // Log only our fixture's identity and equality checks, never another app's
    // title/content. Shown/ready and native window discovery are distinct stages.
    console.log('WINDOW_DISCOVERY_DIAGNOSTIC ' + JSON.stringify({
      fixture_pid: pid, ready_window: ready.window, returned_count: found.windows.length,
      foreign_pid_count: found.windows.filter(value => record(value).pid !== pid).length,
      owned_windows: found.windows.filter(value => record(value).pid === pid).map(value => {
        const window = record(value)
        return { pid: window.pid, window: window.window, handle_match: window.window === ready.window, title_match: window.title === title, on_screen: window.on_screen, minimized: window.minimized }
      })
    }))
    assert(found.windows.some(value => {
      const window = record(value)
      return window.pid === pid && window.window === ready.window && window.title === title
    }), 'Discovery must find the exact owned WinForms HWND')
    let observation = await measured('native-structured-no-image', () => execute({ action: 'observe', pid, window: ready.window }))
    assert.equal(observation.image, undefined)
    assert.equal(observation.pid, pid)
    assert.equal(observation.window, ready.window)
    assert(Array.isArray(observation.elements))
    assert(observation.elements.some(value => record(value).name === 'Query'), 'The real UIA tree must expose the native textbox')
    assert(observation.elements.some(value => record(value).name === 'Search'), 'The real UIA tree must expose the native button')
    assert.equal(observation.element_frame_space, 'native-screen')
    assert(observation.window_bounds, 'The exact native window bounds must remain available')
    const readOracle = async (name: string): Promise<Record<string, unknown>> => {
      const deadline = performance.now() + 2500
      for (;;) {
        try { return record(JSON.parse(await readFile(path.join(directory, name), 'utf8'))) }
        catch (error) {
          if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') || performance.now() >= deadline) throw error
          await delay(50, undefined, { signal: controller.signal })
        }
      }
    }
    observation = await measured('native-semantic-click-with-other-foreground-window', () => execute({ action: 'click', pid, window: ready.window, snapshot: String(observation.snapshot), target: { name: 'Background', role: 'Button' } }))
    const backgroundOracle = await readOracle('background.json')
    assert.equal(backgroundOracle.pid, pid)
    assert.equal(backgroundOracle.clicks, 1, 'The background button handler must execute exactly once')
    assert.equal(backgroundOracle.foreground, ready.keeper, 'The target handler must run while the separate owned keeper still holds foreground')
    observation = await measured('native-background-list-item-double-click', () => execute({ action: 'click', pid, window: ready.window, snapshot: String(observation.snapshot), target: { name: 'DoubleTarget', role: 'ListItem' }, clicks: 2 }))
    const doubleOracle = await readOracle('double.json')
    assert.equal(doubleOracle.pid, pid)
    assert.equal(doubleOracle.activations, 1, 'One count=2 request must produce exactly one real ListView ItemActivate event')
    assert.deepEqual(doubleOracle.selected, ['DoubleTarget'])
    const prefix = '已有内容-'
    const suffix = '中文课堂 HQHarness 原生验收'
    const query = prefix + suffix
    // Establish a readable nonempty baseline, then exercise native append and host
    // readback; replacement alone does not cover Unverifiable type_text results.
    const result = await measured('native-one-plan-four-local-steps', () => execute({ action: 'run', pid, window: ready.window, snapshot: String(observation.snapshot), steps: [
      { action: 'type', target: { name: 'Query' }, text: prefix, replace: true },
      { action: 'type', target: { name: 'Query' }, text: suffix },
      { action: 'click', target: { name: 'Search', role: 'Button' } },
      { action: 'wait', target: { name: 'Done', role: 'Button' } }
    ] }))
    if (record(result.sequence).status !== 'completed') {
      // Capture only this fixture's known textbox after a failed plan. This is
      // read-only evidence; it never retries input or relaxes the assertions.
      try {
        const after = await execute({ action: 'observe', pid, window: ready.window })
        const controls = Array.isArray(after.elements) ? after.elements.map(record).filter(element => element.name === 'Query').map(element => ({ role: element.role, value: element.value, enabled: element.enabled, actions: element.actions })) : []
        console.log('WINDOW_APPEND_FAILURE_DIAGNOSTIC ' + JSON.stringify({ expected: query, controls, complete: after.complete, truncated: after.truncated, degraded: after.degraded }))
      } catch (error) {
        console.log('WINDOW_APPEND_FAILURE_DIAGNOSTIC ' + JSON.stringify({ expected: query, observation_error: error instanceof Error ? error.message : String(error) }))
      }
    }
    assert.deepEqual(record(result.sequence).status, 'completed', JSON.stringify(result.sequence))
    assert.equal(record(result.sequence).completed, 4)
    assert.equal(record(result.sequence).total, 4)
    assert.equal(result.image, undefined)
    const oracle = record(JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8')))
    assert.equal(oracle.pid, pid)
    assert.equal(oracle.title, title)
    assert.equal(oracle.value, query, 'Chinese append must reach the real native TextBox')
    assert.equal(oracle.clicks, 1, 'The real WinForms click handler must run exactly once')
    const pictured = await measured('native-explicit-window-image', () => execute({ action: 'observe', pid, window: ready.window, screenshot: true }))
    assert(pictured.image && Buffer.from(pictured.image.png, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    assert.deepEqual(pictured.coordinates, { width: pictured.image.width, height: pictured.image.height }, 'Window image attachments must retain their full source coordinate space')
    await assert.rejects(execute({ action: 'click', pid, window: ready.window, snapshot: String(observation.snapshot), target: { name: 'Search' } }), (error: unknown) => error instanceof AutomationError && error.code === 'STALE_SNAPSHOT')
    assert.equal(images, 1, 'Structured discovery and plans must not return screenshots')
    console.log('WINDOW_LOCAL_EXECUTION_PASS ' + JSON.stringify({ platform: process.platform, arch: process.arch, operations, images, stages, value_verified: true, click_handler_count: 1, foreground_preserved: true, double_click_activations: 1, scope: 'real Windows UIA with owned WinForms windows; no model requests; not an end-to-end model speed comparison' }))
  } finally { clearTimeout(timer); await computer.close() }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
