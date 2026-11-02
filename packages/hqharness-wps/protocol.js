export const WPS_TOOL_NAME = 'mcp__huaqing_wps__wps_use'
export const WPS_RAW_TOOL_NAME = 'wps_use'
export const WPS_MAX_OPERATION_BYTES = 65_536
export const WPS_MAX_CELLS = 1000
export const WPS_MAX_FORMULA_LENGTH = 4096
export const WPS_READ_ACTIONS = Object.freeze(['status', 'documents', 'inspect', 'sheet_read', 'recover'])
export const WPS_WRITE_ACTIONS = Object.freeze(['sheet_write', 'writer_replace', 'slide_text', 'save'])

const fields = Object.freeze({
  status: [], documents: [], inspect: ['key'], recover: ['key'], sheet_read: ['key', 'sheet', 'range'],
  sheet_write: ['key', 'snapshot', 'sheet', 'range'],
  writer_replace: ['key', 'snapshot', 'oldText', 'replaceText'],
  slide_text: ['key', 'snapshot', 'slideId', 'shapeId', 'text'], save: ['key', 'snapshot']
})
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const failureCauses = new Set([
  'WPS_READBACK_MISMATCH', 'WPS_SAVE_UNVERIFIED', 'WPS_NOT_CONNECTED', 'WPS_STALE_DOCUMENT',
  'WPS_PROTOCOL_ERROR', 'WPS_UNKNOWN_OUTCOME', 'WPS_OPERATION_FAILED', 'WPS_WRITE_FAILED', 'WPS_READ_FAILED',
  'WPS_STALE_SNAPSHOT', 'WPS_UNSUPPORTED', 'WPS_READ_ONLY', 'WPS_INVALID_INPUT', 'WPS_SNAPSHOT_SCOPE',
  'WPS_DOCUMENT_CLOSED', 'WPS_CONFLICT', 'WPS_PARTIAL_FAILURE', 'WPS_SAVE_FAILED', 'WPS_OUTPUT_TOO_LARGE',
  'WPS_FILE_CHANGED', 'WPS_STOPPED'
])
const diagnosticFields = ['value', 'formula', 'numberFormat', 'hasFormula']
const diagnosticTypes = ['null', 'boolean', 'number', 'string']
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))

/** Safe failure metadata only. Never retain provider messages, cell contents,
 * formula/format strings, document identities or arbitrary extra properties. */
export function readWpsFailureDetails(value) {
  if (!record(value)) return {}
  const result = {}
  if (failureCauses.has(value.causeCode)) result.causeCode = value.causeCode
  if (Number.isSafeInteger(value.completed) && value.completed >= 0 && value.completed <= WPS_MAX_CELLS) result.completed = value.completed
  const diagnostic = value.diagnostic
  if (result.causeCode !== 'WPS_READBACK_MISMATCH' || !exactKeys(diagnostic, ['phase', 'ordinal', 'mismatchFields', 'expectedTypes', 'observedTypes'])
    || !['cell', 'final'].includes(diagnostic.phase) || !Number.isSafeInteger(diagnostic.ordinal) || diagnostic.ordinal < 0 || diagnostic.ordinal >= WPS_MAX_CELLS
    || !Array.isArray(diagnostic.mismatchFields) || diagnostic.mismatchFields.length < 1 || diagnostic.mismatchFields.length > diagnosticFields.length
    || new Set(diagnostic.mismatchFields).size !== diagnostic.mismatchFields.length || diagnostic.mismatchFields.some(field => !diagnosticFields.includes(field))) return result
  const types = (input, expected) => {
    if (!exactKeys(input, diagnosticFields) || !diagnosticTypes.includes(input.formula) || input.numberFormat !== 'string' || input.hasFormula !== 'boolean'
      || !(diagnosticTypes.includes(input.value) || expected && input.value === 'not_checked')) return
    return { value: input.value, formula: input.formula, numberFormat: input.numberFormat, hasFormula: input.hasFormula }
  }
  const expectedTypes = types(diagnostic.expectedTypes, true)
  const observedTypes = types(diagnostic.observedTypes, false)
  if (expectedTypes && observedTypes) result.diagnostic = { phase: diagnostic.phase, ordinal: diagnostic.ordinal,
    mismatchFields: diagnosticFields.filter(field => diagnostic.mismatchFields.includes(field)), expectedTypes, observedTypes }
  return result
}
const scalarSchema = { oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' }] }
const matrixSchema = { type: 'array', items: { type: 'array', items: scalarSchema } }
// This is a positive calculation language, not an evaluator or a workbook
// sandbox. In particular there is no named-function, dynamic-reference or
// expression-call syntax. Keep function names and arities explicit.
const formulaFunctions = Object.freeze({
  SUM: [1, 255], AVERAGE: [1, 255], IF: [2, 3], COUNT: [1, 255], COUNTA: [1, 255],
  COUNTIF: [2, 2], COUNTIFS: [2, 254], SUMIF: [2, 3], SUMIFS: [3, 255],
  ROUND: [2, 2], MIN: [1, 255], MAX: [1, 255], INDEX: [2, 4], MATCH: [2, 3],
  XLOOKUP: [3, 6], VLOOKUP: [3, 4], HLOOKUP: [3, 4], AND: [1, 255], OR: [1, 255], NOT: [1, 1],
  ABS: [1, 1], INT: [1, 1], MOD: [2, 2], ROUNDUP: [2, 2], ROUNDDOWN: [2, 2],
  CONCAT: [1, 255], CONCATENATE: [1, 255], LEFT: [1, 2], RIGHT: [1, 2], MID: [3, 3],
  LEN: [1, 1], TRIM: [1, 1], LOWER: [1, 1], UPPER: [1, 1], IFERROR: [2, 2],
  SUMPRODUCT: [1, 255], COUNTBLANK: [1, 1], PRODUCT: [1, 255], SQRT: [1, 1],
  POWER: [2, 2], CEILING: [2, 2], FLOOR: [2, 2], TRUE: [0, 0], FALSE: [0, 0]
})
export const WPS_FORMULA_FUNCTIONS = Object.freeze(Object.keys(formulaFunctions))

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** One authority for the model schema and the Main/connector validation boundary.
 * Per-action requiredness and bounded matrices are enforced by the validator:
 * Harness's supported JSON Schema vocabulary does not express every bound. */
export const WPS_INPUT_SCHEMA = freeze({
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: { type: 'string', enum: Object.keys(fields) },
    key: { type: 'string', description: 'Opaque local document key returned by documents; never a path.' },
    snapshot: { type: 'string', description: 'Latest snapshot returned for this document. Required for every write and save.' },
    sheet: { type: 'string', description: 'Exact sheet name returned by the document.' },
    range: { type: 'string', description: 'Explicit cell range; at most 1000 cells per operation.' },
    values: matrixSchema,
    formulas: {
      type: 'array', items: { type: 'array', items: { type: 'string' } },
      description: `Explicit =-prefixed local calculations, at most ${WPS_MAX_FORMULA_LENGTH} characters per formula. A1 references and bounded ranges only; no external links, URLs, DDE, macros, UDFs, named ranges or dynamic references. Supported built-ins: ${WPS_FORMULA_FUNCTIONS.join(', ')}. Use values with null to clear a cell.`
    },
    oldText: { type: 'string' }, replaceText: { type: 'string' },
    slideId: { type: 'integer', description: 'Positive slide ID returned by WPS inspection.' }, shapeId: { type: 'integer', description: 'Positive shape ID returned by WPS inspection.' }, text: { type: 'string' }
  }
})

function fail(message) { throw new TypeError(`Invalid WPS operation: ${message}`) }
function string(value, key, empty = false) {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.includes('\0')) fail(`${key} must be ${empty ? 'a' : 'a nonempty'} string without NUL`)
  if (!['oldText', 'replaceText', 'text'].includes(key) && value.length > 256) fail(`${key} exceeds 256 characters`)
}

function formula(value) {
  const unsupported = detail => fail(`unsupported formula: ${detail}`)
  if (typeof value !== 'string' || !value.startsWith('=') || value.length > WPS_MAX_FORMULA_LENGTH) unsupported('use an =-prefixed string of at most 4096 characters; clear cells with values and null')
  // These constructs never occur in the admitted language, including inside
  // quoted literals. The parser below is the authority for everything else.
  if (/[\u0000-\u001f\u007f\\[\]|]/u.test(value) || /(?::\/\/|(?:https?|file|ftp|mailto|data|javascript):)/iu.test(value)) unsupported('external references, URLs, paths and DDE are unavailable')
  const tokens = []
  let offset = 1
  while (offset < value.length) {
    const char = value[offset]
    if (char === ' ') { offset++; continue }
    if (char === '"' || char === "'") {
      const quote = char
      let text = ''
      let closed = false
      offset++
      while (offset < value.length) {
        const next = value[offset++]
        if (next !== quote) { text += next; continue }
        if (value[offset] === quote) { text += quote; offset++; continue }
        closed = true; break
      }
      if (!closed) unsupported('unclosed quoted literal')
      tokens.push({ kind: quote === '"' ? 'text' : 'sheet', value: text })
      continue
    }
    const remaining = value.slice(offset)
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/u.exec(remaining)?.[0]
    if (number) {
      if (!Number.isFinite(Number(number))) unsupported('number is not finite')
      tokens.push({ kind: 'number', value: number }); offset += number.length; continue
    }
    const word = /^[$\p{L}_][\p{L}\p{N}_$]*/u.exec(remaining)?.[0]
    if (word) { tokens.push({ kind: 'word', value: word }); offset += word.length; continue }
    const operator = /^(?:<=|>=|<>|[+\-*/^&%=<>(),!:])/u.exec(remaining)?.[0]
    if (!operator) unsupported('only explicit A1 calculations and listed built-in functions are supported')
    tokens.push({ kind: 'operator', value: operator }); offset += operator.length
  }
  let position = 0
  const peek = text => tokens[position]?.value === text
  const expect = text => { if (!peek(text)) unsupported('incomplete or unsupported expression'); position++ }
  const cell = token => {
    const match = token?.kind === 'word' && /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/u.exec(token.value)
    if (!match) unsupported('use explicit A1 cells, not named or dynamic references')
    const column = [...match[1].toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0)
    const row = Number(match[2])
    if (column > 16384 || row > 1048576) unsupported('cell is outside worksheet bounds')
    return { column, row }
  }
  const reference = first => {
    const start = cell(first)
    if (!peek(':')) return
    position++
    const end = cell(tokens[position++])
    const rows = end.row - start.row + 1
    const columns = end.column - start.column + 1
    if (rows < 1 || columns < 1 || rows * columns > WPS_MAX_CELLS) unsupported('each reference range must contain at most 1000 cells')
  }
  const precedence = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5 }
  function expression(depth = 0, minimum = 0) {
    if (depth > 32) unsupported('expression nesting exceeds 32 levels')
    primary(depth + 1)
    while (peek('%')) position++
    while (Object.hasOwn(precedence, tokens[position]?.value)) {
      const operator = tokens[position].value
      const priority = precedence[operator]
      if (priority < minimum) break
      position++
      expression(depth + 1, priority + (operator === '^' ? 0 : 1))
    }
  }
  function primary(depth) {
    if (depth > 32) unsupported('expression nesting exceeds 32 levels')
    if (peek('+') || peek('-')) { position++; primary(depth + 1); return }
    if (peek('(')) { position++; expression(depth + 1); expect(')'); return }
    const token = tokens[position++]
    if (!token) unsupported('missing operand')
    if (token.kind === 'number' || token.kind === 'text') return
    if (token.kind !== 'word' && token.kind !== 'sheet') unsupported('unsupported operand')
    if (peek('!')) {
      if (!token.value || token.value.length > 31 || /[:*?/]/u.test(token.value)) unsupported('unsupported worksheet qualifier')
      position++; reference(tokens[position++]); return
    }
    if (token.kind === 'sheet') unsupported('quoted worksheets require an A1 reference')
    if (peek('(')) {
      const name = token.value.toUpperCase()
      if (!/^[A-Za-z]+$/u.test(token.value) || !Object.hasOwn(formulaFunctions, name)) unsupported('function is outside the listed built-in calculation set')
      position++
      let count = 0
      if (!peek(')')) {
        while (true) {
          expression(depth + 1); count++
          if (!peek(',')) break
          position++
        }
      }
      expect(')')
      const [minimum, maximum] = formulaFunctions[name]
      if (count < minimum || count > maximum || (name === 'COUNTIFS' && count % 2 !== 0) || (name === 'SUMIFS' && count % 2 !== 1)) unsupported('unsupported argument count')
      return
    }
    if (/^[A-Za-z]+$/u.test(token.value) && ['TRUE', 'FALSE'].includes(token.value.toUpperCase())) return
    reference(token)
  }
  expression()
  // In particular, a function/result/reference followed by another '(' is
  // never callable: that could invoke a workbook-defined LAMBDA.
  if (position !== tokens.length) unsupported('extra tokens, expression calls and reference operators are unavailable')
}

function matrix(value, key) {
  if (!Array.isArray(value) || value.length === 0 || value.length > WPS_MAX_CELLS) fail(`${key} must be a nonempty matrix`)
  let width
  let cells = 0
  for (const row of value) {
    if (!Array.isArray(row) || row.length === 0) fail(`${key} must have nonempty rows`)
    width ??= row.length
    if (row.length !== width) fail(`${key} must be rectangular`)
    cells += row.length
    if (cells > WPS_MAX_CELLS) fail(`${key} exceeds ${WPS_MAX_CELLS} cells`)
    for (const cell of row) {
      if (key === 'formulas') { formula(cell); continue }
      if (cell !== null && !['string', 'number', 'boolean'].includes(typeof cell)) fail(`${key} cells must be JSON scalars`)
      if (typeof cell === 'number' && !Number.isFinite(cell)) fail(`${key} cells must be finite`)
      if (typeof cell === 'string' && cell.includes('\0')) fail(`${key} cells cannot contain NUL`)
    }
  }
}

/** Validate a finite operation without interpreting paths, scripts or Office code. */
export function validateWpsOperation(value) {
  if (!record(value) || !Object.hasOwn(fields, value.action)) fail('unknown action or non-object arguments')
  const required = fields[value.action]
  const allowed = new Set(['action', ...required, ...(value.action === 'sheet_write' ? ['values', 'formulas'] : [])])
  if (Object.keys(value).some(key => !allowed.has(key))) fail('unexpected field')
  for (const key of required) {
    if (key === 'slideId' || key === 'shapeId') {
      if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > 2_147_483_647) fail(`${key} must be a positive 32-bit integer`)
    } else string(value[key], key, key === 'replaceText' || key === 'text')
  }
  if (value.action === 'sheet_write') {
    const hasValues = Object.hasOwn(value, 'values')
    const hasFormulas = Object.hasOwn(value, 'formulas')
    if (hasValues === hasFormulas) fail('sheet_write requires exactly one of values or formulas')
    matrix(value[hasValues ? 'values' : 'formulas'], hasValues ? 'values' : 'formulas')
  }
  if (new TextEncoder().encode(JSON.stringify(value)).length > WPS_MAX_OPERATION_BYTES) fail('request exceeds 64 KiB UTF-8')
  return value
}

/** The policy comes from Harness, never the model's arguments. */
export function validateWpsCallMeta(value) {
  if (!record(value) || Object.keys(value).some(key => !['owner', 'policy'].includes(key))) fail('invalid call metadata')
  string(value.owner, 'owner')
  const policy = value.policy
  if (!record(policy) || Object.keys(policy).some(key => !['mode', 'workspaceRoot'].includes(key))
    || !['read-only', 'workspace-write', 'danger-full-access'].includes(policy.mode)) fail('invalid sandbox policy')
  if (typeof policy.workspaceRoot !== 'string' || !policy.workspaceRoot || policy.workspaceRoot.includes('\0') || policy.workspaceRoot.length > 32_768) fail('invalid workspaceRoot')
  return value
}
