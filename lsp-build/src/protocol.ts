// Editor <-> worker contract for Qt LSP. Positions follow LSP conventions (0-based line/column, columns in UTF-16 units).
export interface Pos { line: number; character: number }
export interface Range { start: Pos; end: Pos }
/** inWorkspace: a project file (not a library). openable: inside an Orca workspace -> can be opened as a tab (including venv, build). */
export interface Loc { path: string; range: Range; inWorkspace: boolean; openable?: boolean }

export type Lang = 'python' | 'qml' | 'cpp'
/** `hash` = sha1 of the content (CRLF -> LF), so attach stays under the 64 KiB input limit. `text` is for older versions only. */
export interface AttachInput { language: Lang; hash?: string; text?: string; size?: number; sizeCrlf?: number; /** worker -> agent: workspace paths Orca knows on the other machine */ hints?: string[] }
export interface AttachOutput {
  ok: boolean
  /** Absolute path of the resolved file; null if not found */
  path: string | null
  /** Number of files with identical content (>1 means the match may be wrong) */
  candidates: number
  workspace: string | null
  server: string | null
  message?: string
}

/** An edit: offset/length refer to the content BEFORE the edit (UTF-16 units), like Monaco's IModelContentChange. */
export interface TextEdit { offset: number; length: number; text: string }
/** open: `text` (small file) or omitted so the worker reads from disk. change: `edits` (+ `expectLength`) or `text`. */
export interface DocInput { path: string; version: number; text?: string; edits?: TextEdit[]; expectLength?: number }
export interface PosInput { path: string; position: Pos; requestId?: string }

export interface HoverOutput { markdown: string | null; range: Range | null }
export interface DefinitionOutput { locations: Loc[] }
export interface Completion { label: string; kind: number; detail?: string; documentation?: string; insertText?: string; sortText?: string; filterText?: string; range?: Range; snippet?: boolean; additionalTextEdits?: SourceEdit[] }
export interface CompletionOutput { items: Completion[]; incomplete: boolean }
export interface Diagnostic { range: Range; severity: number; message: string; source?: string; code?: string | number }
export interface DiagnosticsOutput { version: number; items: Diagnostic[] }
export interface SourceEdit { range: Range; text: string }
export interface ReferencesOutput { locations: Loc[]; truncated?: boolean }
export interface Signature { label: string; documentation?: string; parameters: { label: string | [number, number]; documentation?: string }[]; activeParameter?: number }
export interface SignatureHelpOutput { signatures: Signature[]; activeSignature: number; activeParameter: number }
export interface DocumentSymbol { name: string; detail: string; kind: number; range: Range; selectionRange: Range; containerName: string; tags?: number[] }
export interface DocumentSymbolsOutput { items: DocumentSymbol[]; truncated?: boolean }
export interface DocumentHighlightsOutput { items: { range: Range; kind: number }[] }
export interface PrepareRenameOutput { range?: Range; placeholder?: string; rejectReason?: string }
export interface RenameOutput { edits: SourceEdit[]; rejectReason?: string }
