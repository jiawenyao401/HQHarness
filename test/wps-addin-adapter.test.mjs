import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { describe, expect, it } from 'vitest'

const source = readFileSync(path.resolve('packages/hqharness-wps/addin/adapter.js'), 'utf8')

function collection(items) {
  return {
    get Count() { return items.length },
    Item(index) {
      const result = typeof index === 'string' ? items.find((item) => item.Name === index) : items[index - 1]
      if (!result) throw new Error('Native exception containing private document content')
      return result
    },
  }
}

/** Each enumeration returns a new wrapper around the same native handle. */
function nativeWrappers(items) {
  const closed = new WeakSet()
  const accesses = []
  let nextId = 0
  return {
    accesses,
    close(doc) { closed.add(doc) },
    collection: {
      get Count() { return items.length },
      Item(index) {
        const native = items[index - 1]
        const id = ++nextId
        return new Proxy(native, {
          get(target, property) {
            if (closed.has(target)) throw new Error('Closed native handle with private document content')
            accesses.push({ id, property })
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? (...args) => value.apply(target, args) : value
          },
          set(target, property, value) {
            if (closed.has(target)) throw new Error('Closed native handle with private document content')
            return Reflect.set(target, property, value, target)
          },
        })
      },
    },
  }
}

function runtime(app, host) {
  let time = 1000
  const context = vm.createContext({ crypto: webcrypto, Date: { now: () => time } })
  vm.runInContext(source, context)
  const adapter = context.HuaqingWpsAdapter.create(app, host)
  return { adapter, advance: (ms) => { time += ms } }
}

function errorFrom(run) {
  try { run() } catch (error) { return error }
  throw new Error('Expected an adapter error')
}

function base(name = 'sample', fullName = '/tmp/sample.docx') {
  return {
    Name: name,
    FullName: fullName,
    Saved: true,
    ReadOnly: false,
    saves: 0,
    Save() { this.saves += 1; this.Saved = true },
  }
}

function writer(body = 'alpha target omega\r', name = 'sample.docx') {
  const doc = base(name, '/tmp/' + name)
  let value = body
  doc.writes = 0
  doc.Content = { Start: 0, get End() { return value.length }, get Text() { return value } }
  doc.change = (next) => { value = next; doc.Saved = false }
  doc.Range = (start, end) => ({
    Start: start, End: end,
    get Text() { return value.slice(start, end) },
    set Text(replacement) {
      doc.writes += 1
      if (doc.failWrite) throw new Error('private content must never appear in the error')
      if (doc.ignoreWrite) return
      value = value.slice(0, start) + replacement + value.slice(end)
      doc.Saved = false
    },
  })
  return doc
}

function spreadsheet(initial = { A1: 1, B1: 2 }) {
  const doc = base('book.xlsx', 'C:\\work\\book.xlsx')
  const writes = []
  const cells = new Map()
  const makeCell = (address) => {
    let value = initial[address] ?? null
    let formula = value === null ? '' : value
    let numberFormat = 'General'
    let hasFormula = false
    const cell = {
      MergeCells: false,
      get Value2() { return value },
      set Value2(next) {
        writes.push({ address, property: 'Value2', value: next })
        if (doc.failAt === address) throw new Error('private cell content')
        if (doc.ignoreAt === address) return
        hasFormula = typeof next === 'string' && next.startsWith('=') && numberFormat !== '@'
        value = hasFormula ? 99 : next
        formula = next === null ? '' : next
        doc.Saved = false
        if (doc.afterValueWrite) doc.afterValueWrite(address, next)
      },
      get Formula() { return formula },
      set Formula(next) {
        writes.push({ address, property: 'Formula', value: next })
        if (doc.failAt === address) throw new Error('private formula')
        formula = next
        value = 99
        hasFormula = true
        doc.Saved = false
      },
      get NumberFormat() { return numberFormat },
      set NumberFormat(next) {
        writes.push({ address, property: 'NumberFormat', value: next })
        numberFormat = next
        doc.Saved = false
      },
      get HasFormula() { return hasFormula },
      externalChange(next, nextFormula = next, nextFormat = numberFormat) {
        value = next
        formula = nextFormula
        numberFormat = nextFormat
        hasFormula = typeof nextFormula === 'string' && nextFormula.startsWith('=')
        doc.Saved = false
      },
    }
    return cell
  }
  const sheet = {
    Name: 'Data',
    Range(address) {
      if (!cells.has(address)) cells.set(address, makeCell(address))
      return cells.get(address)
    },
  }
  doc.Worksheets = collection([sheet])
  return { doc, sheet, writes }
}

function presentation() {
  const doc = base('deck.pptx', '/tmp/deck.pptx')
  const shape = (id, value) => {
    const range = {
      get Text() { return value },
      set Text(next) { value = next; doc.Saved = false },
    }
    return { Id: id, HasTextFrame: -1, TextFrame: { TextRange: range } }
  }
  const first = shape(4, 'first')
  const second = shape(4, 'second')
  const slides = [
    { SlideID: 71, Shapes: collection([first]) },
    { SlideID: 92, Shapes: collection([second]) },
  ]
  doc.Slides = collection(slides)
  return { doc, slides, first, second }
}

describe('WPS add-in adapter document binding', () => {
  it('uses stable opaque object keys and never follows a changed active document', () => {
    const first = writer()
    const second = writer('second target\r', 'second.docx')
    const docs = [first, second]
    const app = { Documents: collection(docs), ActiveDocument: first }
    const { adapter } = runtime(app, 'wps')
    const list = adapter.documents()
    expect(list[0]).toMatchObject({ type: 'writer', path: '/tmp/sample.docx', saved: true, readOnly: false })
    expect(list[0].key).toMatch(/^doc_[a-f0-9]{32}$/)
    expect(adapter.documents()[0].key).toBe(list[0].key)
    adapter.execute({ action: 'inspect', key: list[0].key, snapshot: 'read-1' })
    app.ActiveDocument = second
    adapter.execute({ action: 'writer_replace', key: list[0].key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })
    expect(first.Content.Text).toBe('alpha changed omega\r')
    expect(second.Content.Text).toBe('second target\r')
  })

  it('rejects a closed target even if another document is opened with the same path', () => {
    const doc = writer()
    const docs = [doc]
    const wrapped = nativeWrappers(docs)
    const { adapter } = runtime({ Documents: wrapped.collection }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const replacement = writer()
    wrapped.close(doc)
    docs.splice(0, 1, replacement)
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ name: 'WpsAdapterError', code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(replacement.writes).toBe(0)
    expect(adapter.documents()[0].key).not.toBe(key)
  })

  it.each(['wps', 'et', 'wpp'])('retains the original %s anchor and snapshot across fresh enumeration wrappers', host => {
    const native = host === 'wps' ? writer() : host === 'et' ? spreadsheet().doc : presentation().doc
    const wrapped = nativeWrappers([native])
    const property = host === 'wps' ? 'Documents' : host === 'et' ? 'Workbooks' : 'Presentations'
    const app = { [property]: wrapped.collection }
    Object.defineProperty(app, 'ActiveDocument', { get() { throw new Error('Active document must not be consulted') } })
    const { adapter } = runtime(app, host)
    const key = adapter.documents()[0].key
    const read = host === 'et' ? { action: 'sheet_read', sheet: 'Data', range: 'A1:B1' } : { action: 'inspect' }
    adapter.execute({ ...read, key, snapshot: 'read-1' })
    for (let poll = 0; poll < 8; poll++) expect(adapter.documents()[0].key).toBe(key)
    const write = host === 'wps'
      ? { action: 'writer_replace', oldText: 'target', replaceText: 'changed' }
      : host === 'et'
        ? { action: 'sheet_write', sheet: 'Data', range: 'A1:B1', values: [[3, 4]] }
        : { action: 'slide_text', slideId: 71, shapeId: 4, text: 'changed' }
    expect(adapter.execute({ ...write, key, snapshot: 'read-1', nextSnapshot: 'write-1' }))
      .toMatchObject({ key, snapshot: 'write-1', outcome: 'modified_unsaved' })
    expect(adapter.execute({ action: 'save', key, snapshot: 'write-1', nextSnapshot: 'save-1', expectedPath: native.FullName }))
      .toMatchObject({ key, snapshot: 'save-1', saved: true })
    const nativeOperations = wrapped.accesses.filter(({ property }) => ['Content', 'Range', 'Worksheets', 'Slides', 'Save'].includes(property))
    expect(nativeOperations.length).toBeGreaterThan(0)
    expect(new Set(nativeOperations.map(({ id }) => id))).toEqual(new Set([1]))
  })

  it('keeps same-name documents distinct by exact FullName and ignores active document changes', () => {
    const first = writer()
    const second = writer('second target\r')
    second.FullName = '/tmp/other/sample.docx'
    const docs = [first, second]
    const wrapped = nativeWrappers(docs)
    const app = { Documents: wrapped.collection, ActiveDocument: first }
    const { adapter } = runtime(app, 'wps')
    const [bound, other] = adapter.documents()
    expect(bound.key).not.toBe(other.key)
    adapter.execute({ action: 'inspect', key: bound.key, snapshot: 'read-1' })
    docs.reverse()
    app.ActiveDocument = second
    expect(adapter.documents().map(({ key }) => key)).toEqual([other.key, bound.key])
    adapter.execute({ action: 'writer_replace', key: bound.key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })
    expect(first.Content.Text).toBe('alpha changed omega\r')
    expect(second.writes).toBe(0)
  })

  it('keeps keys when Saved changes while still rejecting a stale saved-state snapshot', () => {
    const doc = writer()
    const wrapped = nativeWrappers([doc])
    const { adapter } = runtime({ Documents: wrapped.collection }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    doc.Saved = false
    expect(adapter.documents()[0]).toMatchObject({ key, saved: false })
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'STALE_SNAPSHOT', outcome: 'not_executed' })
    expect(doc.writes).toBe(0)
  })

  it('invalidates a bound target when current native identities are ambiguous, even with the original object present', () => {
    const doc = writer()
    const docs = [doc]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const duplicate = writer()
    docs.push(duplicate)
    expect(errorFrom(() => adapter.documents())).toMatchObject({ code: 'UNSUPPORTED', outcome: 'not_executed' })
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'UNSUPPORTED', outcome: 'not_executed' })
    expect(doc.writes + duplicate.writes).toBe(0)
    docs.pop()
    expect(adapter.documents()[0].key).not.toBe(key)
    expect(errorFrom(() => adapter.execute({ action: 'inspect', key, snapshot: 'read-2' }))).toMatchObject({ code: 'DOCUMENT_CLOSED' })
  })

  it('refuses two surviving old anchors that now match one current identity', () => {
    const first = writer()
    const second = writer('second target\r', 'second.docx')
    const docs = [first, second]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const original = adapter.documents()
    first.FullName = second.FullName
    first.Name = second.Name
    docs.shift()
    expect(errorFrom(() => adapter.documents())).toMatchObject({ code: 'UNSUPPORTED', outcome: 'not_executed' })
    for (const { key } of original) {
      expect(errorFrom(() => adapter.execute({ action: 'inspect', key, snapshot: 'read-1' }))).toMatchObject({ code: 'DOCUMENT_CLOSED' })
    }
    expect(first.writes + second.writes).toBe(0)
  })

  it.each(['FullName', 'Name'])('invalidates an anchor with an unavailable native %s getter before same-identity reopen', property => {
    const doc = writer()
    const docs = [doc]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    Object.defineProperty(doc, property, { get() { throw new Error('Closed handle with private native content') } })
    const replacement = writer()
    docs[0] = replacement
    const error = errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' }))
    expect(error).toMatchObject({ code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(error.message).not.toContain('private')
    expect(doc.writes + replacement.writes).toBe(0)
    expect(adapter.documents()[0].key).not.toBe(key)
  })

  it.each(['FullName', 'Name'])('invalidates an anchor whose native %s property disappeared', property => {
    const doc = writer()
    const docs = [doc]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    delete doc[property]
    docs[0] = writer()
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(doc.writes + docs[0].writes).toBe(0)
    expect(adapter.documents()[0].key).not.toBe(key)
  })

  it('does not revive a key after a complete enumeration found no native match', () => {
    const doc = writer()
    const docs = [doc]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    docs.pop()
    expect(adapter.documents()).toEqual([])
    docs.push(doc)
    expect(adapter.documents()[0].key).not.toBe(key)
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(doc.writes).toBe(0)
  })

  it.each(['missing', 'getter', 'count', 'item'])('drops all old bindings after a %s collection failure and never revives their snapshots', fault => {
    const docs = [writer(), writer('other target\r', 'other.docx')]
    const wrapped = nativeWrappers(docs)
    let failing = false
    const nativeCollection = {
      get Count() {
        if (failing && fault === 'count') throw new Error('private count error')
        return wrapped.collection.Count
      },
      Item(index) {
        if (failing && fault === 'item' && index === 2) throw new Error('private item error')
        return wrapped.collection.Item(index)
      },
    }
    const app = {
      get Documents() {
        if (failing && fault === 'getter') throw new Error('private collection error')
        return failing && fault === 'missing' ? undefined : nativeCollection
      },
    }
    const { adapter } = runtime(app, 'wps')
    const original = adapter.documents()
    const key = original[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    failing = true
    const error = errorFrom(() => adapter.documents())
    expect(error).toMatchObject({ name: 'WpsAdapterError', outcome: 'not_executed' })
    expect(error.message).not.toContain('private')
    failing = false
    const recovered = adapter.documents()
    expect(recovered[0].key).not.toBe(original[0].key)
    expect(recovered[1].key).not.toBe(original[1].key)
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(docs[0].writes + docs[1].writes).toBe(0)
  })

  it.each(['FullName', 'Name'])('does not match a replacement with a different %s even when the other identity field agrees', property => {
    const doc = writer()
    const docs = [doc]
    const { adapter } = runtime({ Documents: collection(docs) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const replacement = writer()
    replacement[property] = property === 'FullName' ? '/tmp/another/sample.docx' : 'another.docx'
    docs[0] = replacement
    expect(adapter.documents()[0].key).not.toBe(key)
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'write-1', oldText: 'target', replaceText: 'changed' })))
      .toMatchObject({ code: 'DOCUMENT_CLOSED', outcome: 'not_executed' })
    expect(doc.writes + replacement.writes).toBe(0)
  })

  it('uses raw FullName for unsaved identities instead of their empty local path projection', () => {
    const docs = [writer(), writer()]
    docs[0].FullName = 'Document1'
    docs[1].FullName = 'Document2'
    const wrapped = nativeWrappers(docs)
    const { adapter } = runtime({ Documents: wrapped.collection }, 'wps')
    const original = adapter.documents()
    expect(original.map(({ path }) => path)).toEqual(['', ''])
    expect(original[0].key).not.toBe(original[1].key)
    expect(adapter.documents().map(({ key }) => key)).toEqual(original.map(({ key }) => key))
    expect(adapter.execute({ action: 'inspect', key: original[0].key, snapshot: 'read-1' })).toMatchObject({ key: original[0].key })
  })

  it('reports unsaved paths without inventing local filenames and requires secure randomness', () => {
    const doc = writer()
    doc.FullName = 'Document1'
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    expect(adapter.documents()[0].path).toBe('')
    const context = vm.createContext({})
    vm.runInContext(source, context)
    expect(errorFrom(() => context.HuaqingWpsAdapter.create({ Documents: collection([doc]) }, 'wps').documents()))
      .toMatchObject({ code: 'UNSUPPORTED', outcome: 'not_executed' })
  })
})

describe('WPS snapshot validation and Writer changes', () => {
  it('rejects changed content, expired snapshots, and snapshots belonging to another document', () => {
    const doc = writer()
    const other = writer('other target\r', 'other.docx')
    const { adapter, advance } = runtime({ Documents: collection([doc, other]) }, 'wps')
    const [first, second] = adapter.documents()
    const replace = { action: 'writer_replace', key: first.key, snapshot: 'read-1', nextSnapshot: 'next-1', oldText: 'target', replaceText: 'changed' }
    adapter.execute({ action: 'inspect', key: first.key, snapshot: 'read-1' })
    expect(errorFrom(() => adapter.execute({ ...replace, key: second.key }))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    doc.change('human target change\r')
    expect(errorFrom(() => adapter.execute(replace))).toMatchObject({ code: 'STALE_SNAPSHOT', outcome: 'not_executed' })
    adapter.execute({ action: 'inspect', key: first.key, snapshot: 'read-2' })
    advance(5 * 60 * 1000)
    expect(errorFrom(() => adapter.execute({ ...replace, snapshot: 'read-2' }))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(doc.writes).toBe(0)
  })

  it('requires an exact unique old string, verifies range positions, and consumes successful snapshots', () => {
    const doc = writer('xx target target\r')
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    const replace = { action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'next-1', oldText: 'target', replaceText: 'new' }
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    expect(errorFrom(() => adapter.execute(replace))).toMatchObject({ code: 'AMBIGUOUS_TEXT' })
    const result = adapter.execute({ ...replace, oldText: 'target target' })
    expect(result).toMatchObject({ snapshot: 'next-1', completed: 1, text: 'xx new\r' })
    expect(errorFrom(() => adapter.execute(replace))).toMatchObject({ code: 'STALE_SNAPSHOT' })
  })

  it('writes multiline minutes into a blank Writer document without removing the final paragraph mark', () => {
    const doc = writer('\r')
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const write = { action: 'writer_append', key, snapshot: 'read-1', nextSnapshot: 'write-1', text: '会议主题\n决定：周五提交\r\n行动项：整理资料' }
    expect(adapter.execute(write)).toMatchObject({ text: '会议主题\r决定：周五提交\r行动项：整理资料\r', snapshot: 'write-1', completed: 1 })
    expect(doc.writes).toBe(1)
    expect(errorFrom(() => adapter.execute(write))).toMatchObject({ code: 'STALE_SNAPSHOT' })
  })

  it('rejects unverified Unicode range offsets and truncated Writer mutations before writing', () => {
    const doc = writer('😀 target\r')
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    doc.Range = () => ({ Text: 'wrong text' })
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'next-1', oldText: 'target', replaceText: 'new' })))
      .toMatchObject({ code: 'UNSUPPORTED', outcome: 'not_executed' })
    doc.change('x'.repeat(50001))
    const result = adapter.execute({ action: 'inspect', key, snapshot: 'read-2' })
    expect(result.text.length).toBe(50000)
    expect(result.truncated).toBe(true)
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-2', nextSnapshot: 'next-2', oldText: 'x', replaceText: 'new' })))
      .toMatchObject({ code: 'UNSUPPORTED' })
    expect(doc.writes).toBe(0)
  })

  it('sanitizes vendor exceptions and invalidates snapshots after an uncertain write', () => {
    const doc = writer()
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    doc.failWrite = true
    const operation = { action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'next-1', oldText: 'target', replaceText: 'new' }
    const error = errorFrom(() => adapter.execute(operation))
    expect(error).toMatchObject({ code: 'WPS_WRITE_FAILED', outcome: 'unknown', completed: 0 })
    expect(error.message).not.toContain('private')
    doc.failWrite = false
    expect(errorFrom(() => adapter.execute(operation))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(doc.writes).toBe(1)
  })

  it('does not report a silently ignored native setter as success', () => {
    const doc = writer()
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    doc.ignoreWrite = true
    expect(errorFrom(() => adapter.execute({ action: 'writer_replace', key, snapshot: 'read-1', nextSnapshot: 'next-1', oldText: 'target', replaceText: 'new' })))
      .toMatchObject({ code: 'READBACK_MISMATCH', outcome: 'unknown' })
  })
})

describe('WPS spreadsheet operations', () => {
  function setup(initial) {
    const fixture = spreadsheet(initial)
    const { adapter } = runtime({ Workbooks: collection([fixture.doc]) }, 'et')
    const key = adapter.documents()[0].key
    return { ...fixture, adapter, key }
  }

  it('reads exact rectangular values/formulas and writes explicit formulas with readback', () => {
    const { adapter, key } = setup()
    const read = adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: '$a$1:$b$1', snapshot: 'read-1' })
    expect(read).toMatchObject({ range: 'A1:B1', values: [[1, 2]], formulas: [[1, 2]], truncated: false })
    const result = adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', formulas: [['=1+2', '=3+4']] })
    expect(result).toMatchObject({ snapshot: 'next-1', completed: 2, formulas: [['=1+2', '=3+4']], hasFormulas: [[true, true]] })
  })

  it('forces formula-looking strings to text and preserves ordinary string display formats', () => {
    const { adapter, key, writes, sheet } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    const result = adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [['=HYPERLINK("remote")', '00123']] })
    expect(result.values).toEqual([['=HYPERLINK("remote")', '00123']])
    expect(result.hasFormulas).toEqual([[false, false]])
    expect(result.numberFormats).toEqual([['@', 'General']])
    expect(writes.slice(0, 2)).toEqual([
      { address: 'A1', property: 'NumberFormat', value: '@' },
      { address: 'A1', property: 'Value2', value: '=HYPERLINK("remote")' },
    ])
    expect(sheet.Range('A1').HasFormula).toBe(false)
  })

  it('checks the entire old range, including formula and format, before the first setter', () => {
    const { adapter, key, writes, sheet, doc } = setup()
    doc.Saved = false
    const write = { action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3, 4]] }
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    sheet.Range('B1').externalChange(2, '=1+1')
    expect(errorFrom(() => adapter.execute(write))).toMatchObject({ code: 'STALE_SNAPSHOT', outcome: 'not_executed' })
    expect(writes).toEqual([])
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-2' })
    sheet.Range('B1').externalChange(2, '=1+1', '0.00')
    expect(errorFrom(() => adapter.execute({ ...write, snapshot: 'read-2' }))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(writes).toEqual([])
  })

  it('keeps numeric Formula type mismatches unknown and reports only finite field/type diagnostics', () => {
    const { adapter, key, doc, sheet, writes } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    doc.afterValueWrite = address => {
      if (address === 'B1') sheet.Range('B1').externalChange(4, '4')
    }
    const operation = { action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3, 4]] }
    const error = errorFrom(() => adapter.execute(operation))
    expect(error).toMatchObject({ code: 'READBACK_MISMATCH', outcome: 'unknown', completed: 1 })
    expect(error.diagnostic).toEqual({
      phase: 'cell', ordinal: 1, mismatchFields: ['formula'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' },
    })
    expect(writes).toHaveLength(2)
    expect(errorFrom(() => adapter.execute(operation))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(writes).toHaveLength(2)
  })

  it('distinguishes a format mismatch without disclosing the native format code', () => {
    const { adapter, key, doc, sheet } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1' })
    doc.afterValueWrite = () => sheet.Range('A1').externalChange(3, 3, 'PRIVATE_NATIVE_FORMAT')
    const error = errorFrom(() => adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3]] }))
    expect(error).toMatchObject({ code: 'READBACK_MISMATCH', outcome: 'unknown', completed: 0 })
    expect(error.diagnostic).toEqual({
      phase: 'cell', ordinal: 0, mismatchFields: ['numberFormat'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
    })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_NATIVE_FORMAT')
    expect(error.message).not.toContain('PRIVATE_NATIVE_FORMAT')
  })

  it('bounds the diagnostic to four known fields and never copies values, formulas or formats', () => {
    const { adapter, key, doc, sheet } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1' })
    doc.afterValueWrite = () => sheet.Range('A1').externalChange('PRIVATE_CELL_VALUE', '=PRIVATE_FORMULA()', 'PRIVATE_FORMAT')
    const error = errorFrom(() => adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3]] }))
    expect(error.diagnostic).toEqual({
      phase: 'cell', ordinal: 0, mismatchFields: ['value', 'formula', 'numberFormat', 'hasFormula'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'string', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' },
    })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_')
    expect(error.message).not.toContain('PRIVATE_')
  })

  it('marks the formula result type as not checked while retaining strict formula verification', () => {
    const { adapter, key, sheet } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1' })
    const cell = sheet.Range('A1')
    const descriptor = Object.getOwnPropertyDescriptor(cell, 'Formula')
    Object.defineProperty(cell, 'Formula', {
      get: descriptor.get,
      set(value) { descriptor.set.call(cell, value); cell.externalChange(99, '=PRIVATE_UNEXPECTED_FORMULA()') },
    })
    const error = errorFrom(() => adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:A1', snapshot: 'read-1', nextSnapshot: 'next-1', formulas: [['=1+2']] }))
    expect(error).toMatchObject({ code: 'READBACK_MISMATCH', outcome: 'unknown', completed: 0 })
    expect(error.diagnostic).toEqual({
      phase: 'cell', ordinal: 0, mismatchFields: ['formula'],
      expectedTypes: { value: 'not_checked', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' },
    })
    expect(JSON.stringify(error)).not.toContain('PRIVATE_')
  })

  it('rejects dimensions, merged ranges, and ranges exceeding 1000 cells without writing', () => {
    const { adapter, key, writes, sheet } = setup()
    expect(errorFrom(() => adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:ZZ100', snapshot: 'too-large' })))
      .toMatchObject({ code: 'LIMIT_EXCEEDED' })
    expect(errorFrom(() => adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1,B1', snapshot: 'union' })))
      .toMatchObject({ code: 'INVALID_OPERATION' })
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    const write = { action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1' }
    expect(errorFrom(() => adapter.execute({ ...write, values: [[3]] }))).toMatchObject({ code: 'INVALID_OPERATION' })
    sheet.Range('B1').MergeCells = true
    expect(errorFrom(() => adapter.execute({ ...write, values: [[3, 4]] }))).toMatchObject({ code: 'UNSUPPORTED' })
    expect(writes).toEqual([])
  })

  it('stops at a partial native failure, reports completed cells, and prevents replay', () => {
    const { adapter, key, doc, sheet, writes } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    doc.failAt = 'B1'
    const write = { action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3, 4]] }
    expect(errorFrom(() => adapter.execute(write))).toMatchObject({ code: 'WPS_WRITE_FAILED', outcome: 'unknown', completed: 1 })
    expect(sheet.Range('A1').Value2).toBe(3)
    expect(sheet.Range('B1').Value2).toBe(2)
    expect(writes).toHaveLength(2)
    expect(errorFrom(() => adapter.execute(write))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    expect(writes).toHaveLength(2)
  })

  it('verifies the final range when a later native setter changes an earlier cell', () => {
    const { adapter, key, doc, sheet } = setup()
    adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1' })
    doc.afterValueWrite = (address) => {
      if (address === 'B1') sheet.Range('A1').externalChange(777)
    }
    const error = errorFrom(() => adapter.execute({ action: 'sheet_write', key, sheet: 'Data', range: 'A1:B1', snapshot: 'read-1', nextSnapshot: 'next-1', values: [[3, 4]] }))
    expect(error).toMatchObject({ code: 'READBACK_MISMATCH', outcome: 'unknown', completed: 2 })
    expect(error.diagnostic).toEqual({
      phase: 'final', ordinal: 0, mismatchFields: ['value', 'formula'],
      expectedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
      observedTypes: { value: 'number', formula: 'number', numberFormat: 'string', hasFormula: 'boolean' },
    })
    expect(sheet.Range('A1').Value2).toBe(777)
  })

  it('does not expose an unbounded 1000-cell text payload', () => {
    const { adapter, key } = setup({ A1: 'x'.repeat(32767), B1: 'x'.repeat(32767), C1: 'x'.repeat(32767) })
    expect(errorFrom(() => adapter.execute({ action: 'sheet_read', key, sheet: 'Data', range: 'A1:C1', snapshot: 'read-1' })))
      .toMatchObject({ code: 'LIMIT_EXCEEDED', outcome: 'not_executed' })
  })
})

describe('WPS presentation operations', () => {
  it('routes by slide ID and shape ID after slide order changes without using the active slide', () => {
    const { doc, slides, first, second } = presentation()
    const { adapter } = runtime({ Presentations: collection([doc]) }, 'wpp')
    const key = adapter.documents()[0].key
    slides.reverse()
    const read = adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    expect(read.items).toEqual([
      { slideId: 92, shapeId: 4, text: 'second', truncated: false },
      { slideId: 71, shapeId: 4, text: 'first', truncated: false },
    ])
    adapter.execute({ action: 'slide_text', key, snapshot: 'read-1', nextSnapshot: 'next-1', slideId: 71, shapeId: 4, text: 'changed' })
    expect(first.TextFrame.TextRange.Text).toBe('changed')
    expect(second.TextFrame.TextRange.Text).toBe('second')
  })

  it('keeps snapshot state private and refuses a changed or unobserved shape', () => {
    const { doc, first } = presentation()
    const { adapter } = runtime({ Presentations: collection([doc]) }, 'wpp')
    const key = adapter.documents()[0].key
    const result = adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    result.items[0].text = 'forged'
    first.TextFrame.TextRange.Text = 'forged'
    expect(errorFrom(() => adapter.execute({ action: 'slide_text', key, snapshot: 'read-1', nextSnapshot: 'next-1', slideId: 71, shapeId: 4, text: 'new' })))
      .toMatchObject({ code: 'STALE_SNAPSHOT' })
    adapter.execute({ action: 'inspect', key, snapshot: 'read-2' })
    expect(errorFrom(() => adapter.execute({ action: 'slide_text', key, snapshot: 'read-2', nextSnapshot: 'next-2', slideId: 71, shapeId: 999, text: 'new' })))
      .toMatchObject({ code: 'SNAPSHOT_SCOPE' })
  })

  it('reports truncated presentation text and refuses to mutate its partial preview', () => {
    const { doc, first } = presentation()
    first.TextFrame.TextRange.Text = 'x'.repeat(50001)
    const { adapter } = runtime({ Presentations: collection([doc]) }, 'wpp')
    const key = adapter.documents()[0].key
    const result = adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    expect(result.items[0].text.length).toBe(50000)
    expect(result).toMatchObject({ truncated: true })
    expect(errorFrom(() => adapter.execute({ action: 'slide_text', key, snapshot: 'read-1', nextSnapshot: 'next-1', slideId: 71, shapeId: 4, text: 'new' })))
      .toMatchObject({ code: 'SNAPSHOT_SCOPE' })
  })

  it('limits presentation inspection to 200 explicitly reported shape items', () => {
    const { doc } = presentation()
    const shapes = Array.from({ length: 201 }, (_, index) => ({
      Id: index + 1, HasTextFrame: true, TextFrame: { TextRange: { Text: 'shape ' + index } },
    }))
    doc.Slides = collection([{ SlideID: 1, Shapes: collection(shapes) }])
    const { adapter } = runtime({ Presentations: collection([doc]) }, 'wpp')
    const key = adapter.documents()[0].key
    const result = adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    expect(result.items).toHaveLength(200)
    expect(result.truncated).toBe(true)
  })
})

describe('WPS save boundary', () => {
  it('requires the unchanged absolute local path, current dirty state and content, then issues a new snapshot', () => {
    const doc = writer()
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const save = { action: 'save', key, snapshot: 'read-1', nextSnapshot: 'next-1', expectedPath: doc.FullName }
    expect(errorFrom(() => adapter.execute({ ...save, expectedPath: 'https://remote/file.docx' }))).toMatchObject({ code: 'PATH_CHANGED' })
    expect(errorFrom(() => adapter.execute({ ...save, expectedPath: '/tmp/other.docx' }))).toMatchObject({ code: 'PATH_CHANGED' })
    const result = adapter.execute(save)
    expect(result).toMatchObject({ saved: true, snapshot: 'next-1', coverage: 'observed_content_only', completed: 1 })
    expect(doc.saves).toBe(1)
    expect(errorFrom(() => adapter.execute(save))).toMatchObject({ code: 'STALE_SNAPSHOT' })
  })

  it('cannot save read-only, renamed, metadata-only, or unverified documents', () => {
    const doc = writer()
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    doc.ReadOnly = true
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    const save = { action: 'save', key, snapshot: 'read-1', nextSnapshot: 'next-1', expectedPath: doc.FullName }
    expect(errorFrom(() => adapter.execute(save))).toMatchObject({ code: 'READ_ONLY' })
    doc.ReadOnly = false
    adapter.execute({ action: 'inspect', key, snapshot: 'read-2' })
    doc.FullName = '/tmp/renamed.docx'
    expect(errorFrom(() => adapter.execute({ ...save, snapshot: 'read-2' }))).toMatchObject({ code: 'STALE_SNAPSHOT' })
    adapter.execute({ action: 'inspect', key, snapshot: 'read-3' })
    doc.Save = () => { doc.Saved = false }
    expect(errorFrom(() => adapter.execute({ ...save, snapshot: 'read-3', expectedPath: doc.FullName }))).toMatchObject({ code: 'SAVE_UNVERIFIED', outcome: 'unknown' })
    const book = spreadsheet().doc
    const { adapter: et } = runtime({ Workbooks: collection([book]) }, 'et')
    const bookKey = et.documents()[0].key
    et.execute({ action: 'inspect', key: bookKey, snapshot: 'book-read' })
    expect(errorFrom(() => et.execute({ action: 'save', key: bookKey, snapshot: 'book-read', nextSnapshot: 'book-next', expectedPath: book.FullName })))
      .toMatchObject({ code: 'SNAPSHOT_SCOPE' })
  })

  it('reports unknown when a native save callback changes observed content', () => {
    const doc = writer()
    const { adapter } = runtime({ Documents: collection([doc]) }, 'wps')
    const key = adapter.documents()[0].key
    adapter.execute({ action: 'inspect', key, snapshot: 'read-1' })
    doc.Save = () => { doc.change('changed during save\r'); doc.Saved = true }
    expect(errorFrom(() => adapter.execute({ action: 'save', key, snapshot: 'read-1', nextSnapshot: 'next-1', expectedPath: doc.FullName })))
      .toMatchObject({ code: 'SAVE_UNVERIFIED', outcome: 'unknown', completed: 1 })
  })
})
