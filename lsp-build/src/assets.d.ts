declare module '*?worker' {
  const WorkerConstructor: new () => Worker
  export default WorkerConstructor
}
declare module '*.wasm' {
  const base64: string
  export default base64
}
// Monaco's pinned internal service modules do not ship declarations.
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  export const StandaloneServices: { get(service: unknown): any }
}
declare module 'monaco-editor/esm/vs/platform/configuration/common/configuration.js' {
  export const IConfigurationService: unknown
}
declare module 'monaco-editor/esm/vs/platform/commands/common/commands.js' {
  export const ICommandService: unknown
}
declare module 'monaco-editor/esm/vs/editor/common/services/resolverService.js' {
  export const ITextModelService: unknown
}
declare module 'monaco-editor/esm/vs/editor/common/languages.js' {
  export const TokenizationRegistry: { register(lang: string, support: any): { dispose(): void }; get(lang: string): any; getOrCreate(lang: string): Promise<any> }
}
declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneLanguages.js' {
  export const TokenizationSupportAdapter: any
}
declare module 'monaco-editor/esm/vs/editor/common/languages/language.js' {
  export const ILanguageService: unknown
}
declare module 'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js' {
  export const IStandaloneThemeService: unknown
}
declare module 'monaco-editor/esm/vs/editor/common/tokens/contiguousMultilineTokensBuilder.js' {
  export const ContiguousMultilineTokensBuilder: any
}
