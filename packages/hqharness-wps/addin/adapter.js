(function (root) {
  'use strict'

  const MAX_TEXT = 50000
  const MAX_CELLS = 1000
  const MAX_ITEMS = 200
  const MAX_SNAPSHOTS = 32
  const SNAPSHOT_TTL = 5 * 60 * 1000

  class WpsAdapterError extends Error {
    constructor(code, message, outcome, completed, diagnostic) {
      super(message)
      this.name = 'WpsAdapterError'
      this.code = code
      this.outcome = outcome || 'not_executed'
      if (completed !== undefined) this.completed = completed
      if (diagnostic !== undefined) this.diagnostic = diagnostic
    }
  }

  function fail(code, message) {
    throw new WpsAdapterError(code, message)
  }

  function text(value, limit) {
    if (typeof value !== 'string' || value.length > limit) fail('UNSUPPORTED', 'WPS returned an unsupported string value')
    return value
  }

  function flag(value) {
    if (value === true || value === -1 || value === 1) return true
    if (value === false || value === 0) return false
    fail('UNSUPPORTED', 'WPS did not provide a boolean state')
  }

  function count(collection, limit) {
    if (!collection || typeof collection.Item !== 'function') fail('UNSUPPORTED', 'WPS collection is unavailable')
    const value = collection.Count
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) fail('LIMIT_EXCEEDED', 'WPS collection exceeds the supported bounds')
    return value
  }

  function inputText(value, limit, empty) {
    if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > limit || value.includes('\0')) {
      fail('INVALID_OPERATION', 'Invalid text parameter')
    }
    return value
  }

  function snapshotId(value) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID_OPERATION', 'Invalid snapshot identifier')
    return value
  }

  function localPath(value) {
    return typeof value === 'string' && !/[\x00-\x1f]/.test(value)
      && ((value.startsWith('/') && !value.startsWith('//')) || /^[A-Za-z]:[\\/]/.test(value))
  }

  function scalar(value) {
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value
    if (typeof value === 'string' && value.length <= 32767) return value
    fail('UNSUPPORTED', 'WPS returned an unsupported cell value')
  }

  function positiveId(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail('UNSUPPORTED', 'WPS object identifier is unavailable')
    return value
  }

  function columnName(value) {
    let result = ''
    while (value > 0) {
      value -= 1
      result = String.fromCharCode(65 + value % 26) + result
      value = Math.floor(value / 26)
    }
    return result
  }

  function rectangle(value) {
    inputText(value, 40, false)
    const match = /^\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6})(?::\$?([A-Za-z]{1,3})\$?([1-9][0-9]{0,6}))?$/.exec(value)
    if (!match) fail('INVALID_OPERATION', 'A single rectangular A1 range is required')
    const col = (name) => name.toUpperCase().split('').reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
    const firstCol = col(match[1])
    const firstRow = Number(match[2])
    const lastCol = col(match[3] || match[1])
    const lastRow = Number(match[4] || match[2])
    const rows = lastRow - firstRow + 1
    const columns = lastCol - firstCol + 1
    if (rows < 1 || columns < 1 || lastCol > 16384 || lastRow > 1048576 || rows * columns > MAX_CELLS) {
      fail('LIMIT_EXCEEDED', 'Range must contain at most 1000 cells within worksheet bounds')
    }
    const address = columnName(firstCol) + firstRow + ':' + columnName(lastCol) + lastRow
    return { firstCol, firstRow, rows, columns, address }
  }

  /**
   * Synchronous WPS JS add-in boundary. Only documented, explicit object-model
   * members are called. Main owns authorization, backup, owner isolation and
   * freezing a document after an unknown outcome; this adapter never retries.
   *
   * Read: {action:'inspect'|'sheet_read', key, snapshot, sheet?, range?}.
   * Write: {action, key, snapshot, nextSnapshot, ...actionParameters}.
   * Snapshots cover the observed content, not a whole-document revision or Undo.
   */
  function create(app, host) {
    if (!app || !['et', 'wps', 'wpp'].includes(host)) fail('UNSUPPORTED', 'Unsupported WPS host')
    const byObject = new Map()
    const byKey = new Map()
    const snapshots = new Map()
    const latest = new Map()

    function forget(doc, key) {
      byObject.delete(doc)
      byKey.delete(key)
      invalidate(key)
    }

    function nativeIdentity(doc) {
      try {
        return { fullName: text(doc.FullName, 4096), name: text(doc.Name, 1024) }
      } catch (error) {
        const key = byObject.get(doc)
        if (key) forget(doc, key)
        throw error
      }
    }

    function identityKey(identity) {
      // Use raw native names, including unsaved FullName values. Projecting
      // non-local paths to '' would merge distinct documents.
      return JSON.stringify([identity.fullName, identity.name])
    }

    function entries() {
      const previous = new Map()
      for (const [doc, key] of byObject) {
        let identity
        try { identity = identityKey(nativeIdentity(doc)) } catch {
          // A closed native handle must never be replaced by a new proxy with
          // the same path. Discard its key and all observed snapshots.
          forget(doc, key)
          continue
        }
        const anchors = previous.get(identity) || []
        anchors.push({ doc, key })
        previous.set(identity, anchors)
      }
      const current = []
      const candidates = new Map()
      try {
        const collection = host === 'et' ? app.Workbooks : host === 'wps' ? app.Documents : app.Presentations
        const size = count(collection, MAX_ITEMS)
        for (let i = 1; i <= size; i += 1) {
          const doc = collection.Item(i)
          if (!doc || (typeof doc !== 'object' && typeof doc !== 'function')) fail('UNSUPPORTED', 'WPS document is unavailable')
          const identity = identityKey(nativeIdentity(doc))
          current.push({ doc, identity })
          candidates.set(identity, (candidates.get(identity) || 0) + 1)
        }
      } catch (error) {
        // Partial enumeration cannot establish that any old binding is still
        // present. A later successful listing must issue fresh keys.
        for (const [doc, key] of byObject) forget(doc, key)
        throw error
      }
      let ambiguous = false
      for (const size of candidates.values()) if (size !== 1) ambiguous = true
      for (const [identity, anchors] of previous) {
        const matches = candidates.get(identity) || 0
        if (matches !== 1 || anchors.length !== 1) {
          for (const { doc, key } of anchors) forget(doc, key)
          if (matches > 0 && anchors.length > 1) ambiguous = true
        }
      }
      if (ambiguous) fail('UNSUPPORTED', 'WPS document identity is not unique')
      // Item() may allocate a new JS wrapper every time. Retain the original,
      // still-valid native anchor as the actual operation target, not Active*.
      return current.map(({ doc, identity }) => previous.get(identity)?.[0].doc || doc)
    }

    function opaqueKey() {
      if (!root.crypto || typeof root.crypto.getRandomValues !== 'function') fail('UNSUPPORTED', 'Secure document identifiers are unavailable')
      const bytes = new Uint8Array(16)
      root.crypto.getRandomValues(bytes)
      return 'doc_' + Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
    }

    function metadata(doc, key) {
      const { fullName, name } = nativeIdentity(doc)
      return {
        key,
        name,
        path: localPath(fullName) ? fullName : '',
        type: host === 'et' ? 'spreadsheet' : host === 'wps' ? 'writer' : 'presentation',
        saved: flag(doc.Saved),
        readOnly: flag(doc.ReadOnly),
      }
    }

    function documents() {
      try {
        return boundedResult(entries().map((doc) => {
          let key = byObject.get(doc)
          if (!key) {
            key = opaqueKey()
            byObject.set(doc, key)
            byKey.set(key, doc)
          }
          return metadata(doc, key)
        }))
      } catch (error) {
        if (error instanceof WpsAdapterError) throw error
        throw new WpsAdapterError('WPS_READ_FAILED', 'Unable to enumerate WPS documents')
      }
    }

    function resolve(key) {
      inputText(key, 128, false)
      entries()
      const doc = byKey.get(key)
      if (!doc) fail('DOCUMENT_CLOSED', 'The bound WPS document is no longer open')
      return doc
    }

    function invalidate(key) {
      for (const [id, snapshot] of snapshots) {
        if (snapshot.key === key) snapshots.delete(id)
      }
      latest.delete(key)
    }

    function prune() {
      const cutoff = Date.now() - SNAPSHOT_TTL
      for (const [id, snapshot] of snapshots) {
        if (snapshot.created <= cutoff) snapshots.delete(id)
      }
    }

    function unusedId(id) {
      snapshotId(id)
      prune()
      if (snapshots.has(id)) fail('INVALID_OPERATION', 'Snapshot identifier has already been used')
    }

    function remember(id, doc, key, scope, observed) {
      while (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value)
      snapshots.set(id, { doc, key, scope, observed, meta: metadata(doc, key), created: Date.now() })
      latest.set(key, id)
      return id
    }

    function sheetMetadata(doc) {
      const size = count(doc.Worksheets, MAX_ITEMS)
      const worksheets = []
      for (let i = 1; i <= size; i += 1) worksheets.push({ index: i, name: text(doc.Worksheets.Item(i).Name, 1024) })
      return { worksheets, truncated: false }
    }

    function writer(doc) {
      const content = doc.Content
      const body = content.Text
      if (typeof body !== 'string') fail('UNSUPPORTED', 'Writer body text is unavailable')
      if (!Number.isSafeInteger(content.Start) || content.Start < 0) fail('UNSUPPORTED', 'Writer body position is unavailable')
      return { text: body.slice(0, MAX_TEXT), length: body.length, start: content.Start, truncated: body.length > MAX_TEXT }
    }

    function slides(doc) {
      const items = []
      const size = count(doc.Slides, 10000)
      let remaining = MAX_TEXT
      for (let i = 1; i <= size; i += 1) {
        const slide = doc.Slides.Item(i)
        const slideId = positiveId(slide.SlideID)
        const shapeCount = count(slide.Shapes, 10000)
        for (let j = 1; j <= shapeCount; j += 1) {
          const shape = slide.Shapes.Item(j)
          if (!flag(shape.HasTextFrame)) continue
          if (items.length >= MAX_ITEMS || remaining === 0) return { items, truncated: true }
          const value = shape.TextFrame.TextRange.Text
          if (typeof value !== 'string') fail('UNSUPPORTED', 'Presentation text is unavailable')
          const preview = value.slice(0, remaining)
          items.push({ slideId, shapeId: positiveId(shape.Id), text: preview, truncated: value.length > remaining })
          remaining -= preview.length
        }
      }
      return { items, truncated: items.some((item) => item.truncated) }
    }

    function readCell(cell) {
      return {
        value: scalar(cell.Value2),
        formula: scalar(cell.Formula),
        numberFormat: text(cell.NumberFormat, 1024),
        hasFormula: flag(cell.HasFormula),
      }
    }

    function sheetDiagnostic(after, target, formulas, phase) {
      const expectedFormula = target.value === null ? '' : target.value
      const mismatchFields = []
      if (!formulas && after.value !== target.value) mismatchFields.push('value')
      if (after.formula !== expectedFormula) mismatchFields.push('formula')
      if (after.numberFormat !== target.expectedFormat) mismatchFields.push('numberFormat')
      if (after.hasFormula !== formulas) mismatchFields.push('hasFormula')
      const scalarType = (value) => value === null ? 'null' : typeof value
      // Fixed field names and type enums only. Never include cell contents,
      // formulas, format strings, addresses, names or native exception text.
      return {
        phase,
        ordinal: target.ordinal,
        mismatchFields,
        expectedTypes: {
          value: formulas ? 'not_checked' : scalarType(target.value),
          formula: scalarType(expectedFormula),
          numberFormat: 'string',
          hasFormula: 'boolean',
        },
        observedTypes: {
          value: scalarType(after.value),
          formula: scalarType(after.formula),
          numberFormat: 'string',
          hasFormula: 'boolean',
        },
      }
    }

    function sheetRange(doc, scope) {
      const sheet = doc.Worksheets.Item(scope.sheet)
      if (!sheet || sheet.Name !== scope.sheet || typeof sheet.Range !== 'function') fail('SHEET_CHANGED', 'The observed worksheet is unavailable')
      const cells = []
      let serializedLength = 0
      for (let row = 0; row < scope.rect.rows; row += 1) {
        for (let col = 0; col < scope.rect.columns; col += 1) {
          const address = columnName(scope.rect.firstCol + col) + (scope.rect.firstRow + row)
          const value = readCell(sheet.Range(address))
          serializedLength += JSON.stringify(value).length
          if (serializedLength > 120000) fail('LIMIT_EXCEEDED', 'Observed cell data exceeds the message size limit; read a smaller range')
          cells.push(value)
        }
      }
      return { cells }
    }

    function observe(doc, scope) {
      if (scope.kind === 'writer') return writer(doc)
      if (scope.kind === 'slides') return slides(doc)
      if (scope.kind === 'sheet_range') return sheetRange(doc, scope)
      return sheetMetadata(doc)
    }

    function present(scope, observed) {
      if (scope.kind !== 'sheet_range') return JSON.parse(JSON.stringify(observed))
      const values = []
      const formulas = []
      const numberFormats = []
      const hasFormulas = []
      for (let row = 0; row < scope.rect.rows; row += 1) {
        const offset = row * scope.rect.columns
        const cells = observed.cells.slice(offset, offset + scope.rect.columns)
        values.push(cells.map((cell) => cell.value))
        formulas.push(cells.map((cell) => cell.formula))
        numberFormats.push(cells.map((cell) => cell.numberFormat))
        hasFormulas.push(cells.map((cell) => cell.hasFormula))
      }
      return { sheet: scope.sheet, range: scope.rect.address, values, formulas, numberFormats, hasFormulas, truncated: false }
    }

    function checkedSnapshot(operation, doc) {
      if (resolve(operation.key) !== doc) fail('DOCUMENT_CLOSED', 'The bound WPS document is no longer open')
      snapshotId(operation.snapshot)
      prune()
      const snapshot = snapshots.get(operation.snapshot)
      if (!snapshot || snapshot.doc !== doc || snapshot.key !== operation.key || latest.get(operation.key) !== operation.snapshot) {
        fail('STALE_SNAPSHOT', 'Read the bound document again before modifying it')
      }
      const currentMeta = metadata(doc, operation.key)
      if (JSON.stringify(snapshot.meta) !== JSON.stringify(currentMeta)
        || JSON.stringify(snapshot.observed) !== JSON.stringify(observe(doc, snapshot.scope))) {
        invalidate(operation.key)
        fail('STALE_SNAPSHOT', 'The observed document state has changed')
      }
      if (currentMeta.readOnly) fail('READ_ONLY', 'The bound document is read-only')
      unusedId(operation.nextSnapshot)
      if (operation.nextSnapshot === operation.snapshot) fail('INVALID_OPERATION', 'A new snapshot identifier is required')
      return snapshot
    }

    function boundedResult(result) {
      // Three UTF-8 bytes per UTF-16 code unit is a conservative bound, including
      // surrogate pairs. Leave room for the bridge envelope under 512 KiB.
      if (JSON.stringify(result).length > 160000) fail('LIMIT_EXCEEDED', 'WPS result exceeds the supported message size')
      return result
    }

    function matrix(value, rect, formulas) {
      if (!Array.isArray(value) || value.length !== rect.rows) fail('INVALID_OPERATION', 'Matrix dimensions do not match the observed range')
      return value.map((row) => {
        if (!Array.isArray(row) || row.length !== rect.columns) fail('INVALID_OPERATION', 'Matrix dimensions do not match the observed range')
        return row.map((item) => {
          if (formulas) {
            inputText(item, 8192, false)
            if (!item.startsWith('=')) fail('INVALID_OPERATION', 'Explicit formulas must start with an equals sign')
          } else {
            if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) return item
            inputText(item, 32767, true)
          }
          return item
        })
      })
    }

    function findTextShape(doc, slideId, shapeId) {
      const size = count(doc.Slides, 10000)
      for (let i = 1; i <= size; i += 1) {
        const slide = doc.Slides.Item(i)
        if (slide.SlideID !== slideId) continue
        const shapeCount = count(slide.Shapes, 10000)
        for (let j = 1; j <= shapeCount; j += 1) {
          const shape = slide.Shapes.Item(j)
          if (shape.Id === shapeId && flag(shape.HasTextFrame)) return shape.TextFrame.TextRange
        }
      }
      fail('STALE_SNAPSHOT', 'The observed presentation shape is no longer available')
    }

    function execute(operation) {
      let attempted = false
      let completed = 0
      let key
      try {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) fail('INVALID_OPERATION', 'An operation object is required')
        key = operation.key
        const doc = resolve(key)
        if (operation.action === 'inspect' || operation.action === 'sheet_read') {
          unusedId(operation.snapshot)
          let scope
          if (operation.action === 'sheet_read') {
            if (host !== 'et') fail('UNSUPPORTED', 'Sheet operations require the spreadsheet host')
            scope = { kind: 'sheet_range', sheet: inputText(operation.sheet, 1024, false), rect: rectangle(operation.range) }
          } else {
            scope = { kind: host === 'wps' ? 'writer' : host === 'wpp' ? 'slides' : 'sheet_metadata' }
          }
          const observed = observe(doc, scope)
          const result = boundedResult({ key, snapshot: operation.snapshot, ...present(scope, observed) })
          remember(operation.snapshot, doc, key, scope, observed)
          return result
        }
        if (!['sheet_write', 'writer_replace', 'slide_text', 'save'].includes(operation.action)) fail('INVALID_OPERATION', 'Unknown WPS operation')
        const snapshot = checkedSnapshot(operation, doc)
        let mutate
        if (operation.action === 'sheet_write') {
          if (host !== 'et' || snapshot.scope.kind !== 'sheet_range') fail('SNAPSHOT_SCOPE', 'Read the exact spreadsheet range before writing')
          const requested = rectangle(operation.range)
          if (operation.sheet !== snapshot.scope.sheet || requested.address !== snapshot.scope.rect.address) fail('SNAPSHOT_SCOPE', 'Write range does not match the snapshot')
          const useFormulas = operation.formulas !== undefined
          if (useFormulas === (operation.values !== undefined)) fail('INVALID_OPERATION', 'Provide either values or formulas')
          const data = matrix(useFormulas ? operation.formulas : operation.values, requested, useFormulas)
          const sheet = doc.Worksheets.Item(snapshot.scope.sheet)
          const targets = []
          for (let row = 0; row < requested.rows; row += 1) {
            for (let col = 0; col < requested.columns; col += 1) {
              const address = columnName(requested.firstCol + col) + (requested.firstRow + row)
              const cell = sheet.Range(address)
              // A merged cell or unsupported scalar API must fail before any write.
              if (flag(cell.MergeCells)) fail('UNSUPPORTED', 'Merged-cell writes are not supported')
              const value = data[row][col]
              const ordinal = targets.length
              const before = snapshot.observed.cells[ordinal]
              const expectedFormat = !useFormulas && typeof value === 'string' && /^[\s\uFEFF]*[=+\-@]/.test(value) ? '@' : before.numberFormat
              targets.push({ cell, value, expectedFormat, ordinal })
            }
          }
          const verified = (after, target) => after.numberFormat === target.expectedFormat && (useFormulas
            ? after.formula === target.value && after.hasFormula
            : after.value === target.value && !after.hasFormula && after.formula === (target.value === null ? '' : target.value))
          mutate = () => {
            for (const target of targets) {
              attempted = true
              if (useFormulas) {
                target.cell.Formula = target.value
              } else if (typeof target.value === 'string') {
                // Formula-looking strings stay explicitly formatted as text.
                // Ordinary strings retain their prior display format.
                target.cell.NumberFormat = '@'
                target.cell.Value2 = target.value
                if (target.expectedFormat !== '@') target.cell.NumberFormat = target.expectedFormat
              } else {
                target.cell.Value2 = target.value
              }
              const after = readCell(target.cell)
              if (!verified(after, target)) {
                throw new WpsAdapterError('READBACK_MISMATCH', 'Spreadsheet write could not be verified', 'unknown', completed,
                  sheetDiagnostic(after, target, useFormulas, 'cell'))
              }
              completed += 1
            }
            // Recalculation or native callbacks from a later setter may have
            // changed an earlier cell. Verify the final matrix as well.
            for (const target of targets) {
              const after = readCell(target.cell)
              if (!verified(after, target)) {
                throw new WpsAdapterError('READBACK_MISMATCH', 'Final spreadsheet range could not be verified', 'unknown', completed,
                  sheetDiagnostic(after, target, useFormulas, 'final'))
              }
            }
          }
        } else if (operation.action === 'writer_replace') {
          if (host !== 'wps' || snapshot.scope.kind !== 'writer') fail('SNAPSHOT_SCOPE', 'Inspect the Writer document before replacing text')
          if (snapshot.observed.truncated) fail('UNSUPPORTED', 'Writer replacement requires the complete bounded body')
          const oldText = inputText(operation.oldText, MAX_TEXT, false)
          const replacement = inputText(operation.replaceText, MAX_TEXT, true)
          const body = snapshot.observed.text
          const index = body.indexOf(oldText)
          if (index < 0 || body.indexOf(oldText, index + 1) !== -1) fail('AMBIGUOUS_TEXT', 'The exact text must occur once in the observed body')
          const expected = body.slice(0, index) + replacement + body.slice(index + oldText.length)
          if (expected.length > MAX_TEXT) fail('LIMIT_EXCEEDED', 'Replacement exceeds the supported Writer body size')
          const range = doc.Range(snapshot.observed.start + index, snapshot.observed.start + index + oldText.length)
          if (range.Text !== oldText) fail('UNSUPPORTED', 'Writer range positions could not be verified')
          mutate = () => {
            attempted = true
            range.Text = replacement
            const after = writer(doc)
            if (after.truncated || after.text !== expected) throw new WpsAdapterError('READBACK_MISMATCH', 'Writer replacement could not be verified', 'unknown', 0)
            completed = 1
          }
        } else if (operation.action === 'slide_text') {
          if (host !== 'wpp' || snapshot.scope.kind !== 'slides') fail('SNAPSHOT_SCOPE', 'Inspect the presentation before replacing text')
          const value = inputText(operation.text, MAX_TEXT, true)
          const item = snapshot.observed.items.find((entry) => entry.slideId === operation.slideId && entry.shapeId === operation.shapeId)
          if (!item || item.truncated) fail('SNAPSHOT_SCOPE', 'Read the complete target shape before replacing text')
          const range = findTextShape(doc, item.slideId, item.shapeId)
          if (range.Text !== item.text) fail('STALE_SNAPSHOT', 'The observed presentation text has changed')
          mutate = () => {
            attempted = true
            range.Text = value
            if (range.Text !== value) throw new WpsAdapterError('READBACK_MISMATCH', 'Presentation write could not be verified', 'unknown', 0)
            completed = 1
          }
        } else {
          if (snapshot.scope.kind === 'sheet_metadata') fail('SNAPSHOT_SCOPE', 'Read spreadsheet content before saving')
          if (!localPath(operation.expectedPath) || doc.FullName !== operation.expectedPath || snapshot.meta.path !== operation.expectedPath) {
            fail('PATH_CHANGED', 'Save requires the unchanged absolute local file path')
          }
          if (typeof doc.Save !== 'function') fail('UNSUPPORTED', 'WPS save API is unavailable')
          mutate = () => {
            attempted = true
            doc.Save()
            if (doc.FullName !== operation.expectedPath || !flag(doc.Saved)) throw new WpsAdapterError('SAVE_UNVERIFIED', 'WPS save could not be verified', 'unknown', 0)
            completed = 1
          }
        }
        // Recheck all observed old values immediately before the first setter.
        checkedSnapshot(operation, doc)
        invalidate(key)
        mutate()
        resolve(key)
        const observed = observe(doc, snapshot.scope)
        if (operation.action === 'save' && JSON.stringify(observed) !== JSON.stringify(snapshot.observed)) {
          throw new WpsAdapterError('SAVE_UNVERIFIED', 'Observed content changed during WPS save', 'unknown', completed)
        }
        remember(operation.nextSnapshot, doc, key, snapshot.scope, observed)
        const result = { key, snapshot: operation.nextSnapshot, completed, ...present(snapshot.scope, observed) }
        if (operation.action === 'save') {
          result.saved = true
          result.coverage = 'observed_content_only'
        } else {
          result.outcome = 'modified_unsaved'
        }
        return boundedResult(result)
      } catch (error) {
        if (attempted && key) invalidate(key)
        if (error instanceof WpsAdapterError) {
          if (attempted && error.outcome === 'not_executed') {
            throw new WpsAdapterError(error.code, error.message, 'unknown', completed)
          }
          throw error
        }
        // Native exception messages can contain document text or paths. Return
        // only the operation phase; the host must freeze unknown write outcomes.
        throw new WpsAdapterError(attempted ? 'WPS_WRITE_FAILED' : 'WPS_READ_FAILED',
          attempted ? 'WPS operation failed after a write was attempted' : 'Unable to read the required WPS state',
          attempted ? 'unknown' : 'not_executed', completed)
      }
    }

    return { documents, execute }
  }

  root.HuaqingWpsAdapter = Object.freeze({ create })
})(globalThis)
