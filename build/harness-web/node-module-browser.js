// Same explicit Node-only boundary as the published Harness frontend.
export function createRequire() {
  throw new Error('node:module is not available in the browser')
}
