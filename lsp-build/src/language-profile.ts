import type { Lang } from './protocol'

declare const __LSP_LANGUAGE__: Lang | 'all'
/** Undefined in generic source tests/legacy tools; fixed at build time in each package. */
export const LANGUAGE_PROFILE =
  typeof __LSP_LANGUAGE__ === 'undefined' ? 'all' : __LSP_LANGUAGE__
export const PLUGIN_ID =
  LANGUAGE_PROFILE === 'all'
    ? 'qt-dev-python-lsp'
    : `${LANGUAGE_PROFILE}-code-intelligence`
export function languageOfPath(path: string): Lang | null {
  return /\.(py|pyi|pyw)$/i.test(path)
    ? 'python'
    : /\.qml$/i.test(path)
      ? 'qml'
      : /\.(cpp|cc|cxx|c\+\+|c|h|hpp|hh|hxx|inl|ipp|tpp|tcc|ixx|cppm)$/i.test(
            path
          )
        ? 'cpp'
        : null
}
export function assertSupportedInput(method: string, input: any): void {
  if (
    LANGUAGE_PROFILE === 'all' ||
    method === 'lsp.peek' ||
    method === 'lsp.reveal'
  )
    return
  const language =
    method === 'lsp.attach'
      ? input?.language
      : typeof input?.path === 'string'
        ? languageOfPath(input.path)
        : null
  if ((method === 'lsp.attach' || input?.path) && language !== LANGUAGE_PROFILE)
    throw new Error(
      `${PLUGIN_ID} supports only ${LANGUAGE_PROFILE}; unsupported language request`
    )
}
