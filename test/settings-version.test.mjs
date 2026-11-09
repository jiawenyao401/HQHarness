import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import * as jsxRuntime from 'react/jsx-runtime'
import * as clientStore from '@deepseek-ai/dsh-client-store'

const bundle = readFileSync(new URL(
  '../node_modules/@deepseek-ai/dsh-client-ui-settings-general/lib/client.js', import.meta.url
), 'utf8')

it.each([
  ['zh', { desktopVersion: '1.23.45' }, '当前版本：1.23.45'],
  ['en', { desktopVersion: '1.23.45' }, 'Current version: 1.23.45'],
  ['en', undefined, 'Current version: 0.2.0-rc.2']
])('renders the current version in %s settings', (locale, desktop, expected) => {
  let versionRow
  let dictionaries
  runInNewContext(bundle, {
    dshDesktop: desktop,
    window: { __ModuleLoader__: { load({ factory }) {
      const settings = factory(name => {
        if (name === 'react/jsx-runtime') return jsxRuntime
        if (name === '@deepseek-ai/dsh-client-store') return clientStore
        return {}
      })
      settings.apply({
        slots: {
          inject(name, register) {
            if (name === 'settings.general.item') register()
          },
          register({ id }, render) {
            if (id === 'current-version') versionRow = render
          }
        },
        locale: {
          register(_namespace, values) { dictionaries = values },
          bind: () => () => ''
        },
        effect: run => run(),
        get: () => ({}),
        remote: { $host: { isLoopback: false } }
      })
    } } }
  })
  expect(versionRow?.({
    t: (key, { version }) => dictionaries[locale][key].replace('{version}', version)
  }).props.children).toBe(expected)
})
