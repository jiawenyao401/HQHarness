import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrowserAutomation } from '../../src/main/automation/browser'
import { AutomationError, type AutomationOperation, type AutomationResult } from '../../src/shared/automation'

app.on('window-all-closed', () => undefined)

const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>HQHarness Browser fixture</title>
<h1>浏览器本地执行验收</h1><label>查询词<input aria-label="查询词" id="query" value="待替换内容"></label>
<button id="search">搜索</button><div role="status" aria-label="尚未搜索" id="result">尚未搜索</div>
<button id="duplicate-a">相同操作</button><button id="duplicate-b">相同操作</button>
<div id="stages"></div><script>
window.fixture = { searches: 0, duplicateClicks: 0, inputEvents: 0, text: '', result: '', cancelOnInput: false };
query.addEventListener('input', () => {
  fixture.inputEvents++; fixture.text = query.value;
  if (fixture.cancelOnInput) console.log('HQ_FIXTURE_CANCEL');
});
search.addEventListener('click', () => {
  fixture.searches++;
  setTimeout(() => {
    fixture.result = '结果：' + query.value;
    result.textContent = fixture.result; result.setAttribute('aria-label', fixture.result);
  }, 80);
});
document.querySelectorAll('[id^="duplicate-"]').forEach(button => button.addEventListener('click', () => fixture.duplicateClicks++));
window.startSlowStages = () => {
  let stage = 0;
  const timer = setInterval(() => {
    const item = document.createElement('div'); item.setAttribute('role', 'status');
    item.setAttribute('aria-label', '阶段' + (++stage)); item.textContent = '阶段' + stage;
    stages.append(item); if (stage === 8) clearInterval(timer);
  }, 1950);
};
</script></html>`

function owned(result: AutomationResult): { tab: string; snapshot: string } {
  assert.equal(typeof result.tab, 'string')
  assert.equal(typeof result.snapshot, 'string')
  return { tab: String(result.tab), snapshot: String(result.snapshot) }
}

async function main(): Promise<void> {
  await app.whenReady()
  const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); response.end(html) })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  const url = `http://127.0.0.1:${port}/fixture`
  const browser = new BrowserAutomation()
  let operations = 0
  let screenshots = 0
  const stages: { stage: string; elapsed_ms: number; images: number; operations: number }[] = []
  const execute = async (operation: AutomationOperation, signal = new AbortController().signal): Promise<AutomationResult> => {
    operations++
    const result = await browser.execute('performance-smoke', operation, signal)
    if (result.image) screenshots++
    return result
  }
  const measured = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    const started = performance.now(); const priorOps = operations; const priorImages = screenshots
    const result = await work()
    const row = { stage, elapsed_ms: Math.round(performance.now() - started), images: screenshots - priorImages, operations: operations - priorOps }
    stages.push(row); console.log('BROWSER_LOCAL_STAGE ' + JSON.stringify(row))
    return result
  }
  const fixtureWindow = (): BrowserWindow => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL() === url)
    assert(window, 'The fixture browser window must exist')
    return window
  }
  const readState = async (): Promise<{ searches: number; duplicateClicks: number; inputEvents: number; text: string; result: string }> => {
    // Independent test oracle: reads the fixture's DOM/event state, not the
    // automation AX result. This fixed script is never exposed as a product tool.
    return fixtureWindow().webContents.executeJavaScript('({...window.fixture, actualValue: document.querySelector("#query").value})')
  }
  try {
    const first = await measured('open-structured-no-image', () => execute({ action: 'open', url }))
    assert.equal(first.image, undefined)
    assert.equal(first.coordinates, undefined)
    await assert.rejects(execute({ action: 'click', ...owned(first), x: 20, y: 20 }), (error: unknown) => error instanceof AutomationError && error.code === 'SCREENSHOT_REQUIRED')
    assert(Array.isArray(first.nodes) && first.nodes.some(node => node && typeof node === 'object' && 'name' in node && node.name === '查询词'))
    let captureCalls = 0
    const window = fixtureWindow()
    const capturePage = window.webContents.capturePage.bind(window.webContents)
    window.webContents.capturePage = (...args) => { captureCalls++; return capturePage(...args) }
    const observation = await execute({ action: 'observe', tab: owned(first).tab })
    assert.equal(captureCalls, 0, 'Structured observations must not call capturePage')
    const query = '中文课堂 HQHarness'
    const result = await measured('one-plan-three-local-steps', () => execute({ action: 'run', ...owned(observation), steps: [
      { action: 'type', target: { name: '查询词', role: 'textbox' }, text: query, replace: true },
      { action: 'click', target: { name: '搜索', role: 'button' } },
      { action: 'wait', target: { name: '结果：' + query, role: 'status' } }
    ] }))
    assert.deepEqual((result.sequence as { status: string; completed: number }).status, 'completed')
    assert.equal((result.sequence as { completed: number }).completed, 3)
    const state = await readState()
    assert.equal(state.text, query, 'Chinese replacement must reach the real page')
    assert.equal(state.result, '结果：' + query)
    assert.equal(state.searches, 1)
    assert.equal(captureCalls, 0)
    const pictured = await measured('explicit-image', () => execute({ action: 'observe', tab: owned(result).tab, screenshot: true }))
    assert(pictured.image && Buffer.from(pictured.image.png, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    assert.equal(captureCalls, 1)
    const clicked = await measured('explicit-image-coordinate-input', () => execute({ action: 'click', ...owned(pictured), x: 20, y: 20 }))
    const failed = await measured('ambiguous-stops-before-input', () => execute({ action: 'run', ...owned(clicked), steps: [
      { action: 'click', target: { name: '相同操作', role: 'button' } },
      { action: 'type', target: { name: '查询词', role: 'textbox' }, text: '不应输入', replace: true }
    ] }))
    assert.equal(failed.observation_required, true)
    assert.equal((failed.sequence as { error: { code: string } }).error.code, 'AMBIGUOUS_TARGET')
    assert.equal((await readState()).duplicateClicks, 0)
    assert.equal((await readState()).text, query)
    assert.equal(captureCalls, 1)

    const beforeTimeout = await execute({ action: 'observe', tab: owned(first).tab })
    await window.webContents.executeJavaScript('window.startSlowStages()')
    const timeoutStarted = performance.now()
    const timedOut = await measured('fifteen-second-plan-deadline', () => execute({ action: 'run', ...owned(beforeTimeout), steps: Array.from({ length: 8 }, (_, index) => ({ action: 'wait' as const, target: { name: '阶段' + (index + 1), role: 'status' } })) }))
    assert.equal(timedOut.observation_required, true)
    assert.equal((timedOut.sequence as { error: { code: string } }).error.code, 'SEQUENCE_TIMEOUT')
    assert(performance.now() - timeoutStarted < 17_000, 'The local wait plan must return near its 15 second deadline')
    assert.equal((await readState()).searches, 1)
    const beforeCancel = await execute({ action: 'observe', tab: owned(first).tab })
    await window.webContents.executeJavaScript('window.fixture.cancelOnInput = true')
    const controller = new AbortController()
    const cancelled = (details: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
      if (details.message === 'HQ_FIXTURE_CANCEL') controller.abort(new AutomationError('STOPPED', 'Fixture cancelled after its first input'))
    }
    window.webContents.on('console-message', cancelled)
    try {
      await measured('cancel-stops-following-steps', async () => {
        await assert.rejects(execute({ action: 'run', ...owned(beforeCancel), steps: [
          { action: 'type', target: { name: '查询词', role: 'textbox' }, text: '触发取消', replace: true },
          { action: 'wait', target: { name: '永远不存在', role: 'status' } },
          { action: 'click', target: { name: '搜索', role: 'button' } }
        ] }, controller.signal), (error: unknown) => error instanceof AutomationError && error.code === 'STOPPED')
        assert.equal(window.isDestroyed(), true, 'Cancellation closes only the isolated automation tab')
      })
    } finally { if (!window.isDestroyed()) window.webContents.off('console-message', cancelled) }
    console.log('BROWSER_LOCAL_EXECUTION_PASS ' + JSON.stringify({ platform: process.platform, arch: process.arch, operations, screenshots, stages, scope: 'real Electron local browser execution; no model or cloud requests; not an end-to-end model speed comparison' }))
  } finally {
    browser.stop()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
