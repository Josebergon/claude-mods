import { atom, read, update } from 'claude-code'
import type { Color, Register, Timer } from 'claude-code'

import type { Clock } from '../types'

const TICK_MS = 1000
const GAP = 2
const TODAY = 'today'
const TURNS = 12
const BARS = '▁▂▃▄▅▆▇█'

// The sparkline on desktop: one bar per turn, the running turn's growing live.
const BAR_W = 4
const BAR_GAP = 2
const CHART_H = 14
const CHART_COLUMNS = 10
// Mid-tones that read on a dark and a light app alike: an SVG cannot see the theme.
const BAR_COLOR = '#8a8a8a'
const ACCENT = '#d97757'

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
  return { sessionMs: 0, lastMs: null, since: null, waitMs: 0, askedAt: null, day, todayMs, turns: [] }
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

function chartText(turns: readonly number[]): string {
  const max = Math.max(1, ...turns)

  return turns
    .map(ms => BARS[Math.min(BARS.length - 1, Math.floor(Math.sqrt(ms / max) * (BARS.length - 1)))])
    .join('')
}

// The last bar is the accent: the running turn, or the one just ended. Heights
// follow the square root, so one long turn leaves the short ones legible.
function chartSvg(turns: readonly number[]): string {
  const max = Math.max(1, ...turns)
  const width = turns.length * (BAR_W + BAR_GAP) - BAR_GAP
  const bars = turns
    .map((ms, i) => {
      const h = Math.max(2, Math.round(Math.sqrt(ms / max) * CHART_H))
      const isLast = i === turns.length - 1

      return `<rect x="${i * (BAR_W + BAR_GAP)}" y="${CHART_H - h}" width="${BAR_W}" height="${h}" rx="1" fill="${isLast ? ACCENT : BAR_COLOR}"${isLast ? '' : ' fill-opacity="0.55"'}/>`
    })
    .join('')

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${CHART_H}" viewBox="0 0 ${width} ${CHART_H}">${bars}</svg>`
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
    // A clock kept from before turns were recorded has none.
    await update($, clock, before =>
      before === null ? fresh(day, todayMs) : { ...before, day, todayMs, turns: before.turns ?? [] },
    )
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
            turns: [...c.turns, worked].slice(-TURNS),
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
    const table = $.ui.resolve(e)
    const { Box, Text } = table
    // The terminal draws no SVG: its chart is a row of block bars.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const isRunning = c.since !== null
    const isAsking = c.askedAt !== null
    const turnMs = runningMs(c, c.askedAt ?? at)
    const todayMs = (c.day === dayOf(at) ? c.todayMs : 0) + turnMs
    const turns = isRunning ? [...c.turns, turnMs].slice(-TURNS) : c.turns

    const state: { word: string; color: Color; ms: number | null } = isAsking
      ? { word: 'Esperándote', color: 'permission', ms: turnMs }
      : isRunning
        ? { word: 'Trabajando', color: 'claude', ms: turnMs }
        : c.lastMs === null
          ? { word: 'Sin turnos aún', color: 'subtle', ms: null }
          : { word: 'Último turno', color: 'success', ms: c.lastMs }
    // The dot breathes with the tick while Claude works.
    const isDim = isRunning && !isAsking && Math.floor(at / TICK_MS) % 2 === 1
    const time = state.ms === null ? '' : formatMs(state.ms)
    const session = formatMs(c.sessionMs + turnMs)
    const today = formatMs(todayMs)

    // One line whatever the width: today gives way first, then the chart, then
    // the session. The chart counts its own columns: bars, or a fixed slot for
    // the drawing.
    const chartColumns = Svg === null ? turns.length : CHART_COLUMNS
    let room = e.props.bodyColumns - (2 + state.word.length + 1 + time.length)
    const hasSession = room >= GAP + 'Sesión '.length + session.length
    room -= hasSession ? GAP + 'Sesión '.length + session.length : 0
    const hasChart = turns.length > 1 && room >= GAP + chartColumns
    room -= hasChart ? GAP + chartColumns : 0
    const hasToday = room >= GAP + 'Hoy '.length + today.length

    return (
      <Box key="work-timer" flexDirection="row" alignItems="center" gap={GAP}>
        <Box key="state" flexDirection="row" alignItems="center" gap={1}>
          <Text color={state.color} dimColor={isDim}>
            ●
          </Text>
          <Text color={state.color} size="caption" weight="medium" wrap="truncate-end">
            {state.word}
          </Text>
          {time === '' ? null : (
            <Text bold weight="semibold" tabular>
              {time}
            </Text>
          )}
        </Box>
        {hasChart ? (
          <Box key="chart">
            {Svg === null ? (
              <Text color={isRunning ? 'claude' : 'subtle'}>{chartText(turns)}</Text>
            ) : (
              <Svg
                source={chartSvg(turns)}
                alt={`Duración de los últimos ${turns.length} turnos`}
                width={turns.length * (BAR_W + BAR_GAP) - BAR_GAP}
                height={CHART_H}
              />
            )}
          </Box>
        ) : null}
        {hasSession ? (
          <Box key="session" flexDirection="row" gap={1}>
            <Text color="subtle" size="caption">
              Sesión
            </Text>
            <Text tabular>{session}</Text>
          </Box>
        ) : null}
        {hasToday ? (
          <Box key="today" flexDirection="row" gap={1}>
            <Text color="subtle" size="caption">
              Hoy
            </Text>
            <Text tabular dimColor>
              {today}
            </Text>
          </Box>
        ) : null}
      </Box>
    )
  })
}
