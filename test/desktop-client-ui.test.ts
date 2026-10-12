import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

const projectRoot = path.resolve(import.meta.dirname, '..')

interface Registration {
  config: { name: string; id?: string; order?: number }
  component: (props: Record<string, unknown>) => unknown
}

describe('HQHarness client slot occupants', () => {
  it('registers one HQHarness occupant per brand seat', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-client-ui', 'client.js'),
      'utf8'
    )
    let definition: {
      factory: (require: (id: string) => unknown) => {
        apply: (ctx: unknown) => void
        inject: string[]
      }
    } | undefined
    const appended: Array<{ textContent?: string }> = []
    const removeStyle = vi.fn()
    let disposeStyle: (() => void) | undefined
    const document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => ({ id: '', dataset: {}, textContent: '', remove: removeStyle })),
      head: { appendChild: (node: { textContent?: string }) => appended.push(node) }
    }
    vm.runInNewContext(source, {
      document,
      navigator: { language: 'en-US' },
      window: {
        __ModuleLoader__: {
          load: (value: typeof definition) => {
            definition = value
          }
        }
      }
    })

    expect(definition).toBeDefined()
    const createElement = (
      type: unknown,
      props: Record<string, unknown> | null,
      ...children: unknown[]
    ): { type: unknown; props: Record<string, unknown> } => ({
      type,
      props: { ...props, children }
    })
    const plugin = definition!.factory((id) => {
      if (id === 'react') {
        return {
          createElement,
          useEffect: (effect: () => void | (() => void)) => effect(),
          useState: (initial: unknown) => [initial, vi.fn()]
        }
      }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') {
        return { MenuItemButton: vi.fn() }
      }
      throw new Error(`Unexpected client dependency: ${id}`)
    })

    const registrations: Registration[] = []
    const slots = {
      inject: (_name: string, callback: () => unknown): unknown => {
        const result = callback()
        if (result && typeof result === 'object' && Symbol.iterator in result) {
          for (const _entry of result as Iterable<unknown>) void _entry
        }
        return result
      },
      register: (
        config: Registration['config'],
        component: Registration['component']
      ): (() => void) => {
        registrations.push({ config, component })
        return () => undefined
      }
    }
    plugin.apply({ slots, effect: (setup: () => (() => void) | undefined) => { disposeStyle = setup() } })

    expect(plugin.inject).toEqual(['slots', 'remote.session', 'sessions', 'uiWorkspace'])
    expect(registrations.map(({ config }) => config.name)).toEqual([
      'sidebar.brand.mark',
      'sidebar.brand.name',
      'conversation.hero.brand.mark',
      'sidebar.right.tab.document.unpreviewable',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item',
      'sidebar.workspaces.session.menu.item'
    ])
    // Desktop toolbar styles have an owned lifetime; brand colors are scoped to artwork.
    expect(appended).toHaveLength(1)
    expect(appended[0]?.textContent).toContain("[data-dsh-preset-search]")
    disposeStyle?.()
    expect(removeStyle).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({}) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarName.type).toBe('span')
    expect(sidebarName.props.children).toEqual(['HQHarness'])

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('svg')
    expect(sidebarMark.props.height).toBe(24)
    expect(sidebarMark.props.viewBox).toBe('0 0 1000 1000')
    const [markPath, accentPath] = sidebarMark.props.children as Array<{ type: unknown; props: Record<string, unknown> }>
    if (!markPath) throw new Error('Expected the sidebar brand SVG path')
    expect(markPath.type).toBe('path')
    expect(markPath.props.fill).toBe('var(--dsw-alias-label-primary-bluish)')
    expect(markPath.props.fillRule).toBe('evenodd')
    const brandSource = await readFile(path.join(projectRoot, 'build/brand-mark.svg'), 'utf8')
    const brandPath = /\sd="([^"]+)"/u.exec(brandSource)?.[1]
    expect(brandPath).toBeTruthy()
    expect(markPath.props.d).toBe(brandPath)
    expect(accentPath?.props.d).toBe(brandPath?.slice(brandPath.lastIndexOf('M')))
    expect(accentPath?.props.fill).toBe('var(--dsw-alias-state-business-primary)')
    expect(sidebarMark.props.style).toEqual({ '--dsw-alias-state-business-primary': '#14B8A6' })

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe('svg')
    expect(heroMark.props.width).toBe(48)
    expect(heroMark.props.height).toBe(48)
    expect(heroMark.props.viewBox).toBe(sidebarMark.props.viewBox)
    expect(heroMark.props.children).toEqual(sidebarMark.props.children)
  })
})
