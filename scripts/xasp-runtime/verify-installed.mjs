/** Launch the installed application and verify its normal OA composition. */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'

const workflows = [
  'oa-travel-expense', 'oa-home-travel-expense', 'oa-business-travel-application', 'oa-reception-expense'
]
const windows = process.platform === 'win32'

async function announcedUrl(log, child, exited) {
  const deadline = Date.now() + (windows ? 210_000 : 75_000)
  while (!exited() && Date.now() < deadline) {
    let contents
    try {
      contents = await readFile(log, 'utf8')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (contents?.includes('[desktop] Harness entry failed during startup')) {
      throw new Error('Installed Harness entry failed during startup')
    }
    if (contents?.includes('[desktop] Harness is ready')) {
      const endpoint = [...contents.matchAll(/\bdsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/gu)].at(-1)?.[1]
      if (endpoint) return new URL(endpoint)
    }
    await delay(250)
  }
  throw new Error(exited() ? `Installed desktop exited early (${child.exitCode ?? child.signalCode ?? 'launch failed'})` : 'Installed Harness did not announce an authenticated endpoint')
}

async function inspectClient(html, origin, headers) {
  const urls = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/gu)]
    .map(match => match[1].replaceAll('&amp;', '&'))
  for (const id of ['@deepseek-ai/dsh-client-modules', 'hqharness-oa']) {
    const route = urls.find(url => url.includes(`${id}/client.js`))
    if (!route) throw new Error(`Installed Harness HTML did not advertise the ${id} client script`)
    const url = new URL(route, origin)
    if (url.origin !== origin || url.pathname !== '/plugins/') throw new Error('Unexpected installed client script URL')
    const response = await fetch(url, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok || !/\b(?:java|ecma)script\b/iu.test(response.headers.get('content-type') ?? '')) {
      throw new Error(`Installed client script ${id} was not served as JavaScript (HTTP ${response.status})`)
    }
    const registrations = new Set()
    runInNewContext(await response.text(), {
      window: { __ModuleLoader__: { load: value => {
        if (typeof value?.factory === 'function') registrations.add(value.id)
      } } }
    }, { timeout: 2_000 })
    if (!registrations.has(id)) throw new Error(`Installed client script did not register ${id}`)
  }
}

async function verifyComposition(endpoint, payload, profile) {
  const origin = endpoint.origin
  const login = await fetch(endpoint, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
  const cookie = login.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ')
  if (!cookie) throw new Error(`Installed Harness token exchange failed (HTTP ${login.status})`)
  const headers = { Cookie: cookie }
  const rpc = async (method, args) => {
    const response = await fetch(new URL(`/api/${method}`, origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: method, method, payload: { args } })
    })
    if (!response.ok) throw new Error(`Installed Harness ${method} returned HTTP ${response.status}`)
    const envelope = await response.json()
    if (!envelope.result?.ok) throw new Error(`Installed Harness ${method} was rejected`)
    return envelope.result.value
  }
  const initialized = await rpc('workspace/initializeDefault', {})
  const expectedWorkspace = await realpath(join(profile, 'documents', 'HuaqingDesktop', 'default-workspace'))
  if (!initialized?.workspace?.path || await realpath(initialized.workspace.path) !== expectedWorkspace) {
    throw new Error('Installed desktop diagnostic workspace is outside the isolated profile')
  }
  const { sessionId } = await rpc('session/create', { request: { cwd: expectedWorkspace } })
  const { skills } = await rpc('skills/list', { request: { sessionId } })
  for (const name of workflows) {
    const markdown = await readFile(join(payload, 'xasp', 'skill', 'oa', name, 'SKILL.md'), 'utf8')
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(markdown)?.[1]
    const description = frontmatter && parse(frontmatter).description
    const registered = skills.find(skill => skill.name === name)
    if (!description || registered?.description !== description || registered.modelInvocable !== true) {
      throw new Error(`Installed Harness did not expose the packaged invocable skill ${name}`)
    }
  }
  const page = await fetch(origin, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
  if (!page.ok) throw new Error(`Installed Harness page returned HTTP ${page.status}`)
  await inspectClient(await page.text(), origin, headers)
}

const composerProbe = `(() => {
  const picker = document.querySelector('.hqOaOriginals input[type="file"][multiple]');
  const button = document.querySelector('.hqOaOriginals button');
  return !!picker && !!button && !button.disabled && button.getClientRects().length > 0
    && getComputedStyle(button).visibility === 'visible';
})()`

async function hasMountedOaComposer(url) {
  const socket = new WebSocket(url)
  let timer
  try {
    return await new Promise(resolve => {
      timer = setTimeout(() => resolve(false), 2_000)
      socket.addEventListener('close', () => resolve(false), { once: true })
      socket.addEventListener('error', () => resolve(false), { once: true })
      socket.addEventListener('open', () => socket.send(JSON.stringify({
        id: 1, method: 'Runtime.evaluate', params: { expression: composerProbe, returnByValue: true }
      })), { once: true })
      socket.addEventListener('message', ({ data }) => {
        try {
          const response = JSON.parse(data)
          if (response?.id === 1) resolve(response.result?.result?.value === true)
        } catch {
          resolve(false)
        }
      })
    })
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}

async function verifyRenderer(profile, origin, exited) {
  const marker = join(profile, 'DevToolsActivePort')
  const deadline = Date.now() + (windows ? 90_000 : 45_000)
  let waitingFor = 'the isolated debugger port'
  while (!exited() && Date.now() < deadline) {
    const contents = await readFile(marker, 'utf8').catch(error => {
      if (error.code !== 'ENOENT') throw error
      return ''
    })
    const port = contents.split(/\r?\n/u, 1)[0]
    if (/^[1-9]\d{0,4}$/u.test(port) && Number(port) <= 65535) {
      if (waitingFor === 'the isolated debugger port') waitingFor = 'the authenticated desktop renderer'
      const host = `127.0.0.1:${port}`
      const targets = await fetch(`http://${host}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(2_000) })
        .then(response => response.ok ? response.json() : null).catch(() => null)
      const renderer = Array.isArray(targets) && targets.find(target => target?.type === 'page'
        && typeof target.url === 'string' && target.url.startsWith(`${origin}/`)
        && typeof target.id === 'string' && /^[a-f0-9-]+$/iu.test(target.id))
      if (renderer) {
        const socketUrl = `ws://${host}/devtools/page/${renderer.id}`
        if (renderer.webSocketDebuggerUrl !== socketUrl) throw new Error('Unexpected installed desktop debugger target URL')
        waitingFor = 'the visible OA originals composer control'
        // OaOriginals renders only after its real preload IPC reports availability.
        if (await hasMountedOaComposer(socketUrl)) return
      }
    }
    await delay(250)
  }
  throw new Error(`Installed desktop did not expose ${waitingFor}`)
}

async function stop(child, completion, exited) {
  if (!child.pid) return
  if (windows) {
    if (!exited()) {
      try {
        await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, timeout: 10_000 })
      } catch (error) {
        if (!exited()) throw new Error('Could not stop the installed Windows test process tree', { cause: error })
      }
    }
  } else {
    const killGroup = signal => {
      try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
    killGroup('SIGTERM')
    await Promise.race([completion, delay(3_000, undefined, { ref: false })])
    // Reap any Chromium child that outlived the main process.
    killGroup('SIGKILL')
  }
  if (!await Promise.race([completion.then(() => true), delay(5_000, false, { ref: false })])) {
    throw new Error('Installed desktop test process did not exit')
  }
}

export async function verifyInstalledXasp(executable) {
  const binDirectory = dirname(executable)
  const resources = windows ? join(binDirectory, 'resources') : join(binDirectory, '..', 'Resources')
  const payload = join(resources, 'xasp-runtime')
  const manifest = JSON.parse(await readFile(join(payload, 'manifest.json'), 'utf8'))
  if (manifest.format !== 1 || typeof manifest.enabled !== 'boolean') throw new Error('Invalid installed XASP manifest')
  if (!manifest.enabled) {
    if (process.env.XASP_REQUIRE_BUNDLE === '1') throw new Error('Required XASP runtime is disabled in the installed application')
    return
  }
  const profile = await mkdtemp(join(tmpdir(), 'hqharness-installed-xasp-'))
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ELECTRON_RUN_AS_NODE$|OA_|HQHARNESS_OA_)/iu.test(name)))
  const child = spawn(executable, [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0'
  ], { cwd: profile, env, stdio: 'ignore', detached: !windows })
  let finished = false
  const completion = new Promise(resolveCompletion => {
    const done = () => { finished = true; resolveCompletion() }
    child.once('close', done)
    child.once('error', done)
  })
  const exited = () => finished || child.exitCode !== null || child.signalCode !== null
  try {
    const endpoint = await announcedUrl(join(profile, 'logs', 'harness.log'), child, exited)
    await verifyComposition(endpoint, payload, profile)
    await verifyRenderer(profile, endpoint.origin, exited)
  } finally {
    await stop(child, completion, exited)
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
  console.log('Installed HQHarness verified its isolated workspace, four OA skills and the visible OA originals control in the desktop renderer.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/xasp-runtime/verify-installed.mjs <installed desktop executable>')
  await verifyInstalledXasp(resolve(process.argv[2]))
}
