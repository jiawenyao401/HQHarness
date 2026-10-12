import { readFile } from 'node:fs/promises'
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import { buildPluginRecoveryViewModel } from '../src/main/plugin-recovery-view'
import { buildSafeModeViewModel } from '../src/main/safe-mode'

const variants = [
  { locale: 'zh', theme: 'light' },
  { locale: 'zh', theme: 'dark' },
  { locale: 'en', theme: 'light' },
  { locale: 'en', theme: 'dark' }
]

async function openPage(file, model, theme, bridgeName) {
  const html = await readFile(new URL(`../build/${file}`, import.meta.url), 'utf8')
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => errors.push(error.message))
  const action = vi.fn(async () => ({ ok: true }))
  const params = new URLSearchParams({ state: JSON.stringify(model), theme })
  const dom = new JSDOM(html, {
    url: `https://hqharness.test/${file}?${params}`,
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      window[bridgeName] = { action }
    }
  })
  return { dom, action, errors }
}

function expectIndependentBranding(document, locale, theme) {
  expect(document.title).toContain('HQHarness')
  expect(document.documentElement.lang).toBe(locale === 'zh' ? 'zh-CN' : 'en')
  expect(document.documentElement.dataset.theme).toBe(theme)
  expect(document.querySelector('#community-wechat')).toBeNull()
  expect(document.querySelector('#community-discord')).toBeNull()
  expect(document.querySelector('img[src="community-wechat-qr.png"]')).toBeNull()
  expect(document.body.textContent).not.toContain('DSH Desktop')
}

describe('HQHarness independent recovery pages', () => {
  it.each(variants)('keeps recovery and logs functional in $locale / $theme', async ({ locale, theme }) => {
    const model = buildPluginRecoveryViewModel({
      snapshot: { phase: 'failed', message: 'Harness stopped.', logs: [] },
      locale, plugins: [], removedPlugins: []
    })
    const { dom, action, errors } = await openPage('plugin-recovery.html', model, theme, 'dshRecovery')
    try {
      const document = dom.window.document
      expect(errors).toEqual([])
      expectIndependentBranding(document, locale, theme)
      document.getElementById('show-log').click()
      expect(action).toHaveBeenCalledWith('show-log')
      document.getElementById('primary').click()
      expect(action).toHaveBeenCalledWith('safe-mode')
      expect(document.getElementById('primary').disabled).toBe(true)
    } finally {
      dom.window.close()
    }
  })

  it.each(variants)('keeps plugin selection and apply functional in $locale / $theme', async ({ locale, theme }) => {
    const model = buildSafeModeViewModel({ locale, plugins: ['local-workbench'] })
    const { dom, action, errors } = await openPage('safe-mode.html', model, theme, 'dshSafeMode')
    try {
      const document = dom.window.document
      expect(errors).toEqual([])
      expectIndependentBranding(document, locale, theme)
      expect(document.getElementById('apply').disabled).toBe(true)
      document.getElementById('select-all').click()
      expect(document.getElementById('apply').disabled).toBe(false)
      document.getElementById('apply').click()
      expect(action).toHaveBeenCalledWith('apply', { plugins: ['local-workbench'], issues: [] })
      expect(document.getElementById('apply').disabled).toBe(true)
      expect(document.getElementById('restart').disabled).toBe(true)
    } finally {
      dom.window.close()
    }
  })
})
