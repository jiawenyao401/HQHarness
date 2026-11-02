/* Local WPS JS Add-in. No model-supplied JavaScript is evaluated here. */
(() => {
  'use strict'
  window.HuaqingDesktopOnLoad = () => true
  // WPS may synthesize index.html. Its installed entry URL still identifies
  // the component and the private bridge path in that host mode.
  const page = new URL(typeof HQ_WPS_ADDIN_URL === 'string' ? HQ_WPS_ADDIN_URL : document.currentScript?.src || location.href)
  const match = /^\/(\w{64})\/addins\/(et|wps|wpp)\//.exec(page.pathname)
  if (!match || page.protocol !== 'http:' || page.hostname !== '127.0.0.1' || !window.HuaqingWpsAdapter) return
  const host = match[2]
  let adapter
  let socket
  let retry
  let stopped = false
  const factory = { et: 'EtApplication', wps: 'WpsApplication', wpp: 'WppApplication' }[host]
  function application() {
    try { if (window.wps && typeof window.wps[factory] === 'function') return window.wps[factory]() }
    catch { /* WPS may expose a component factory before that host is ready. */ }
    return window.Application || window.wps?.Application || window.wps
  }
  function send(value) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }
  function documents() {
    try { adapter ||= window.HuaqingWpsAdapter.create(application(), host); return adapter.documents() } catch { return [] }
  }
  function readbackDiagnostic(error) {
    if (!['READBACK_MISMATCH', 'WPS_READBACK_MISMATCH'].includes(error?.code)) return
    const input = error.diagnostic
    const fields = ['value', 'formula', 'numberFormat', 'hasFormula']
    const types = ['null', 'boolean', 'number', 'string']
    const keys = (value, names) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(name => Object.prototype.hasOwnProperty.call(value, name))
    if (!keys(input, ['phase', 'ordinal', 'mismatchFields', 'expectedTypes', 'observedTypes']) || !['cell', 'final'].includes(input.phase)
      || !Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal > 999
      || !Array.isArray(input.mismatchFields) || input.mismatchFields.length < 1 || input.mismatchFields.length > 4
      || new Set(input.mismatchFields).size !== input.mismatchFields.length || input.mismatchFields.some(field => !fields.includes(field))) return
    const frame = (value, expected) => {
      if (!keys(value, fields) || !(types.includes(value.value) || expected && value.value === 'not_checked')
        || !types.includes(value.formula) || value.numberFormat !== 'string' || value.hasFormula !== 'boolean') return
      return { value: value.value, formula: value.formula, numberFormat: value.numberFormat, hasFormula: value.hasFormula }
    }
    const expectedTypes = frame(input.expectedTypes, true)
    const observedTypes = frame(input.observedTypes, false)
    if (expectedTypes && observedTypes) return { phase: input.phase, ordinal: input.ordinal, mismatchFields: fields.filter(field => input.mismatchFields.includes(field)), expectedTypes, observedTypes }
  }
  function connect() {
    if (stopped) return
    try {
      socket = new WebSocket(`ws://${page.host}/${match[1]}/bridge/${host}`)
      socket.onopen = () => send({ type: 'hello', protocol: 1, host, documents: documents() })
      socket.onmessage = event => {
        let request
        try { request = JSON.parse(event.data) } catch { return }
        if (request.type !== 'execute' || typeof request.id !== 'string') return
        // A complete bounded operation runs synchronously in the WPS host.
        // There is no cancellation claim once WPS has started the operation.
        let result
        try { result = { ok: true, value: adapter.execute(request.operation) } }
        catch (error) {
          const known = ['STALE_SNAPSHOT', 'UNSUPPORTED', 'READ_ONLY', 'INVALID_INPUT', 'SNAPSHOT_SCOPE', 'DOCUMENT_CLOSED', 'CONFLICT', 'UNKNOWN_OUTCOME', 'PARTIAL_FAILURE', 'SAVE_FAILED', 'OUTPUT_TOO_LARGE', 'READBACK_MISMATCH', 'SAVE_UNVERIFIED']
          const code = /^WPS_[A-Z_]+$/.test(error?.code || '') ? error.code : known.includes(error?.code) ? `WPS_${error.code}` : 'WPS_OPERATION_FAILED'
          const diagnostic = readbackDiagnostic(error)
          result = { ok: false, code,
            outcome: ['not_executed', 'unknown', 'modified_unsaved'].includes(error?.outcome) ? error.outcome : 'unknown',
            ...(Number.isSafeInteger(error?.completed) && error.completed >= 0 && error.completed <= 1000 ? { completed: error.completed } : {}),
            ...(diagnostic ? { diagnostic } : {}) }
        }
        send({ type: 'result', id: request.id, result })
        send({ type: 'documents', documents: documents() })
      }
      socket.onclose = () => { if (!stopped) retry = setTimeout(connect, 1500) }
      socket.onerror = () => socket.close()
    } catch { retry = setTimeout(connect, 2000) }
  }
  window.HuaqingDesktopOnLoad = () => true
  window.addEventListener('unload', () => { stopped = true; clearTimeout(retry); socket?.close() })
  setInterval(() => send({ type: 'documents', documents: documents() }), 2000)
  connect()
})()
