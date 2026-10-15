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
      getElementById: vi.fn((id: string) => id === 'hqharness-ui-profile'
        ? { textContent: JSON.stringify({ '--dsw-alias-bg-base': { light: '#ffffff', dark: '#0a0a0a' } }) }
        : null),
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
    const disposeTheme = vi.fn()
    const overrideTokens = vi.fn(() => disposeTheme)
    const disposers: Array<() => void> = []
    plugin.apply({ slots, theme: { overrideTokens }, effect: (setup: () => (() => void) | undefined) => {
      disposeStyle = setup()
      if (disposeStyle) disposers.push(disposeStyle)
    } })

    expect(plugin.inject).toEqual(['slots', 'remote.session', 'sessions', 'uiWorkspace', 'theme'])
    expect(overrideTokens).toHaveBeenCalledWith('dsh-desktop-client-ui', {
      '--dsw-alias-bg-base': { light: '#ffffff', dark: '#0a0a0a' }
    })
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
    disposers.forEach(dispose => dispose())
    expect(removeStyle).toHaveBeenCalledOnce()
    expect(disposeTheme).toHaveBeenCalledOnce()

    const sidebarName = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.name'
    )!.component({})
    expect(sidebarName).toBeNull()

    const sidebarMark = registrations.find(
      ({ config }) => config.name === 'sidebar.brand.mark'
    )!.component({ size: 24 }) as { type: unknown; props: Record<string, unknown> }
    expect(sidebarMark.type).toBe('img')
    expect(sidebarMark.props.height).toBe(24)
    expect(sidebarMark.props.src).toBe('/hqzyai-logomark.svg')
    expect(sidebarMark.props.alt).toBe('HQZY')
    expect(sidebarMark.props.draggable).toBe(false)
    expect(sidebarMark.props.style).toEqual({ objectFit: 'contain', flexShrink: 0, display: 'block' })

    const heroMark = registrations.find(
      ({ config }) => config.name === 'conversation.hero.brand.mark'
    )!.component({ size: 48 }) as { type: unknown; props: Record<string, unknown> }
    expect(heroMark.type).toBe('img')
    expect(heroMark.props.width).toBe(48)
    expect(heroMark.props.height).toBe(48)
    expect(heroMark.props.src).toBe(sidebarMark.props.src)
  })
})
