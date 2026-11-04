// Hop dong editor <-> worker cho Qt LSP. Vi tri dung quy uoc LSP (dong/cot tu 0, cot tinh theo UTF-16).
export interface Pos { line: number; character: number }
export interface Range { start: Pos; end: Pos }
export interface Loc { path: string; range: Range; inWorkspace: boolean }

export type Lang = 'python' | 'qml' | 'cpp'
export interface AttachInput { language: Lang; text: string }
export interface AttachOutput {
  ok: boolean
  /** Duong dan tuyet doi file da do ra; null neu khong tim thay */
  path: string | null
  /** So file trung noi dung (>1 nghia la do co the nham) */
  candidates: number
  workspace: string | null
  server: string | null
  message?: string
}

export interface DocInput { path: string; text: string; version: number }
export interface PosInput { path: string; position: Pos }

export interface HoverOutput { markdown: string | null; range: Range | null }
export interface DefinitionOutput { locations: Loc[] }
export interface Completion { label: string; kind: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: Range }
export interface CompletionOutput { items: Completion[]; incomplete: boolean }
export interface Diagnostic { range: Range; severity: number; message: string; source?: string; code?: string | number }
export interface DiagnosticsOutput { version: number; items: Diagnostic[] }
