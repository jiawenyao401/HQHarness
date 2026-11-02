export declare const WPS_TOOL_NAME: 'mcp__huaqing_wps__wps_use'
export declare const WPS_RAW_TOOL_NAME: 'wps_use'
export declare const WPS_MAX_OPERATION_BYTES: 65536
export declare const WPS_MAX_CELLS: 1000
export declare const WPS_MAX_FORMULA_LENGTH: 4096
export declare const WPS_FORMULA_FUNCTIONS: readonly string[]
export declare const WPS_READ_ACTIONS: readonly ['status', 'documents', 'inspect', 'sheet_read', 'recover']
export declare const WPS_WRITE_ACTIONS: readonly ['sheet_write', 'writer_replace', 'slide_text', 'save']
export declare const WPS_INPUT_SCHEMA: Record<string, unknown>
export type WpsScalar = string | number | boolean | null
export type WpsMatrix = WpsScalar[][]
export type WpsOperation =
  | { action: 'status' | 'documents' }
  | { action: 'inspect' | 'recover'; key: string }
  | { action: 'sheet_read'; key: string; sheet: string; range: string }
  | ({ action: 'sheet_write'; key: string; snapshot: string; sheet: string; range: string } & ({ values: WpsMatrix; formulas?: never } | { formulas: string[][]; values?: never }))
  | { action: 'writer_replace'; key: string; snapshot: string; oldText: string; replaceText: string }
  | { action: 'slide_text'; key: string; snapshot: string; slideId: number; shapeId: number; text: string }
  | { action: 'save'; key: string; snapshot: string }
export interface WpsPolicy { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
export interface WpsCallMeta { owner: string; policy: WpsPolicy }
export type WpsDiagnosticType = 'null' | 'boolean' | 'number' | 'string'
export interface WpsReadbackDiagnostic {
  phase: 'cell' | 'final'
  ordinal: number
  mismatchFields: ('value' | 'formula' | 'numberFormat' | 'hasFormula')[]
  expectedTypes: { value: WpsDiagnosticType | 'not_checked'; formula: WpsDiagnosticType; numberFormat: 'string'; hasFormula: 'boolean' }
  observedTypes: { value: WpsDiagnosticType; formula: WpsDiagnosticType; numberFormat: 'string'; hasFormula: 'boolean' }
}
export interface WpsFailureDetails { causeCode?: string; completed?: number; diagnostic?: WpsReadbackDiagnostic }
export declare function readWpsFailureDetails(value: unknown): WpsFailureDetails
export declare function validateWpsOperation(value: unknown): WpsOperation
export declare function validateWpsCallMeta(value: unknown): WpsCallMeta
