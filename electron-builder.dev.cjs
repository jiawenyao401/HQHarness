const packageJson = require('./package.json')
const brand = require('./brand.config.json')

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
    dshDesktopChannel: 'development'
  },
  artifactName: 'hqharness-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'hqharness-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
