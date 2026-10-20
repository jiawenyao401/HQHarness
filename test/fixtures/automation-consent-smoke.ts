import { app, BrowserWindow } from 'electron'
import assert from 'node:assert/strict'
import { DesktopAutomationService } from '../../src/main/automation/service'

// Real Electron dialog cancellation, isolated from the installed app/profile.
// No screen capture, desktop input, approval injection or model request occurs.
app.on('window-all-closed', () => undefined)
async function main(): Promise<void> {
  await app.whenReady()
  const parent = new BrowserWindow({ show: false, width: 640, height: 400, title: 'HQHarness authorization regression', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  const service = new DesktopAutomationService(() => parent, () => 'en', { authorizationMs: 1_500, operationMs: 500 })
  try {
    await parent.loadURL('data:text/html,<title>HQHarness authorization regression</title><p>Automatic authorization timeout test. No action will be performed.</p>')
    await service.start()
    const env = service.environment()
    const url = env.HQHARNESS_AUTOMATION_URL
    assert(url)
    for (const capability of ['browser', 'computer'] as const) {
      parent.hide()
      assert.equal(parent.isVisible(), false)
      const response: Awaited<ReturnType<typeof fetch>> = await fetch(url, {
        method: 'POST', headers: { authorization: `Bearer ${env.HQHARNESS_AUTOMATION_TOKEN}` },
        body: JSON.stringify({ capability, owner: 'consent-regression', operation: { action: capability === 'browser' ? 'tabs' : 'observe' } })
      })
      assert.equal(response.status, 400)
      assert.equal((await response.json()).code, 'CONSENT_TIMEOUT')
      assert.equal(service.status().activeSessions, 0)
      assert.equal(parent.isVisible(), true)
      console.log(`NATIVE_CONSENT_TIMEOUT_PASS: ${capability}, actual dialog, visible parent, no false denial or grant`)
    }
    console.log('NATIVE_CONSENT_RETRY_PASS: both requests completed in one service without restarting')
  } finally {
    await service.close()
    parent.destroy()
  }
}
main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
