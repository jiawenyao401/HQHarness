import { describe, expect, it } from 'vitest'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { WPS_INPUT_SCHEMA, WPS_FORMULA_FUNCTIONS, WPS_MAX_FORMULA_LENGTH, readWpsFailureDetails, validateWpsCallMeta, validateWpsOperation } from '../packages/hqharness-wps/protocol.js'

describe('bounded WPS failure diagnostics', () => {
  const diagnostic = { phase: 'cell', ordinal: 999, mismatchFields: ['value', 'formula'],
    expectedTypes: { value: 'number', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' },
    observedTypes: { value: 'string', formula: 'string', numberFormat: 'string', hasFormula: 'boolean' } }
  it('copies only finite cause, progress and predicate type metadata', () => {
    const input = { causeCode: 'WPS_READBACK_MISMATCH', completed: 1000, diagnostic, message: 'private body', values: [['private value']] }
    expect(readWpsFailureDetails(input)).toEqual({ causeCode: input.causeCode, completed: 1000, diagnostic })
    expect(readWpsFailureDetails({ causeCode: 'WPS_PRIVATE_SECRET', completed: -1, diagnostic })).toEqual({})
    expect(readWpsFailureDetails({ causeCode: 'WPS_SAVE_UNVERIFIED', completed: 1001, diagnostic })).toEqual({ causeCode: 'WPS_SAVE_UNVERIFIED' })
    expect(readWpsFailureDetails({ causeCode: input.causeCode, diagnostic: { ...diagnostic, expectedTypes: { ...diagnostic.expectedTypes, value: 'not_checked' } } }).diagnostic.expectedTypes.value).toBe('not_checked')
  })
  it.each([
    { phase: 'private body' }, { ordinal: -1 }, { ordinal: 1000 }, { ordinal: 0.5 }, { extra: 'private body' },
    { mismatchFields: ['value', 'value'] }, { mismatchFields: ['private body'] }, { mismatchFields: [] },
    { observedTypes: { ...diagnostic.observedTypes, value: 'not_checked' } },
    { expectedTypes: { ...diagnostic.expectedTypes, formula: '=PRIVATE()' } },
    { expectedTypes: { ...diagnostic.expectedTypes, extra: 'private body' } }
  ])('drops a malformed diagnostic without exposing arbitrary fields: %j', change => {
    expect(readWpsFailureDetails({ causeCode: 'WPS_READBACK_MISMATCH', diagnostic: { ...diagnostic, ...change } })).toEqual({ causeCode: 'WPS_READBACK_MISMATCH' })
  })
})

describe('finite WPS protocol', () => {
  it('accepts all bounded actions and the published Harness schema', () => {
    expect(() => assertSupportedJsonSchema(WPS_INPUT_SCHEMA)).not.toThrow()
    for (const operation of [
      { action: 'status' }, { action: 'documents' }, { action: 'inspect', key: 'document' }, { action: 'recover', key: 'document' },
      { action: 'sheet_read', key: 'document', sheet: '数据', range: 'A1:B2' },
      { action: 'sheet_write', key: 'document', snapshot: 'snapshot', sheet: '数据', range: 'A1:B2', values: [[null, 1], ['text', true]] },
      { action: 'sheet_write', key: 'document', snapshot: 'snapshot', sheet: '数据', range: 'A1:A1', formulas: [['=SUM(B1:B3)']] },
      { action: 'writer_replace', key: 'document', snapshot: 'snapshot', oldText: '原文', replaceText: '' },
      { action: 'writer_append', key: 'document', snapshot: 'snapshot', text: '标题\n正文' },
      { action: 'slide_text', key: 'document', snapshot: 'snapshot', slideId: 256, shapeId: 3, text: '' },
      { action: 'save', key: 'document', snapshot: 'snapshot' }
    ]) expect(validateWpsOperation(operation)).toEqual(operation)
  })
  it.each([
    null, [], { action: 'run_code', code: 'process.exit()' }, { action: 'status', endpoint: 'http://remote' },
    { action: 'inspect' }, { action: 'inspect', key: '' }, { action: 'save', key: 'doc' },
    { action: 'recover', key: 'doc', snapshot: 'old' },
    { action: 'save', key: 'doc', snapshot: 's', path: '/another/file' },
    { action: 'save', key: 'doc', snapshot: 's', _meta: { huaqing: { owner: 'another' } } },
    { action: 'writer_replace', key: 'd', snapshot: 's', oldText: '', replaceText: 'x' },
    { action: 'writer_append', key: 'd', snapshot: 's', text: '  ' },
    { action: 'writer_append', key: 'd', text: 'missing snapshot' },
    { action: 'slide_text', key: 'd', snapshot: 's', slideId: 2, shapeId: 3, text: 'x\0y' },
    ...['1', 0, -1, 1.2, 2_147_483_648, NaN].map(slideId => ({ action: 'slide_text', key: 'd', snapshot: 's', slideId, shapeId: 1, text: 'x' })),
    ...['1', 0, -1, 1.2, 2_147_483_648, NaN].map(shapeId => ({ action: 'slide_text', key: 'd', snapshot: 's', slideId: 1, shapeId, text: 'x' }))
  ])('rejects invalid or privilege-bearing arguments: %j', value => {
    expect(() => validateWpsOperation(value)).toThrow(TypeError)
  })
  it.each([[], [[]], [[1], [2, 3]], [[{}]], [[undefined]], [[Infinity]], [[NaN]], [Array(1001).fill(0)]])('rejects invalid/oversized matrices: %j', values => {
    expect(() => validateWpsOperation({ action: 'sheet_write', key: 'd', snapshot: 's', sheet: 'S', range: 'A1:A1', values })).toThrow()
  })
  it('requires exactly one matrix and enforces UTF-8 rather than codepoint size', () => {
    const operation = { action: 'sheet_write', key: 'd', snapshot: 's', sheet: 'S', range: 'A1:A1' }
    expect(() => validateWpsOperation(operation)).toThrow()
    expect(() => validateWpsOperation({ ...operation, values: [[1]], formulas: [['=1']] })).toThrow()
    expect(() => validateWpsOperation({ action: 'writer_replace', key: 'd', snapshot: 's', oldText: 'x', replaceText: '汉'.repeat(30_000) })).toThrow(/64 KiB/)
  })
  it('validates transport metadata separately from model arguments', () => {
    const meta = { owner: 'session', policy: { mode: 'workspace-write', workspaceRoot: '/workspace' } }
    expect(validateWpsCallMeta(meta)).toEqual(meta)
    for (const value of [{}, { ...meta, token: 'secret' }, { ...meta, owner: '' }, { ...meta, policy: { mode: 'unrestricted', workspaceRoot: '/' } }, { ...meta, policy: { mode: 'read-only', workspaceRoot: '', owner: 'fake' } }]) {
      expect(() => validateWpsCallMeta(value)).toThrow()
    }
  })
})

const formulaOperation = formula => ({ action: 'sheet_write', key: 'document', snapshot: 'snapshot', sheet: '数据', range: 'A1', formulas: [[formula]] })
describe('bounded built-in WPS calculations', () => {
  it.each([
    '=SUM(A1:B2)', '=sum(1,2,3)', '=AVERAGE(\'季度 汇总\'!$A$1:$A$5)',
    "='利润''表'!$A$1:$B$2", "='Q!A'!B1", '=中文工作表!A1+统计!B2',
    '=IF(A1>=1,"通过","不通过")', '=IF(AND(A1>0,B1<>""),A1*B1,0)',
    '=COUNTIF(A1:A20,"<10")', '=COUNTIFS(A1:A20,">0",B1:B20,"是")',
    '=SUMIF(A1:A10,">0",B1:B10)', '=SUMIFS(C1:C10,A1:A10,">0",B1:B10,"是")',
    '=ROUND((A1+B1)/2,2)', '=MIN(A1:A10)+MAX(B1:B10)',
    '=INDEX(A1:B10,MATCH(C1,A1:A10,0),2)', '=XLOOKUP(A1,B1:B10,C1:C10,"未找到",0)',
    '=VLOOKUP(A1,B1:C10,2,FALSE)', '=HLOOKUP(A1,B1:K2,2,TRUE())',
    '=--A1+2^3*5%-1.5E-3', '=A1&"说""你好"""', '=IFERROR(SUM(A1:A1000),0)',
    '=true', '=false', '=SUM($XFD$1048575:$XFD$1048576)'
  ])('accepts explicit local calculation %s', value => {
    expect(validateWpsOperation(formulaOperation(value)).formulas).toEqual([[value]])
  })
  it('admits exactly the documented function set with explicit arities', () => {
    const zero = new Set(['TRUE', 'FALSE'])
    const two = new Set(['IF', 'COUNTIF', 'SUMIF', 'ROUND', 'INDEX', 'MATCH', 'MOD', 'ROUNDUP', 'ROUNDDOWN', 'IFERROR', 'POWER', 'CEILING', 'FLOOR'])
    const three = new Set(['SUMIFS', 'XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'MID'])
    const paired = new Set(['COUNTIFS'])
    for (const name of WPS_FORMULA_FUNCTIONS) {
      const count = zero.has(name) ? 0 : paired.has(name) ? 2 : three.has(name) ? 3 : two.has(name) ? 2 : 1
      expect(() => validateWpsOperation(formulaOperation(`=${name}(${Array(count).fill('1').join(',')})`)), name).not.toThrow()
    }
    expect(new Set(WPS_FORMULA_FUNCTIONS).size).toBe(WPS_FORMULA_FUNCTIONS.length)
    expect(Object.isFrozen(WPS_FORMULA_FUNCTIONS)).toBe(true)
  })
  it.each([
    null, true, 3, '', 'SUM(A1)', ' =SUM(A1)', '=SUM()', '=IF(1)', '=COUNTIFS(A1,1,B1)', '=SUMIFS(A1,B1)',
    '=WEBSERVICE("https://example.test")', '=RTD("server",,"topic")', '=EXEC("calc")', '=CALL("lib","fn")',
    '=cmd|\' /C calc\'!A1', '=SUM([Book.xlsx]Sheet1!A1)', "='[Book.xlsx]Sheet1'!A1", '=SUM(Table1[Column])',
    '=IF(A1="http://example.test",1,0)', '=IF(A1="file:///tmp/file",1,0)', '=IF(A1="\\\\host\\share",1,0)',
    '=_xlfn.SUM(1)', '=_xll.SUM(1)', '=SUM1(1)', '=ſUM(1)', '=MyCustomFunction(1)', '=SomeNamedRange',
    '=INDIRECT("A1")', '=OFFSET(A1,1,1)', '=EVALUATE("1+2")', '=HYPERLINK("x")', '=LAMBDA(x,x)(1)', '=LET(x,1,x)',
    '=A1(1)', '=(A1)(1)', '=INDEX(A1:A1,1)(1)', '=IF(TRUE,A1,A2)(1)', '=XLOOKUP(1,A1:A2,B1:B2)(1)',
    "='S'!SUM(1)", "='S'!A1(1)", "='S1:S3'!A1", '=S1:S3!A1',
    '=A1:B2:C3', '=A1 B1', '=(A1,B1)', '=SUM((A1,B1))', '=A1_name', '=R1C1', '=A0', '=XFE1', '=A1048577',
    '=SUM(A1:A1001)', '=SUMPRODUCT(A1:XFD1048576,A1:XFD1048576)', '=SUM(A:A)', '={1,2}', '=@A1', '=A1#',
    '=SUM(1,,2)', '=SUM(1;2)', '=SUM(A1)+', '=SUM(A1);EXEC("x")', '=SUM(A1)/* comment */', '=SUM(A1)\n+2',
    '=SUM(A1)+"unclosed', "='unclosed!A1", '=1e309', '=IF(A1,"[external]",0)'
  ])('rejects unsupported or externally capable formula %j', value => {
    expect(() => validateWpsOperation(formulaOperation(value))).toThrow(/unsupported formula/)
  })
  it('bounds formula length and nesting, and keeps literal cell clearing on values', () => {
    expect(() => validateWpsOperation(formulaOperation('="' + 'x'.repeat(WPS_MAX_FORMULA_LENGTH) + '"'))).toThrow(/4096/)
    expect(() => validateWpsOperation(formulaOperation('=' + 'SUM('.repeat(40) + '1' + ')'.repeat(40)))).toThrow(/nesting/)
    const clear = { action: 'sheet_write', key: 'document', snapshot: 'snapshot', sheet: '数据', range: 'A1', values: [[null]] }
    expect(validateWpsOperation(clear)).toEqual(clear)
    expect(() => validateWpsOperation(formulaOperation(null))).toThrow(/clear cells with values and null/)
  })
})
