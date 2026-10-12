import { app, BrowserWindow, Menu } from 'electron'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import assert from 'node:assert/strict'
import { BrowserAutomation } from '../../src/main/automation/browser'
import { ComputerAutomation } from '../../src/main/automation/computer'
import type { AutomationOperation, AutomationResult } from '../../src/shared/automation'

async function run(): Promise<void> {
  await app.whenReady()
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]))
  const server = createServer((_request, response) => response.end('<!doctype html><meta charset="utf-8"><title>Automation fixture</title><label>Value <input id="value"></label><button id="inc" onclick="this.textContent=\'Clicked\'">Increment</button>'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/`
  const browser = new BrowserAutomation()
  const computer = new ComputerAutomation()
  const signal = new AbortController().signal
  try {
    let observation = await browser.execute('smoke', { action: 'open', url }, signal)
    assert(observation.image && Buffer.from(observation.image.png, 'base64').subarray(1, 4).toString() === 'PNG')
    const operation = (action: string, extras: Partial<AutomationOperation> = {}): AutomationOperation => ({ action, tab: String(observation.tab), snapshot: String(observation.snapshot), ...extras })
    const ref = (role: string, name: string): string => {
      const nodes = observation.nodes as { ref: string; role: string; name: string }[]
      const node = nodes.find(item => item.role === role && item.name === name)
      assert(node, `Missing ${role} ${name}`)
      return node.ref
    }
    observation = await browser.execute('smoke', operation('click', { ref: ref('button', 'Increment') }), signal)
    assert(ref('button', 'Clicked'))
    observation = await browser.execute('smoke', operation('type', { ref: ref('textbox', 'Value '), text: 'HQ 中文 🐎' }), signal)
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL() === url)
    assert(window)
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#value").value'), 'HQ 中文 🐎')
    observation = await browser.execute('smoke', operation('key', { key: 'MOD+A' }), signal)
    observation = await browser.execute('smoke', operation('type', { text: 'replacement' }), signal)
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#value").value'), 'replacement')
    await assert.rejects(browser.execute('another-session', operation('observe'), signal))
    await assert.rejects(browser.execute('smoke', { ...operation('click'), snapshot: 'stale', ref: 'e1' }, signal))
    observation = await browser.execute('smoke', operation('navigate', { url: url + 'next', screenshot: false }), signal)
    assert.equal(observation.image, undefined)
    assert.equal(observation.url, url + 'next')
    observation = await browser.execute('smoke', operation('back'), signal)
    assert.equal(observation.url, url)
    observation = await browser.execute('smoke', operation('forward'), signal)
    assert.equal(observation.url, url + 'next')
    observation = await browser.execute('smoke', operation('back'), signal)
    console.log('BROWSER PASS: actual Chromium screenshot, AX refs, trusted click, Unicode typing, replacement and session isolation')

    const permission = computer.permissions()
    console.log('COMPUTER PERMISSIONS', JSON.stringify(permission))
    if (!permission.accessibility || !permission.screenCapture) {
      await assert.rejects(computer.execute('smoke', { action: 'observe' }, signal), /permissions|permission|access/iu)
      if (process.env.HQ_AUTOMATION_REQUIRE_INPUT === '1' || process.platform === 'win32') throw new Error('Native input qualification requires an unlocked desktop and OS access')
      console.log('COMPUTER PERMISSION-DENIAL PASS; positive native input requires an interactive authorized machine')
    } else {
      let frame: AutomationResult = await computer.execute('smoke', { action: 'observe' }, signal)
      assert(frame.image?.png && frame.snapshot && frame.display)
      window.show(); window.focus(); window.webContents.focus()
      await delay(350)
      const content = window.getContentBounds()
      const rect: { x: number; y: number } = await window.webContents.executeJavaScript('(()=>{const r=document.querySelector("#value").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()')
      const displays = frame.displays as { id: string; bounds: { x: number; y: number; width: number; height: number } }[]
      const display = displays.find(item => item.id === frame.display)
      assert(display && frame.image)
      await computer.execute('smoke', { action: 'click', display: String(frame.display), snapshot: String(frame.snapshot), x: (content.x + rect.x - display.bounds.x) * frame.image.width / display.bounds.width, y: (content.y + rect.y - display.bounds.y) * frame.image.height / display.bounds.height }, signal)
      assert.equal(await window.webContents.executeJavaScript('document.activeElement.id'), 'value')
      frame = await computer.execute('smoke', { action: 'observe' }, signal)
      await computer.execute('smoke', { action: 'key', display: String(frame.display), snapshot: String(frame.snapshot), key: 'MOD+A' }, signal)
      frame = await computer.execute('smoke', { action: 'observe' }, signal)
      await computer.execute('smoke', { action: 'type', display: String(frame.display), snapshot: String(frame.snapshot), text: 'Native 中文 🐎' }, signal)
      // Native input delivery is asynchronous; verify the actual target.
      let value = ''
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(100)
        value = await window.webContents.executeJavaScript('document.querySelector("#value").value')
        if (value === 'Native 中文 🐎') break
      }
      assert.equal(value, 'Native 中文 🐎')
      await assert.rejects(computer.execute('smoke', { action: 'key', key: 'ENTER', snapshot: 'stale', display: String(frame.display) }, signal), /Observe/)
      console.log('COMPUTER PASS: real desktop capture, snapshot-coordinate native click, native shortcut/Unicode input, stale snapshot refusal')
    }
  } finally {
    browser.stop(); await computer.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
