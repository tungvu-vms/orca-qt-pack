declare const __LSP_LANGUAGE__: 'all' | 'python' | 'cpp' | 'qml'
export async function loadLanguageFallbacks(): Promise<void> {
  if (
    typeof __LSP_LANGUAGE__ === 'undefined' ||
    __LSP_LANGUAGE__ === 'all' ||
    __LSP_LANGUAGE__ === 'python'
  )
    await import(
      'monaco-editor/esm/vs/basic-languages/python/python.contribution.js'
    )
  if (
    typeof __LSP_LANGUAGE__ === 'undefined' ||
    __LSP_LANGUAGE__ === 'all' ||
    __LSP_LANGUAGE__ === 'cpp'
  )
    await import('monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js')
}
