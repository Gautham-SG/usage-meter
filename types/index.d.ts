export type Limit = { kind: string; percentUsed: number; resetsAt?: string }
export type Snapshot = {
  limits: Limit[]
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number
  costUsd: number | null
  startedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meter': {
      snapshot: Shaped<Snapshot | null>
      isHidden: boolean
      frame: number
    }
  }
}
