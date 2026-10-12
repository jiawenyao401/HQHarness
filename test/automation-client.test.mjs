// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

let root
globalThis.IS_REACT_ACT_ENVIRONMENT = true
let cleanup = []
afterEach(async () => {
  if (root) await act(() => root.unmount())
  root = undefined
  for (const dispose of cleanup.splice(0)) dispose()
  document.body.innerHTML = ''
  delete window.hqDesktopAutomation
  delete window.__ModuleLoader__
})
function client(locale = 'en') {
  const registrations = []
  let plugin
  window.__ModuleLoader__ = { load: module => { plugin = module.factory(name => { if (name === 'react') return React; throw new Error(name) }) } }
  window.eval(readFileSync(path.resolve('packages/hqharness-automation/client.js'), 'utf8'))
  const dictionary = {}
  plugin.apply({
    effect: run => { const dispose = run(); if (typeof dispose === 'function') cleanup.push(dispose) },
    locale: { register: (_ns, data) => Object.assign(dictionary, data[locale]), bind: () => key => dictionary[key] },
    slots: { inject: (_slot, run) => run(), register: (spec, component) => registrations.push({ spec, component }) }
  })
  return registrations
}
describe('built-in automation settings UI', () => {
  it('registers both settings slots and owns removable scoped styles', () => {
    const cards = client('zh')
    expect(cards.map(card => card.spec.id)).toEqual(['hq-browser-use', 'hq-computer-use'])
    expect(cards[0].spec.label()).toContain('浏览器')
    expect(document.querySelector('[data-plugin-css=hqharness-automation]')).not.toBeNull()
  })
  it('shows permission denial, performs native stop and handles IPC errors', async () => {
    const status = { supported: true, accessibility: false, screenCapture: false, activeSessions: 1, shortcut: true }
    window.hqDesktopAutomation = { status: vi.fn(async () => status), stop: vi.fn(async () => ({ ...status, activeSessions: 0 })), permissions: vi.fn(async () => { throw new Error('OS unavailable') }) }
    const card = client()[1]
    const container = document.createElement('ul'); document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => { root.render(React.createElement(card.component, card.spec.inject())); await Promise.resolve() })
    expect(container.textContent).toContain('Accessibility and screen recording')
    const button = name => [...container.querySelectorAll('button')].find(item => item.textContent === name)
    await act(async () => { button('Stop all automation now').click(); await Promise.resolve() })
    expect(window.hqDesktopAutomation.stop).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('All grants revoked')
    await act(async () => { button('Open system permissions').click(); await Promise.resolve() })
    expect(container.textContent).toContain('The action failed')
  })
})
