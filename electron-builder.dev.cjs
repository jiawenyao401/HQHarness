const packageJson = require('./package.json')

module.exports = {
  ...packageJson.build,
  appId: 'app.hqharness.desktop.dev',
  productName: 'HQHarness Dev',
  directories: {
    ...packageJson.build.directories,
    output: 'dist-dev'
  },
  extraMetadata: {
    name: 'hqharness-dev',
    productName: 'HQHarness Dev',
    dshDesktopChannel: 'development'
  },
  artifactName: 'hqharness-dev-${os}-${arch}.${ext}',
  nsis: {
    ...packageJson.build.nsis,
    artifactName: 'hqharness-dev-windows-${arch}-setup.${ext}'
  },
  publish: null
}
