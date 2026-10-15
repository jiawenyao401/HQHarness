// Same published Harness boot kernel and shared React/primitives as upstream.
// Rebuilding this thin entry is necessary: the npm frontend ships frozen seeds,
// so patching ui-primitives alone cannot change what the browser executes.
import { AppWebEntry, applyIndexInjections } from '@deepseek-ai/dsh-client-web'

const desktopBoot = globalThis.dshDesktopBoot
const failed = error => {
  if (!desktopBoot) throw error
  desktopBoot.failed(error instanceof Error ? error.message : String(error)).catch(console.error)
}
try {
  const root = document.getElementById('root')
  if (!root) throw new Error('web app: missing #root')
  const app = new AppWebEntry(root)
  if (desktopBoot) {
    const ready = globalThis.__DSH_BOOT_READY__
    if (!ready) throw new Error('desktop web: boot readiness is missing')
    desktopBoot.ready().then(async ({ injections, streamBaseUrl }) => {
      globalThis.__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl }
      await applyIndexInjections(injections, src => new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = resolve
        script.onerror = () => reject(new Error(`desktop web: failed to load ${src}`))
        document.head.append(script)
      }))
      ready.resolve()
    }).catch(error => ready.reject(error))
  }
  void app.run(desktopBoot ? failed : undefined)
} catch (error) {
  failed(error)
}
