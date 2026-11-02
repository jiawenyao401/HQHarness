// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root
const disposers = []
afterEach(async () => {
  if (root) await act(() => root.unmount())
  root = undefined
  for (const dispose of disposers.splice(0).reverse()) dispose()
  document.body.innerHTML = ''
  delete window.hqWps
  delete window.__ModuleLoader__
})

function loadClient(language = 'en') {
  const slots = []
  const locales = {}
  let plugin
  window.__ModuleLoader__ = { load: module => { plugin = module.factory(name => { if (name === 'react') return React; throw new Error(name) }) } }
  window.eval(readFileSync(resolve('packages/hqharness-wps/client.js'), 'utf8'))
  plugin.apply({
    effect: run => { const dispose = run(); if (typeof dispose === 'function') disposers.push(dispose) },
    locale: {
      register: (namespace, dictionaries) => { locales[namespace] = dictionaries },
      bind: namespace => (key, params = {}) => {
        const value = locales[namespace][language][key]
        if (typeof value !== 'string') throw new Error(`Missing locale key: ${key}`)
        return value.replace(/\{(\w+)\}/g, (_match, name) => String(params[name]))
      }
    },
    slots: { inject: (name, run) => { expect(name).toBe('settings.plugins.tab'); run() }, register: (spec, component) => slots.push({ spec, component }) }
  })
  return { slots, locales }
}

async function mount(language = 'en') {
  const { slots } = loadClient(language)
  const card = slots[0]
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => { root.render(React.createElement(card.component, card.spec.inject())); await Promise.resolve() })
  return container
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found
}

const status = { supported: true, registered: false, connectedDocuments: 0, frozenDocuments: 0, needsWpsRestart: false }

describe('WPS settings client', () => {
  it('owns one independent localized tab and removable scoped styles', () => {
    const { slots, locales } = loadClient('zh')
    expect(slots).toHaveLength(1)
    expect(slots[0].spec).toMatchObject({ name: 'settings.plugins.tab', id: 'hq-local-wps' })
    expect(slots[0].spec.label()).toBe('WPS Office')
    const dictionaries = locales['settings.localWps']
    expect(Object.keys(dictionaries.zh).sort()).toEqual(Object.keys(dictionaries.en).sort())
    const style = document.querySelector('[data-plugin-css=hqharness-wps]')
    expect(style.textContent).toContain('--dsw-alias-')
    expect(style.textContent).not.toContain('--ds-')
    for (const dispose of disposers.splice(0).reverse()) dispose()
    expect(document.querySelector('[data-plugin-css=hqharness-wps]')).toBeNull()
  })

  it('distinguishes registration, connected documents and frozen writes', async () => {
    window.hqWps = { status: vi.fn(async () => ({ ...status, registered: true, connectedDocuments: 2, frozenDocuments: 1 })), register: vi.fn(), stop: vi.fn() }
    const container = await mount('zh')
    expect(container.textContent).toContain('已连接文档：2')
    expect(container.textContent).toContain('暂停写入的文档：1')
    expect(container.textContent).toContain('请先在 WPS 中核对实际结果')
    expect(button(container, '修复加载项注册').disabled).toBe(false)
    expect(window.hqWps.register).not.toHaveBeenCalled()
  })

  it('registers only on user action and refreshes the native status afterward', async () => {
    const next = { ...status, registered: true, needsWpsRestart: true }
    window.hqWps = { status: vi.fn().mockResolvedValueOnce(status).mockResolvedValue(next), register: vi.fn(async () => next), stop: vi.fn() }
    const container = await mount()
    expect(window.hqWps.register).not.toHaveBeenCalled()
    await act(async () => { button(container, 'Enable WPS connection').click(); await Promise.resolve() })
    expect(window.hqWps.register).toHaveBeenCalledTimes(1)
    expect(window.hqWps.status).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('Add-in registration completed. Reopen WPS')
    expect(container.textContent).toContain('Waiting for WPS documents')
  })

  it('maps native restart errors and treats declined consent as cancellation', async () => {
    window.hqWps = { status: vi.fn(async () => status), register: vi.fn().mockRejectedValueOnce(new Error("Error invoking remote method: WPS_RESTART_REQUIRED: internal private path")).mockRejectedValueOnce(new Error('WPS_DENIED: declined')), stop: vi.fn() }
    const container = await mount()
    await act(async () => { button(container, 'Enable WPS connection').click(); await Promise.resolve() })
    expect(container.textContent).toContain('WPS is still running. Save your documents')
    expect(container.textContent).not.toContain('internal private path')
    await act(async () => { button(container, 'Enable WPS connection').click(); await Promise.resolve() })
    expect(container.textContent).toContain('was cancelled')
    expect(container.querySelector('[role=alert]')).toBeNull()
    expect(container.textContent).not.toContain('registration completed')
  })

  it('prevents duplicate actions and discards native completion after unmount', async () => {
    let complete
    const pending = new Promise(resolve => { complete = resolve })
    window.hqWps = { status: vi.fn(async () => status), register: vi.fn(() => pending), stop: vi.fn() }
    const container = await mount()
    const enable = button(container, 'Enable WPS connection')
    await act(async () => { enable.click(); enable.click(); await Promise.resolve() })
    expect(window.hqWps.register).toHaveBeenCalledTimes(1)
    expect(enable.disabled).toBe(true)
    await act(() => root.unmount())
    root = undefined
    await act(async () => { complete({ ...status, registered: true }); await pending })
    expect(window.hqWps.status).toHaveBeenCalledTimes(1)
  })

  it('keeps writes disabled when the IPC status is malformed', async () => {
    window.hqWps = { status: vi.fn(async () => ({ ...status, frozenDocuments: -1 })), register: vi.fn(), stop: vi.fn() }
    const container = await mount()
    expect(button(container, 'Enable WPS connection').disabled).toBe(true)
    expect(container.querySelector('[role=alert]').textContent).toContain('The action failed')
    expect(container.textContent).not.toContain('Invalid WPS status')
  })

  it('requests stop without implying that in-flight writes were rolled back', async () => {
    const connected = { ...status, registered: true, connectedDocuments: 1 }
    window.hqWps = { status: vi.fn(async () => connected), register: vi.fn(), stop: vi.fn(async () => connected) }
    const container = await mount()
    await act(async () => { button(container, 'Stop WPS operations and revoke access').click(); await Promise.resolve() })
    expect(window.hqWps.stop).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('Connected documents: 1')
    expect(container.textContent).toContain('Operations already started may still complete')
    expect(container.textContent).toContain('WPS access was revoked and a stop was requested')
  })
})
