// The working clock of the main loop. `since` is set while a turn runs; `waitMs`
// is that turn's time spent waiting on the person (questions put to them).
export type Clock = {
  sessionMs: number
  lastMs: number | null
  since: number | null
  waitMs: number
  askedAt: number | null
  totalMs: number
  turns: number[]
}

declare module 'claude-code' {
  interface PluginState {
    'work-timer': { clock: Clock | null; now: number }
  }
}
