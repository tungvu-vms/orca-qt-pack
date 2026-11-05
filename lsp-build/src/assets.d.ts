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
