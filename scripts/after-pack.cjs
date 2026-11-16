const path = require('node:path')
const verifyPackagedPptRuntime = require('./verify-packaged-ppt-runtime.cjs')
const { afterPack: verifyOfficeRuntime } = require('./verify-office-runtime.cjs')
const { verifyAsarUnpack } = require('./verify-asar-unpack.cjs')
const verifyPackagedWps = require('./verify-packaged-wps.cjs')
const verifyPackagedHuaqingCli = require('./verify-packaged-huaqing-cli.cjs')

/** electron-builder afterPack: package-content gates run before signing. */
module.exports = async function afterPack(context) {
  const product = context.packager.appInfo.productFilename
  const mac = context.electronPlatformName === 'darwin' || context.electronPlatformName === 'mas'
  const contents = path.join(context.appOutDir, `${product}.app`, 'Contents')
  const resourcesDir = mac ? path.join(contents, 'Resources') : path.join(context.appOutDir, 'resources')
  const { macHelperExecutable } = await import('../build/macos-helper-executable.mjs')
  const executable = mac
    ? macHelperExecutable(path.join(contents, 'MacOS', product))
    : path.join(context.appOutDir, `${product}.exe`)
  verifyAsarUnpack(resourcesDir)
  await verifyPackagedWps(context)
  await verifyPackagedPptRuntime(context)
  await verifyOfficeRuntime(context)
  await verifyPackagedHuaqingCli(resourcesDir, executable)
}
