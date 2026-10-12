import sharp from 'sharp'
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateBrandConfig } from '../src/shared/brand-config.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const output = path.join(root, '.build', 'brand')
const brand = JSON.parse(await readFile(path.join(root, 'brand.config.json'), 'utf8'))
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
validateBrandConfig(brand, packageJson)
const artwork = await readFile(path.join(root, 'build', 'brand-mark.svg'), 'utf8')
const mark = /<path[^>]*\sd="([^"]+)"/u.exec(artwork)?.[1]
if (!mark) throw new Error('HQHarness brand mark must contain a path')
await mkdir(output, { recursive: true })
await writeFile(path.join(output, 'installer-brand.nsh'), [
  `!if "\${APP_ID}" == "${brand.appId}"`,
  `  !define HQHARNESS_USER_DATA "${brand.userDataDirectory}"`,
  `!else if "\${APP_ID}" == "${brand.developmentAppId}"`,
  `  !define HQHARNESS_USER_DATA "${brand.developmentUserDataDirectory}"`,
  '!else',
  '  !error "Unsupported HQHarness application identity"',
  '!endif',
  ''
].join('\n'))
for (const name of await readdir(path.join(root, 'build'))) {
  if (name.endsWith('.html')) await copyFile(path.join(root, 'build', name), path.join(output, name))
}

// All platform assets share a single vector source and build configuration.
function svg(color, opacity = 1, offset = 0) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000"><g transform="translate(0 ${offset})" opacity="${opacity}"><path d="${mark}" fill-rule="evenodd" fill="${color}"/></g></svg>`)
}

const appSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1000 1000"><rect x="32" y="32" width="936" height="936" rx="208" fill="${brand.colors.ink}"/><path d="${mark}" fill-rule="evenodd" fill="#F0FDFA"/><path d="M705 605 765 565 890 730 830 775Z" fill="${brand.colors.accent}"/></svg>`)
const appPng = await sharp(appSvg).png().toBuffer()
await writeFile(path.join(output, 'app-icon.png'), appPng)
await writeFile(path.join(output, 'icon.png'), appPng)
for (const [theme, color] of [['light', brand.colors.ink], ['dark', '#F0FDFA']]) {
  await sharp(svg(color)).png().toFile(path.join(output, `logo-${theme}.png`))
}

// PNG-backed ICO and ICNS work on every host without platform converters.
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map(size => sharp(appPng).resize(size, size).png().toBuffer()))
const header = Buffer.alloc(6 + images.length * 16)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = header.length
for (const [index, bytes] of images.entries()) {
  const entry = 6 + index * 16
  header[entry] = sizes[index] === 256 ? 0 : sizes[index]
  header[entry + 1] = header[entry]
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(bytes.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += bytes.length
}
await writeFile(path.join(output, 'icon.ico'), Buffer.concat([header, ...images]))

const chunks = []
for (const [kind, size] of [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]]) {
  const bytes = await sharp(appPng).resize(size, size).png().toBuffer()
  const chunk = Buffer.alloc(8)
  chunk.write(kind, 0, 4, 'ascii')
  chunk.writeUInt32BE(8 + bytes.length, 4)
  chunks.push(chunk, bytes)
}
const icns = Buffer.alloc(8)
icns.write('icns', 0, 4, 'ascii')
icns.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4)
await writeFile(path.join(output, 'icon.icns'), Buffer.concat([icns, ...chunks]))

const width = 640
const height = 360
const frameCount = 24
for (const [theme, color] of [['light', brand.colors.ink], ['dark', '#F0FDFA']]) {
  const frames = []
  for (let frame = 0; frame < frameCount; frame += 1) {
    const phase = frame * Math.PI * 2 / frameCount
    const bytes = await sharp(svg(color, 0.88 + Math.sin(phase) * 0.12, Math.sin(phase) * 8))
      .resize(320, 320).extend({ top: 20, bottom: 20, left: 160, right: 160, background: '#00000000' })
      .ensureAlpha().raw().toBuffer()
    frames.push(bytes)
  }
  await sharp(Buffer.concat(frames), {
    raw: { width, height: height * frameCount, channels: 4, pageHeight: height }
  }).gif({ delay: Array(frameCount).fill(80), loop: 0, effort: 7 }).toFile(path.join(output, theme === 'light' ? 'dsh-loader.gif' : 'dsh-loader-dark.gif'))
}
console.log('Prepared HQHarness brand assets in .build/brand')
