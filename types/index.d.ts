export type Scene = { caption: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'toon-spinner': { scene: Scene | null }
  }
}
