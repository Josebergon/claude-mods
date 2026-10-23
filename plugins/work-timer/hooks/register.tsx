import { atom, read, update } from 'claude-code'
import type { Register, Timer } from 'claude-code'

import type { Clock } from '../types'

const TICK_MS = 1000
const GAP = 2
const TODAY = 'today'

const clockRef = { plugin: 'work-timer', key: 'clock' } as const
const clock = atom(clockRef, null)
const now = atom({ plugin: 'work-timer', key: 'now' } as const, 0)

type Today = { day: string; ms: number }

function dayOf(ms: number): string {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatMs(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')

  if (h > 0) {
    return `${h}h ${pad(m)}m`
  }

  if (m > 0) {
    return `${m}m ${pad(s)}s`
  }

  return `${s}s`
}

function fresh(day: string, todayMs: number): Clock {
  return { sessionMs: 0, lastMs: null, since: null, waitMs: 0, askedAt: null, day, todayMs }
}

// Time worked in the running turn up to `at`, its waits on the person left out.
function runningMs(c: Clock, at: number): number {
  return c.since === null ? 0 : Math.max(0, at - c.since - c.waitMs)
}

// Today's total as every session has stored it; another day's counts for nothing.
function storedToday(value: unknown, day: string): number {
  const today = value as Today | undefined

  return today?.day === day ? today.ms : 0
}

export const register: Register = on => {
  let ticker: Timer | null = null

  function stopTicking() {
    ticker?.cancel()
    ticker = null
  }

  on('session.start', async ($, e, next) => {
    const at = await $.clock.now()
    const day = dayOf(at)
    const todayMs = storedToday(await $.store.get(TODAY), day)
    await update($, clock, before => (before === null ? fresh(day, todayMs) : { ...before, day, todayMs }))
    await update($, now, () => at)

    // Reloaded mid-turn: the turn's clock is kept, its ticker is not.
    const { value } = await $.state.get(clockRef)
    if (value?.since != null) {
      stopTicking()
      ticker = $.clock.every(TICK_MS, async () => {
        const tick = await $.clock.now()
        await update($, now, () => tick)
      })
    }

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await update($, clock, c =>
        c === null || c.since !== null ? c : { ...c, since: at, waitMs: 0, askedAt: null },
      )
      await update($, now, () => at)
      stopTicking()
      ticker = $.clock.every(TICK_MS, async () => {
        const tick = await $.clock.now()
        await update($, now, () => tick)
      })
    }

    return next(e)
  })

  // A question put to the person stops the clock until it is answered.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    if (e.agentId !== undefined) {
      return next(e)
    }

    const at = await $.clock.now()
    await update($, clock, c => (c === null || c.since === null ? c : { ...c, askedAt: at }))

    try {
      return await next(e)
    } finally {
      const back = await $.clock.now()
      await update($, clock, c =>
        c === null || c.askedAt === null
          ? c
          : { ...c, askedAt: null, waitMs: c.waitMs + (back - c.askedAt) },
      )
    }
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)

    if (e.agentId !== undefined) {
      return result
    }

    stopTicking()
    const at = await $.clock.now()
    const { value } = await $.state.get(clockRef)

    if (value == null || value.since === null) {
      return result
    }

    const worked = runningMs(value, value.askedAt ?? at)
    const day = dayOf(at)
    // Read again at the end: other sessions add to today as well.
    const todayMs = storedToday(await $.store.get(TODAY), day) + worked
    await $.store.set(TODAY, { day, ms: todayMs } satisfies Today)
    await update($, clock, c =>
      c === null
        ? c
        : {
            ...c,
            sessionMs: c.sessionMs + worked,
            lastMs: worked,
            since: null,
            waitMs: 0,
            askedAt: null,
            day,
            todayMs,
          },
    )
    await update($, now, () => at)

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, clock)

    if (e.props.hasSurvey || c === null) {
      return next(e)
    }

    const at = await read($, now)
    const { Box, Text } = $.ui.resolve(e)
    const turnMs = runningMs(c, c.askedAt ?? at)
    const todayMs = (c.day === dayOf(at) ? c.todayMs : 0) + turnMs

    const head =
      c.since === null
        ? { icon: '⏱', word: 'Último turno', ms: c.lastMs, color: 'cyan' }
        : c.askedAt !== null
          ? { icon: '⏸', word: 'Esperándote', ms: turnMs, color: 'blue' }
          : { icon: '⏱', word: 'Trabajando', ms: turnMs, color: 'yellow' }
    const label = head.ms === null ? `${head.icon} Sin turnos aún` : `${head.icon} ${head.word} ${formatMs(head.ms)}`
    const session = `Sesión ${formatMs(c.sessionMs + turnMs)}`
    const today = `Hoy ${formatMs(todayMs)}`

    // One line whatever the width: today gives way first, then the session.
    let room = e.props.bodyColumns - label.length
    const hasSession = room >= GAP + session.length
    room -= hasSession ? GAP + session.length : 0
    const hasToday = room >= GAP + today.length

    return (
      <Box key="work-timer" flexDirection="row" gap={GAP}>
        <Text bold color={head.color} wrap="truncate-end">
          {label}
        </Text>
        {hasSession ? <Text>{session}</Text> : null}
        {hasToday ? <Text dimColor>{today}</Text> : null}
      </Box>
    )
  })
}
