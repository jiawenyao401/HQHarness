import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { automationUrl, AutomationError, type AutomationOperation, type AutomationResult } from '../../shared/automation'
import { parseAutomationKey } from './native-input'

interface BrowserTab { id: string; owner: string; window: BrowserWindow; snapshot?: string; observedAt?: number; refs: Map<string, number> }
interface AXNode { ignored?: boolean; backendDOMNodeId?: number; role?: { value?: string }; name?: { value?: string }; value?: { value?: unknown }; properties?: { name: string; value: { value?: unknown } }[] }
export class BrowserAutomation {
  private tabs = new Map<string, BrowserTab>()
  private ready = false
  stop(): void {
    for (const tab of this.tabs.values()) if (!tab.window.isDestroyed()) tab.window.destroy()
    this.tabs.clear()
  }
  private create(owner: string): BrowserTab {
    if (this.tabs.size >= 16 || [...this.tabs.values()].filter(tab => tab.owner === owner).length >= 6) throw new AutomationError('TAB_LIMIT', 'Close an automation tab before opening another')
    const browserSession = session.fromPartition('persist:hqharness-browser-use')
    if (!this.ready) {
      browserSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      browserSession.setPermissionCheckHandler(() => false)
      // Downloads must not write files without a deliberate native save choice.
      browserSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: 'HQHarness Browser Use' }))
      this.ready = true
    }
    const window = new BrowserWindow({ width: 1100, height: 760, title: 'HQHarness Browser Use', autoHideMenuBar: true, webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } })
    const tab: BrowserTab = { id: randomUUID(), owner, window, refs: new Map() }
    this.tabs.set(tab.id, tab)
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { const target = automationUrl(url); const popup = this.create(owner); void popup.window.loadURL(target).catch(() => { if (!popup.window.isDestroyed()) popup.window.destroy() }) } catch { /* Non-web popups and excess tabs are deliberately refused. */ }
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => { try { automationUrl(url) } catch { event.preventDefault() } })
    window.webContents.on('will-redirect', (event, url) => { try { automationUrl(url) } catch { event.preventDefault() } })
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('did-navigate', () => { tab.snapshot = undefined; tab.refs.clear() })
    window.webContents.on('did-navigate-in-page', () => { tab.snapshot = undefined; tab.refs.clear() })
    window.on('resize', () => { tab.snapshot = undefined; tab.refs.clear() })
    window.webContents.on('render-process-gone', () => { tab.snapshot = undefined; tab.refs.clear() })
    window.on('closed', () => this.tabs.delete(tab.id))
    window.webContents.debugger.attach('1.3')
    return tab
  }
  private get(owner: string, id?: string): BrowserTab {
    const tab = id ? this.tabs.get(id) : [...this.tabs.values()].find(item => item.owner === owner)
    if (!tab || tab.owner !== owner || tab.window.isDestroyed()) throw new AutomationError('TAB_GONE', 'Open a browser tab or select an owned tab from tabs')
    return tab
  }
  private async command<T>(tab: BrowserTab, method: string, params?: Record<string, unknown>): Promise<T> {
    if (!tab.window.webContents.debugger.isAttached()) throw new AutomationError('DEBUGGER_DETACHED', 'Close and reopen this tab; its automation connection was detached')
    // Chromium owns the CDP response shape; each caller uses a fixed command.
    try { return await tab.window.webContents.debugger.sendCommand(method, params) as T }
    catch (cause) { throw new AutomationError('BROWSER_COMMAND_FAILED', `Chromium ${method} failed; observe again or reopen the tab`, { cause }) }
  }
  private async observe(tab: BrowserTab, signal: AbortSignal, includeImage = true): Promise<AutomationResult> {
    const response = await this.command<{ nodes: AXNode[] }>(tab, 'Accessibility.getFullAXTree')
    signal.throwIfAborted()
    tab.refs.clear()
    const nodes = response.nodes.filter(node => !node.ignored).slice(0, 250).map((node, i) => {
      const ref = `e${i + 1}`
      if (node.backendDOMNodeId) tab.refs.set(ref, node.backendDOMNodeId)
      return { ref, role: node.role?.value, name: node.name?.value?.slice(0, 300), value: node.role?.value === 'textbox' ? undefined : typeof node.value?.value === 'string' ? node.value.value.slice(0, 300) : node.value?.value, properties: node.properties?.filter(property => ['disabled', 'checked', 'expanded'].includes(property.name)) }
    })
    const bounds = tab.window.getContentSize()
    const screenshot = includeImage ? await tab.window.webContents.capturePage() : undefined
    signal.throwIfAborted()
    const reduced = screenshot?.resize({ width: Math.min(1280, screenshot.getSize().width) })
    tab.snapshot = randomUUID()
    tab.observedAt = Date.now()
    return { tab: tab.id, snapshot: tab.snapshot, url: tab.window.webContents.getURL(), title: tab.window.webContents.getTitle(), coordinates: { width: bounds[0], height: bounds[1] }, nodes, truncated: response.nodes.length > 250, ...(reduced ? { image: { png: reduced.toPNG().toString('base64'), ...reduced.getSize() } } : {}) }
  }
  private async location(tab: BrowserTab, op: AutomationOperation): Promise<{ x: number; y: number }> {
    if (op.ref) {
      const backendNodeId = tab.refs.get(op.ref)
      if (!backendNodeId) throw new AutomationError('STALE_ELEMENT', 'Observe again and use a current element reference')
      await this.command(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      const { quads } = await this.command<{ quads: number[][] }>(tab, 'DOM.getContentQuads', { backendNodeId })
      const q = quads[0]
      if (!q || q.length !== 8) throw new AutomationError('ELEMENT_HIDDEN', 'This element has no clickable area')
      return { x: (q[0] ?? 0) / 4 + (q[2] ?? 0) / 4 + (q[4] ?? 0) / 4 + (q[6] ?? 0) / 4, y: (q[1] ?? 0) / 4 + (q[3] ?? 0) / 4 + (q[5] ?? 0) / 4 + (q[7] ?? 0) / 4 }
    }
    if (op.x === undefined || op.y === undefined) throw new AutomationError('INVALID_COORDINATES', 'Provide a current element reference or screenshot coordinates')
    const [width, height] = tab.window.getContentSize()
    if (width === undefined || height === undefined || op.x < 0 || op.y < 0 || op.x >= width || op.y >= height) throw new AutomationError('INVALID_COORDINATES', 'Coordinates are outside the browser viewport')
    return { x: op.x, y: op.y }
  }
  private async key(tab: BrowserTab, value: string): Promise<void> {
    const parsed = parseAutomationKey(value)
    const keyNames: Record<string, string> = { ENTER: 'Enter', ESCAPE: 'Escape', TAB: 'Tab', BACKSPACE: 'Backspace', DELETE: 'Delete', LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', UP: 'ArrowUp', DOWN: 'ArrowDown', HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown', SPACE: ' ' }
    const masks: Record<string, number> = { ALT: 1, CTRL: 2, CMD: 4, SHIFT: 8 }
    const key = keyNames[parsed.key] ?? parsed.key.toLowerCase()
    const modifiers = parsed.modifiers.reduce((flags, name) => flags | (masks[name] ?? 0), 0)
    const virtual = keyNames[parsed.key] ? ({ Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32 }[key] ?? 0) : parsed.key.charCodeAt(0)
    // Chromium's macOS editor needs the edit command in addition to the key
    // event. CDP modifiers alone do not invoke Command+A/C/V/X/Z.
    const editCommands: Record<string, string> = { A: 'selectAll', C: 'copy', V: 'paste', X: 'cut', Z: parsed.modifiers.includes('SHIFT') ? 'redo' : 'undo' }
    const editing = parsed.modifiers.includes(process.platform === 'darwin' ? 'CMD' : 'CTRL') ? editCommands[parsed.key] : undefined
    await this.command(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', key, modifiers, windowsVirtualKeyCode: virtual, ...(key === 'Enter' ? { text: '\r' } : {}), ...(editing ? { commands: [editing] } : {}) })
    await this.command(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', key, modifiers, windowsVirtualKeyCode: virtual })
  }
  private async history(tab: BrowserTab, direction: 'back' | 'forward', signal: AbortSignal): Promise<void> {
    const contents = tab.window.webContents
    if (direction === 'back' ? !contents.navigationHistory.canGoBack() : !contents.navigationHistory.canGoForward()) return
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error): void => {
        contents.off('did-finish-load', success)
        contents.off('did-navigate-in-page', success)
        contents.off('did-fail-load', failed)
        signal.removeEventListener('abort', aborted)
        if (error) reject(error); else resolve()
      }
      const success = (): void => finish()
      const failed = (_event: unknown, code: number): void => finish(new AutomationError('NAVIGATION_FAILED', `Browser history navigation failed (${code})`))
      const aborted = (): void => finish(new AutomationError('CANCELLED', 'Browser navigation was cancelled'))
      contents.once('did-finish-load', success)
      contents.once('did-navigate-in-page', success)
      contents.once('did-fail-load', failed)
      signal.addEventListener('abort', aborted, { once: true })
      if (direction === 'back') contents.navigationHistory.goBack(); else contents.navigationHistory.goForward()
    })
  }
  async execute(owner: string, op: AutomationOperation, signal: AbortSignal): Promise<AutomationResult> {
    signal.throwIfAborted()
    if (op.action === 'status') return { supported: true }
    if (op.action === 'tabs') return { tabs: [...this.tabs.values()].filter(tab => tab.owner === owner).map(tab => ({ id: tab.id, url: tab.window.webContents.getURL(), title: tab.window.webContents.getTitle() })) }
    const tab = op.action === 'open' ? this.create(owner) : this.get(owner, op.tab)
    const destroyOnAbort = (): void => { if (!tab.window.isDestroyed()) tab.window.destroy() }
    signal.addEventListener('abort', destroyOnAbort, { once: true })
    try {
      if (['open', 'navigate'].includes(op.action)) {
        await tab.window.loadURL(automationUrl(op.url))
      } else if (op.action === 'close') { tab.window.destroy(); return { closed: tab.id } }
      else if (op.action === 'back' || op.action === 'forward') await this.history(tab, op.action, signal)
      else if (op.action !== 'observe') {
        if (!op.snapshot || op.snapshot !== tab.snapshot || Date.now() - (tab.observedAt ?? 0) > 90_000) throw new AutomationError('STALE_SNAPSHOT', 'Observe the browser again before acting')
        const backendNodeId = op.ref ? tab.refs.get(op.ref) : undefined
        if (op.action === 'click' || op.action === 'scroll') {
          const point = await this.location(tab, op)
          signal.throwIfAborted()
          if (op.action === 'scroll') await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: op.deltaX ?? 0, deltaY: op.deltaY ?? 500 })
          else for (let i = 1; i <= (op.clicks ?? 1); i++) {
            await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: op.button ?? 'left', clickCount: i })
            await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: op.button ?? 'left', clickCount: i })
          }
        } else if (op.action === 'type') {
          if (op.ref && !backendNodeId) throw new AutomationError('STALE_ELEMENT', 'Observe again before typing into this element')
          if (backendNodeId) await this.command(tab, 'DOM.focus', { backendNodeId })
          signal.throwIfAborted()
          await this.command(tab, 'Input.insertText', { text: op.text })
        } else if (op.action === 'key' && op.key) await this.key(tab, op.key)
        tab.snapshot = undefined
      }
      return await this.observe(tab, signal, op.screenshot !== false)
    } catch (error) {
      tab.snapshot = undefined
      if (op.action === 'open') destroyOnAbort()
      throw error
    } finally { signal.removeEventListener('abort', destroyOnAbort) }
  }
}
