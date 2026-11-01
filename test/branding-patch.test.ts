import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

describe('Huaqing Desktop frontend branding', () => {

  it('keeps the product name in idle, session, panel and cleanup document titles', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
      'utf8'
    )
    const component = /function DocumentTitle\([\s\S]+?\n\t\t\}/u.exec(client)?.[0]
    const assignment = /const productTitle = ("[^"]+");/u.exec(client)?.[1]
    if (!component || !assignment) throw new Error('Expected the upstream document-title component and product constant')
    const productTitle: unknown = JSON.parse(assignment)
    if (typeof productTitle !== 'string') throw new Error('Expected a string product title')

    for (const [sessionTitle, activePanelId, expected] of [
      [undefined, null, 'Huaqing Desktop'],
      ['Project notes', null, 'Project notes — Huaqing Desktop'],
      ['项目笔记', null, '项目笔记 — Huaqing Desktop'],
      ['Project notes', 'settings', 'Huaqing Desktop']
    ] as const) {
      const document = { title: 'Initial HTML title' }
      let dispose: (() => void) | undefined
      const state = { byId: sessionTitle === undefined ? {} : {
        session: { id: 'session', title: sessionTitle, retainedBy: { mainView: 1 } }
      } }
      const props = {
        productTitle,
        usePanelInfo: (selector: (info: { activePanelId: string | null }) => boolean) => selector({ activePanelId }),
        useSessions: (selector: (value: typeof state) => string | undefined) => selector(state)
      }
      vm.runInNewContext(`${component}\nDocumentTitle(props)`, {
        props,
        document,
        react: { useEffect: (effect: () => () => void) => { dispose = effect() } }
      })
      expect(document.title).toBe(expected)
      dispose?.()
      expect(document.title).toBe('Huaqing Desktop')
    }
  })

  it('uses upstream platform-aware collapsed titlebar spacing', async () => {
    const client = await readFile(
      path.join(projectRoot, 'node_modules/@deepseek-ai/dsh-client-ui-layout/lib/client.js'),
      'utf8'
    )

    expect(client).toContain('document.documentElement.dataset.platform === "darwin"')
    expect(client).toContain('document.documentElement.hasAttribute("data-windows-titlebar") ? 0 : 56')
    expect(client).toContain('sidebar === 0 ? collapsedWidth')
  })

  it('installs the source logo into the Harness static frontend', async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(projectRoot, 'package.json'), 'utf8')
    ) as { scripts: { postinstall: string; 'ui:prepare': string } }

    expect(packageJson.scripts.postinstall).toContain('npm run ui:prepare')
    expect(packageJson.scripts['ui:prepare']).toContain('node scripts/install-brand-assets.mjs')
  })
})
