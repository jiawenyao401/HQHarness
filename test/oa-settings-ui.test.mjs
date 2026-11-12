// @vitest-environment jsdom
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const source = await readFile(resolve('packages/hqharness-oa/client.js'), 'utf8')

function loadSettings(bridge, conversation) {
  const entries = [], disposers = []
  let dictionaries
  const require = name => {
    if (name === 'react') return React
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return {
      Input: props => React.createElement('input', props),
      Button: ({ variant: _variant, size: _size, ...props }) => React.createElement('button', props)
    }
    throw new Error(name)
  }
  const context = {
    get: name => name === 'conversation' ? conversation : undefined,
    locale: {
      register(_ns, messages) { dictionaries = messages },
      bind: () => (key, values = {}) => dictionaries.en[key].replace(/\{(\w+)\}/g, (_match, key) => values[key])
    },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    slots: {
      inject(name, register) { expect(['settings.plugins.tab', 'conversation.composer.dock']).toContain(name); register() },
      register(options, Component) { entries.push({ options, Component }) }
    }
  }
  new Function('window', source)({ hqOa: bridge, __ModuleLoader__: { load({ factory }) { factory(require).apply(context) } } })
  return { entries, dictionaries, dispose: () => disposers.reverse().forEach(fn => fn()) }
}

it('keeps the OA settings tab out of web clients without the native bridge', () => {
  expect(loadSettings(undefined).entries).toEqual([])
})

function contents(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

it('preserves PDF and image originals as scoped file drafts and releases them on rejected admission', async () => {
  const bridge = {
    status: async () => ({ ok: true, status: { available: true, configured: false } }),
    configure() {}, clear() {}
  }
  const conversation = {
    resolveDraftAttachments: () => [],
    createDrafts: vi.fn((_sessionId, files) => files.map((file, index) => ({ id: `original-${index}`, file }))),
    releaseDraftAttachments: vi.fn()
  }
  const { entries, dispose } = loadSettings(bridge, conversation)
  const { Component, options } = entries.find(({ options }) => options.name === 'conversation.composer.dock')
  const inputActions = { addAttachments: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false) }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(React.createElement(Component, {
      ...options.inject(), session: { sessionId: 'oa-session' }, input: { phase: 'plain', attachmentIds: [] }, inputActions
    })))
    const picker = container.querySelector('input[type=file]')
    const pickerButton = container.querySelector('button')
    expect(pickerButton.textContent).toBe('Attach OA originals')
    const source = [
      new File([new Uint8Array([37, 80, 68, 70])], 'invoice.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([255, 216, 255, 217])], '发票.jpg', { type: 'image/jpeg' })
    ]
    Object.defineProperty(picker, 'files', { configurable: true, value: source })
    await act(async () => {
      pickerButton.click()
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(inputActions.addAttachments).toHaveBeenCalledExactlyOnceWith(['original-0', 'original-1'])
    const [sessionId, originals] = conversation.createDrafts.mock.calls[0]
    expect(sessionId).toBe('oa-session')
    expect(originals.map(file => [file.name, file.type])).toEqual(source.map(file => [file.name, 'application/octet-stream']))
    expect(await Promise.all(originals.map(contents))).toEqual(await Promise.all(source.map(contents)))

    await act(async () => {
      pickerButton.click()
      picker.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(conversation.releaseDraftAttachments).toHaveBeenCalledExactlyOnceWith(conversation.createDrafts.mock.results[1].value)
    expect(container.querySelector('[role=alert]').textContent).toBe('The originals were not added to this conversation. Select them again.')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    dispose()
  }
})

it('verifies masked inputs through the desktop bridge and shows only the redacted configuration', async () => {
  const empty = { ok: true, status: { available: true, configured: false } }
  const bridge = {
    status: vi.fn(async () => empty),
    configure: vi.fn(async input => ({ ok: true, status: { available: true, configured: true, account: input.account, operatorName: input.operatorName } })),
    clear: vi.fn(async () => empty)
  }
  const { entries, dictionaries, dispose } = loadSettings(bridge)
  const [{ options, Component }] = entries
  expect(options.id).toBe('hq-oa')
  expect(Object.keys(dictionaries.en)).toEqual(Object.keys(dictionaries.zh))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(React.createElement(Component, options.inject())))
    const form = container.querySelector('form')
    const inputs = { account: 'wwb', operatorName: '测试人员', corpid: 'test-company',
      tenantKey: 'test-tenant', appKey: 'private-app-key', appSecret: 'private-app-secret' }
    for (const [name, value] of Object.entries(inputs)) form.elements.namedItem(name).value = value
    expect(form.elements.namedItem('appKey').type).toBe('password')
    expect(form.elements.namedItem('appSecret').type).toBe('password')
    await act(async () => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))

    expect(bridge.configure).toHaveBeenCalledExactlyOnceWith({ environment: 'test', ...inputs })
    expect(container.querySelector('form')).toBeNull()
    expect(container.querySelector('[role=status]').textContent).toBe('Verified operator 测试人员 (wwb)')
    expect(container.textContent).not.toContain(inputs.appSecret)

    const clear = [...container.querySelectorAll('button')].find(button => button.textContent === 'Remove local configuration')
    await act(async () => clear.click())
    expect(bridge.clear).toHaveBeenCalledOnce()
    expect(container.querySelector('form')).not.toBeNull()
    expect(container.querySelector('input[name=appSecret]').value).toBe('')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    dispose()
  }
})
