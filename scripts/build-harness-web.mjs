import { build } from 'vite'
import { cp, lstat, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packages = ['dsh-client-web', 'dsh-client-ui-primitives', 'dsh-client-store', 'dsh-client-ui-slots', 'dsh-client-ui-dockkit', 'dsh-web-frontend']
const versions = {}
for (const name of packages) {
  const info = JSON.parse(await readFile(path.join(root, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8'))
  if (info.version !== '0.2.0-rc.2') throw new Error(`Requalify the HQHarness Web build for ${name}@${info.version}`)
  versions[name] = info.version
}
const output = path.join(root, '.build/harness-web')
await build({
  configFile:false,
  root:path.join(root, 'build/harness-web'),
  publicDir:path.join(root, 'docs/shadcn-ui-unify/assets/branding'),
  base:'./',
  resolve:{ alias:{ 'node:module':path.join(root, 'build/harness-web/node-module-browser.js') } },
  define:{ 'process.env.CORDIS_SHARED':'undefined', 'process.versions.node':'"0.0.0"', 'process.execArgv':'[]' },
  build:{ outDir:output, emptyOutDir:true, target:'es2022', sourcemap:false, license:{ fileName:'THIRD_PARTY_LICENSES.txt' } }
})
const manifest = {
  name:'HQHarness', short_name:'HQHarness', description:'Local-first AI agent workspace',
  theme_color:'#ffffff', background_color:'#ffffff', display:'standalone', start_url:'.',
  icons:[{ src:'/hqzyai-logomark.svg', sizes:'any', type:'image/svg+xml' }]
}
await writeFile(path.join(output, 'manifest.webmanifest'), JSON.stringify(manifest, null, 2) + '\n')
await writeFile(path.join(output, 'hqharness-web-build.json'), JSON.stringify({
  upstream:versions, entry:'build/harness-web/entry.js', profile:'shadcn-neutral-v3',
  icons:'lucide-outline-v1', lucide:JSON.parse(await readFile(path.join(root, 'node_modules/lucide-react/package.json'), 'utf8')).version
}, null, 2) + '\n')
const destination = path.join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
if ((await lstat(destination)).isSymbolicLink()) throw new Error('Refusing to replace a symlinked Harness frontend dist')
// Publish only after the staged build succeeds. This is the disposable npm
// distribution directory; retained application profiles never live here.
await rm(destination, { recursive:true })
await cp(output, destination, { recursive:true })
console.log('Rebuilt the pinned Harness Web shell with the current shared UI source')
