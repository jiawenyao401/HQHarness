import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { build } from 'esbuild'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, expect, it } from 'vitest'
import { desktopThemeTokens } from '../scripts/ui-profile.mjs'

const root = path.resolve(import.meta.dirname, '..')
const profile = JSON.parse(await readFile(path.join(root, 'docs/shadcn-ui-unify/assets/neutral-theme.json'), 'utf8'))
const output = path.join(root, '.build/ui-standard-regression')
afterAll(async () => { await rm(output, { recursive:true, force:true }) })

it('maps both live palettes and restores the same contrast and type roles', () => {
  const tokens = desktopThemeTokens(profile)
  expect(tokens['--dsw-alias-bg-base']).toEqual({ light:profile.light.background, dark:profile.dark.background })
  expect(tokens['--dsw-alias-label-primary']).toEqual({ light:profile.light.foreground, dark:profile.dark.foreground })
  expect(tokens['--dsw-font-family']).toEqual({ light:profile.fontFamily, dark:profile.fontFamily })
  expect(tokens['--dsw-radius-md'].light).toBe(profile.radii.control)
  expect(tokens['--dsw-alias-state-error-primary'].dark).toBe(profile.dark.destructive)
  expect(Object.values(tokens).every(value => typeof value.light === 'string' && typeof value.dark === 'string')).toBe(true)
  expect(() => desktopThemeTokens({ id:'other', version:3 })).toThrow('Unsupported')
})

it('ships the original gradient SVG and complete local font resources with intact licenses', async () => {
  const staticRoot = path.join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
  const svg = await readFile(path.join(staticRoot, 'hqzyai-logomark.svg'))
  expect(createHash('sha256').update(svg).digest('hex')).toBe(profile.branding.favicon.sha256)
  const css = await readFile(path.join(staticRoot, 'hq-ui/fonts.css'), 'utf8')
  expect(css).not.toMatch(/url\(https?:/u)
  const files = [...css.matchAll(/url\(\.\/fonts\/([^()]+)\)/gu)].map(match => match[1])
  expect(files.length).toBeGreaterThan(100)
  for (const file of files) expect((await readFile(path.join(staticRoot, 'hq-ui/fonts', file))).length).toBeGreaterThan(0)
  for (const font of ['geist','geist-mono','noto-sans-sc']) expect(await readFile(path.join(staticRoot, `hq-ui/${font}-LICENSE.txt`), 'utf8')).toContain('SIL OPEN FONT LICENSE')
  const licenses = await readFile(path.join(staticRoot, 'THIRD_PARTY_LICENSES.txt'), 'utf8')
  expect(licenses).toContain('lucide-react')
  expect(licenses).toContain('ISC')
})

it('renders real Lucide SVGs at all sizes while preserving the SVG event and accessibility root', async () => {
  await mkdir(output, { recursive:true })
  // The complete primitives package is assembled by Harness's bootstrap, which
  // provides its shared dependencies. Exercise these installed wrapper bodies
  // directly here; the actual bootstrap is covered by the Electron UI smoke.
  const source = await readFile(path.join(root, 'node_modules/@deepseek-ai/dsh-client-ui-primitives/lib/index.js'), 'utf8')
  const imports = source.match(/^import \{[^\n]+\} from "lucide-react";/mu)?.[0]
  const helper = source.match(/function hqIcon\([\s\S]+?\n\}/u)?.[0]
  const names = ['IconSearchOutlineRegular', 'IconSearchOutlineMedium', 'IconArchiveCheckOutlineMedium', 'IconUnarchiveOutlineMedium', 'IconTreeCornerMedium']
  const wrappers = names.map(name => source.match(new RegExp(`const ${name} = [^\\n]+`))?.[0])
  if (!imports || !helper || wrappers.some(value => !value)) throw new Error('Installed icon adapter not found')
  const contents = `${imports}\nimport { createElement } from 'react';\n${helper}\n${wrappers.join('\n')}\nexport { ${names.join(', ')} };`
  const built = await build({ stdin: { contents, resolveDir:root }, bundle:true, platform:'node', format:'esm', write:false, external:['react','react/*'] })
  const file = path.join(output, 'icons.mjs')
  await writeFile(file, built.outputFiles[0].contents)
  const icons = await import(pathToFileURL(file).href)
  const click = () => undefined
  for (const size of [16,20,24]) {
    const icon = icons.IconSearchOutlineRegular({ size, className:'caller-class', onClick:click, 'aria-label':'Search' })
    expect(icon.props.onClick).toBe(click)
    expect(icon.props.className).toBe('caller-class')
    const html = renderToStaticMarkup(icon)
    expect(html).toContain(`width="${size}"`)
    expect(html).toContain('stroke-width="1.75"')
    expect(html).toContain('vector-effect="non-scaling-stroke"')
    expect(html).toContain('aria-label="Search"')
    expect(html).not.toContain('aria-hidden="true"')
  }
  const decorative = renderToStaticMarkup(React.createElement(icons.IconSearchOutlineMedium))
  expect(decorative).toContain('aria-hidden="true"')
  expect(decorative).toContain('lucide')
  expect(renderToStaticMarkup(React.createElement(icons.IconArchiveCheckOutlineMedium))).toContain('lucide-package-check')
  expect(renderToStaticMarkup(React.createElement(icons.IconUnarchiveOutlineMedium))).toContain('lucide-archive-restore')
  expect(renderToStaticMarkup(React.createElement(icons.IconTreeCornerMedium))).toContain('width="10"')
})
