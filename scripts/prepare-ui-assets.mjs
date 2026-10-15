import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { desktopThemeTokens } from './ui-profile.mjs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Smartphone, RefreshCw } from 'lucide-react'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const destination = path.join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
const assetDir = path.join(destination, 'hq-ui')
const profile = JSON.parse(await readFile(path.join(root, 'docs/shadcn-ui-unify/assets/neutral-theme.json'), 'utf8'))
await mkdir(path.join(assetDir, 'fonts'), { recursive:true })
await mkdir(path.join(root, '.build/brand'), { recursive:true })
const chromeIcons = [['phoneIcon', Smartphone], ['updateIcon', RefreshCw]].map(([name, icon]) => {
  const svg = renderToStaticMarkup(createElement(icon, { size:20, strokeWidth:1.75, nonScalingStroke:true, 'aria-hidden':true, focusable:false }))
  return `export const ${name} = ${JSON.stringify(svg)}\n`
}).join('')
await writeFile(path.join(root, '.build/brand/ui-icons.ts'), '// Generated from the locked official lucide-react package; do not edit.\n' + chromeIcons)
const fonts = [['geist','Geist'], ['geist-mono','Geist Mono'], ['noto-sans-sc','Noto Sans SC']]
let css = ''
const sources = []
for (const [id, family] of fonts) {
  const packageRoot = path.join(root, 'node_modules/@fontsource-variable', id)
  const info = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'))
  let face = await readFile(path.join(packageRoot, 'index.css'), 'utf8')
  face = face.replaceAll(`${family} Variable`, family)
  const matches = [...face.matchAll(/url\(\.\/files\/([^()]+\.woff2)\)/gu)]
  for (const [, file] of matches) {
    const bytes = await readFile(path.join(packageRoot, 'files', file))
    await writeFile(path.join(assetDir, 'fonts', file), bytes)
    sources.push({ package:`@fontsource-variable/${id}`, version:info.version, file, sha256:createHash('sha256').update(bytes).digest('hex') })
  }
  face = face.replaceAll('url(./files/', 'url(./fonts/')
  css += face + '\n'
  await copyFile(path.join(packageRoot, 'LICENSE'), path.join(assetDir, `${id}-LICENSE.txt`))
}
css += `\n/* Application chrome only; editor/terminal/user content keeps its font contract. */
body { font-synthesis:none; }
body button, body input, body textarea, body select { font-family:var(--dsw-font-family); }
svg.lucide { flex-shrink:0; }
svg.lucide * { vector-effect:non-scaling-stroke; }
button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, [role=tab]:focus-visible, [role=menuitem]:focus-visible {
  outline:2px solid var(--dsw-alias-ui-focus-ring, currentColor); outline-offset:2px;
}
`
await writeFile(path.join(assetDir, 'fonts.css'), css)
await writeFile(path.join(assetDir, 'sources.json'), JSON.stringify({ profile:profile.id, version:profile.version, icons:profile.icons.profile, branding:profile.branding.profile, fonts:sources }, null, 2) + '\n')
const indexPath = path.join(destination, 'index.html')
let html = await readFile(indexPath, 'utf8')
html = html.replace(/\s*<link data-hq-ui-fonts[^>]*>/gu, '').replace(/\s*<script id="hqharness-ui-profile" type="application\/json">[\s\S]*?<\/script>/gu, '')
const tokens = JSON.stringify(desktopThemeTokens(profile)).replaceAll('<', '\\u003c')
const injection = `<link data-hq-ui-fonts rel="stylesheet" href="/hq-ui/fonts.css">\n<script id="hqharness-ui-profile" type="application/json">${tokens}</script>`
if (!html.includes('</head>')) throw new Error('Harness HTML head not found')
await writeFile(indexPath, html.replace('</head>', `${injection}\n</head>`))
console.log(`Prepared ${profile.id}, ${profile.icons.profile}, ${profile.branding.profile}; ${sources.length} self-hosted font shards`)
