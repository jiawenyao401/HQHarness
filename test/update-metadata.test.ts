import { describe, expect, it } from 'vitest'
import { validateUpdateMetadataOrigin } from '../src/main/update/update-metadata'

const base = 'https://updates.hqharness.test/root/'
const feed = `${base}archive/0.9.0/`
describe('update metadata download origins', () => {
  it('accepts relative and absolute payloads on the configured update origin', () => {
    expect(() => validateUpdateMetadataOrigin({ files: [{ url: 'hqharness.exe' }, { url: `${base}hqharness.zip` }], path: 'hqharness.exe', packages: { x64: { path: 'hqharness.7z' } } }, feed, base)).not.toThrow()
  })
  it.each(['https://another.test/payload.exe', '//another.test/payload.exe', 'http://updates.hqharness.test/payload.exe', 'https://user:pass@updates.hqharness.test/payload.exe', 'file:///payload.exe'])('rejects %s in every downloadable metadata field', url => {
    for (const info of [{ files: [{ url }] }, { path: url }, { files: [{ url: 'hqharness.exe' }], path: url }, { files: [{ url: 'hqharness.exe' }], packages: { x64: { path: url } } }]) {
      expect(() => validateUpdateMetadataOrigin(info, feed, base)).toThrow()
    }
  })
  it('rejects an unconfigured feed origin and metadata without downloadable files', () => {
    expect(() => validateUpdateMetadataOrigin({ path: 'hqharness.exe' }, 'https://another.test/archive/', base)).toThrow()
    expect(() => validateUpdateMetadataOrigin({ files: [] }, feed, base)).toThrow()
  })
})
