const packageJson = require('./package.json')
const brand = require('./brand.config.json')
const { lstatSync, readFileSync } = require('node:fs')
const { isAbsolute } = require('node:path')

const bailianTestKey = process.env.HQHARNESS_BAILIAN_TEST_KEY_FILE
if (bailianTestKey) {
  if (process.env.CI || !isAbsolute(bailianTestKey)) {
    throw new Error('The Bailian test credential requires a local development build and an absolute JSON path')
  }
  try {
    const stat = lstatSync(bailianTestKey)
    if (!stat.isFile() || stat.size > 4096) throw new Error()
    const data = JSON.parse(readFileSync(bailianTestKey, 'utf8'))
    if (Object.keys(data).length !== 1 || typeof data.apikey !== 'string' || !/^sk-[\x21-\x7e]{8,509}$/u.test(data.apikey.trim())) throw new Error()
  } catch {
    throw new Error('The Bailian test credential must be a regular JSON file with one apikey string')
  }
}

const artifactPrefix = bailianTestKey ? 'hqharness-bailian-internal' : 'hqharness-dev'

module.exports = {
  ...packageJson.build,
  appId: brand.developmentAppId,
  productName: brand.developmentProductName,
  executableName: 'HQHarness Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'hqharness-dev',
    productName: brand.developmentProductName,
    dshDesktopChannel: 'development',
    ...(bailianTestKey && { dshDesktopBailianTest: true })
  },
  artifactName: `${artifactPrefix}-\${os}-\${arch}.\${ext}`,
  ...(bailianTestKey && {
    extraResources: [...packageJson.build.extraResources, { from: bailianTestKey, to: 'bailian-test-key.json' }]
  }),
  nsis: {
    ...packageJson.build.nsis,
    artifactName: `${artifactPrefix}-windows-\${arch}-setup.\${ext}`
  },
  publish: null
}
