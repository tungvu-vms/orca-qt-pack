// Hop dong editor <-> worker cho Qt LSP. Vi tri dung quy uoc LSP (dong/cot tu 0, cot tinh theo UTF-16).
export interface Pos { line: number; character: number }
export interface Range { start: Pos; end: Pos }
export interface Loc { path: string; range: Range; inWorkspace: boolean }

export type Lang = 'python' | 'qml' | 'cpp'
/** `hash` = sha1 noi dung (CRLF -> LF), de khong vuot gioi han tin ~1 MiB voi file lon. `text` chi cho ban cu. */
export interface AttachInput { language: Lang; hash?: string; text?: string; size?: number; sizeCrlf?: number }
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

/** Sua doi: offset/length tinh tren noi dung TRUOC khi sua (don vi UTF-16), nhu Monaco IModelContentChange. */
export interface TextEdit { offset: number; length: number; text: string }
/** open: `text` (file nho) hoac bo trong de worker doc tu dia. change: `edits` (+ `expectLength`) hoac `text`. */
export interface DocInput { path: string; version: number; text?: string; edits?: TextEdit[]; expectLength?: number }
export interface PosInput { path: string; position: Pos }

export interface HoverOutput { markdown: string | null; range: Range | null }
export interface DefinitionOutput { locations: Loc[] }
export interface Completion { label: string; kind: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: Range }
export interface CompletionOutput { items: Completion[]; incomplete: boolean }
export interface Diagnostic { range: Range; severity: number; message: string; source?: string; code?: string | number }
export interface DiagnosticsOutput { version: number; items: Diagnostic[] }
