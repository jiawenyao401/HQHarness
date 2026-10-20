import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { automationUrl, AutomationError, type AutomationOperation, type AutomationResult, type AutomationStep } from '../../shared/automation'
import { parseAutomationKey } from './native-input'
import { runAutomationSequence } from './sequence'

interface BrowserTab { id: string; owner: string; window: BrowserWindow; snapshot?: string; observedAt?: number; hasScreenshot: boolean; refs: Map<string, number>; nodes: AXNode[] }
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
    const tab: BrowserTab = { id: randomUUID(), owner, window, hasScreenshot: false, refs: new Map(), nodes: [] }
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
  private async observe(tab: BrowserTab, signal: AbortSignal, includeImage = false): Promise<AutomationResult> {
    signal.throwIfAborted()
    const response = await this.command<{ nodes: AXNode[] }>(tab, 'Accessibility.getFullAXTree')
    signal.throwIfAborted()
    tab.refs.clear()
    tab.nodes = response.nodes.filter(node => !node.ignored)
    const nodes = tab.nodes.slice(0, 250).map((node, i) => {
      const ref = `e${i + 1}`
      if (node.backendDOMNodeId) tab.refs.set(ref, node.backendDOMNodeId)
      return { ref, role: node.role?.value, name: node.name?.value?.slice(0, 300), value: node.role?.value === 'textbox' ? undefined : typeof node.value?.value === 'string' ? node.value.value.slice(0, 300) : node.value?.value, properties: node.properties?.filter(property => ['disabled', 'readonly', 'checked', 'expanded'].includes(property.name)) }
    })
    const bounds = tab.window.getContentSize()
    const screenshot = includeImage ? await tab.window.webContents.capturePage() : undefined
    signal.throwIfAborted()
    const reduced = screenshot?.resize({ width: Math.min(1280, screenshot.getSize().width) })
    tab.snapshot = randomUUID()
    tab.observedAt = Date.now()
    tab.hasScreenshot = !!reduced
    return { tab: tab.id, snapshot: tab.snapshot, url: tab.window.webContents.getURL(), title: tab.window.webContents.getTitle(), nodes, truncated: response.nodes.length > 250, ...(reduced ? { coordinates: { width: bounds[0], height: bounds[1] }, image: { png: reduced.toPNG().toString('base64'), ...reduced.getSize() } } : {}) }
  }
  private async location(tab: BrowserTab, op: AutomationOperation, signal: AbortSignal, resolvedNodeId?: number): Promise<{ x: number; y: number }> {
    if (op.ref || resolvedNodeId !== undefined) {
      const backendNodeId = resolvedNodeId ?? (op.ref ? tab.refs.get(op.ref) : undefined)
      if (!backendNodeId) throw new AutomationError('STALE_ELEMENT', 'Observe again and use a current element reference')
      signal.throwIfAborted()
      await this.command(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      signal.throwIfAborted()
      const { quads } = await this.command<{ quads: number[][] }>(tab, 'DOM.getContentQuads', { backendNodeId })
      const q = quads[0]
      if (!q || q.length !== 8) throw new AutomationError('ELEMENT_HIDDEN', 'This element has no clickable area')
      return { x: (q[0] ?? 0) / 4 + (q[2] ?? 0) / 4 + (q[4] ?? 0) / 4 + (q[6] ?? 0) / 4, y: (q[1] ?? 0) / 4 + (q[3] ?? 0) / 4 + (q[5] ?? 0) / 4 + (q[7] ?? 0) / 4 }
    }
    if (!tab.hasScreenshot) throw new AutomationError('SCREENSHOT_REQUIRED', 'Coordinate input requires a current observation with screenshot: true; use a named control or element ref for DOM-only input')
    if (op.x === undefined || op.y === undefined) throw new AutomationError('INVALID_COORDINATES', 'Provide a current element reference or screenshot coordinates')
    const [width, height] = tab.window.getContentSize()
    if (width === undefined || height === undefined || op.x < 0 || op.y < 0 || op.x >= width || op.y >= height) throw new AutomationError('INVALID_COORDINATES', 'Coordinates are outside the browser viewport')
    return { x: op.x, y: op.y }
  }
  private async key(tab: BrowserTab, value: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
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
    signal.throwIfAborted()
  }
  private target(tab: BrowserTab, target: NonNullable<AutomationOperation['target']>, editable = false): AXNode {
    const matches = tab.nodes.filter(node => node.name?.value === target.name && (!target.role || node.role?.value === target.role))
    if (matches.length > 1) throw new AutomationError('AMBIGUOUS_TARGET', 'Several controls have this exact name; provide a unique name and role or observe again')
    const node = matches[0]
    if (!node) throw new AutomationError('TARGET_NOT_FOUND', 'The named control is not present; observe again before changing the plan')
    this.validateNode(node, editable)
    return node
  }
  private validateNode(node: AXNode, editable = false): void {
    if (node.properties?.some(property => property.name === 'disabled' && property.value?.value === true)) throw new AutomationError('TARGET_DISABLED', 'The selected control is disabled')
    if (editable && (!['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(node.role?.value ?? '') || node.properties?.some(property => property.name === 'readonly' && property.value?.value === true))) throw new AutomationError('TARGET_NOT_EDITABLE', 'Typing requires a writable text control')
  }
  private pause(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted()
      const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, 100)
      const aborted = (): void => { clearTimeout(timer); signal.removeEventListener('abort', aborted); reject(signal.reason) }
      signal.addEventListener('abort', aborted, { once: true })
    })
  }
  private async wait(tab: BrowserTab, step: AutomationStep, signal: AbortSignal): Promise<AutomationResult> {
    if (!step.target) throw new AutomationError('INVALID_INPUT', 'Wait requires a named target')
    const deadline = Date.now() + 2_500
    while (true) {
      const observation = await this.observe(tab, signal)
      try {
        const node = this.target(tab, step.target)
        if (step.value === undefined || (typeof node.value?.value === 'string' && node.value.value === step.value)) return observation
      } catch (error) {
        if (!(error instanceof AutomationError) || error.code !== 'TARGET_NOT_FOUND') throw error
      }
      if (Date.now() >= deadline) throw new AutomationError('TARGET_WAIT_TIMEOUT', 'The named control did not reach the expected state; no input was sent by this wait step')
      await this.pause(signal)
    }
  }
  private async act(tab: BrowserTab, op: AutomationOperation, signal: AbortSignal, awaitTarget = false): Promise<void> {
    signal.throwIfAborted()
    let backendNodeId = op.ref ? tab.refs.get(op.ref) : undefined
    if (op.ref) {
      if (!backendNodeId) throw new AutomationError('STALE_ELEMENT', 'Observe again and use a current element reference')
      // Keep the old ref's physical DOM identity while refreshing metadata.
      // Remapping e1 after a redraw could select a different field entirely.
      await this.observe(tab, signal)
      const current = tab.nodes.find(node => node.backendDOMNodeId === backendNodeId)
      if (!current) throw new AutomationError('STALE_ELEMENT', 'The referenced control disappeared; observe before choosing another control')
      this.validateNode(current, op.action === 'type')
    }
    if (op.target) {
      // A planned label can refer to a screen that only appeared after the last
      // action. Resolve it locally from this step's fresh tree, never old refs.
      const deadline = Date.now() + (awaitTarget ? 1_500 : 0)
      while (true) {
        await this.observe(tab, signal)
        try { backendNodeId = this.target(tab, op.target, op.action === 'type').backendDOMNodeId; break }
        catch (error) {
          // A prior step can start navigation or render a delayed menu. Wait
          // briefly only for absence; ambiguity and invalid targets fail closed.
          if (!(error instanceof AutomationError) || error.code !== 'TARGET_NOT_FOUND' || Date.now() >= deadline) throw error
          await this.pause(signal)
        }
      }
      if (!backendNodeId) throw new AutomationError('TARGET_NOT_ACTIONABLE', 'This control has no DOM target; choose another control')
    }
    if (op.action === 'click' || op.action === 'scroll') {
      const point = await this.location(tab, op, signal, backendNodeId)
      signal.throwIfAborted()
      if (op.action === 'scroll') await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: op.deltaX ?? 0, deltaY: op.deltaY ?? 500 })
      else for (let i = 1; i <= (op.clicks ?? 1); i++) {
        signal.throwIfAborted()
        await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: op.button ?? 'left', clickCount: i })
        // Complete the release even if cancellation arrives during mouse-down.
        await this.command(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: op.button ?? 'left', clickCount: i })
      }
    } else if (op.action === 'type') {
      if (op.ref && !backendNodeId) throw new AutomationError('STALE_ELEMENT', 'Observe again before typing into this element')
      if (backendNodeId) await this.command(tab, 'DOM.focus', { backendNodeId })
      signal.throwIfAborted()
      if (op.replace) await this.key(tab, 'MOD+A', signal)
      signal.throwIfAborted()
      await this.command(tab, 'Input.insertText', { text: op.text })
    } else if (op.action === 'key' && op.key) {
      if (backendNodeId) await this.command(tab, 'DOM.focus', { backendNodeId })
      await this.key(tab, op.key, signal)
    } else throw new AutomationError('INVALID_INPUT', 'Unsupported browser input')
    signal.throwIfAborted()
    tab.snapshot = undefined
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
        if (op.action === 'run') {
          const result = await runAutomationSequence(op.steps ?? [], signal, async (step, stepSignal) => {
            if (step.action === 'wait') return this.wait(tab, step, stepSignal)
            if (!step.target && step.action !== 'key') throw new AutomationError('INVALID_INPUT', 'Sequence input requires a named target')
            if (!step.target) await this.observe(tab, stepSignal)
            await this.act(tab, step, stepSignal, true)
            return this.observe(tab, stepSignal)
          })
          if (result.observation_required === true) { tab.snapshot = undefined; return result }
          return op.screenshot === true ? { ...result, ...await this.observe(tab, signal, true) } : result
        }
        await this.act(tab, op, signal)
      }
      return await this.observe(tab, signal, op.screenshot === true)
    } catch (error) {
      tab.snapshot = undefined
      if (op.action === 'open') destroyOnAbort()
      throw error
    } finally { signal.removeEventListener('abort', destroyOnAbort) }
  }
}
