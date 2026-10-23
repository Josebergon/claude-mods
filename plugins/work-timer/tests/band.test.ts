import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]
// Noon, so no test crosses midnight in any timezone the machine sits in.
const NOON = new Date(2026, 9, 23, 12).getTime()
const BAND = {
  plugin: 'work-timer',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 5,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 4 },
    view: {},
  },
} as const

const SESSION_ID = 'session-1'

// The mod's store as the engine keeps it, read back by the tests.
let store = new Map<string, unknown>()

// Stands for the engine beneath the mod: the events it hooks, its store, the
// session's id, and a question the person takes 30 seconds to answer.
function engine(on: On, entries: Record<string, unknown> = {}): MockClock {
  const clock = mock.clock(on, { now: NOON })
  store = new Map(Object.entries(entries))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('store.delete', (_, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    await clock.sleep(30_000)

    return { result: { answers: {} }, text: 'answered' }
  })

  return clock
}

// Each part of the band by its key: the state, the chart, the session, today.
async function band($: Engine, surface: Surface, props = {}) {
  const ui = await $.ui.mount({ ...BAND, surface, props: { ...BAND.props, ...props } })
  const part = async (key: string) => ui.find({ key })

  return {
    state: (await part('state'))?.text,
    chart: await part('chart'),
    session: (await part('session'))?.text,
    today: (await part('today'))?.text,
    svgs: await ui.findAll({ type: 'Svg' }),
  }
}

async function turn($: Engine, id: string, agentId?: string) {
  await $.turn.start({ text: 'go', turnId: id, ...(agentId === undefined ? {} : { agentId }) })
}

async function complete($: Engine, id: string, agentId?: string) {
  await $.turn.complete({
    answer: 'ok',
    durationMs: 1,
    isAborted: false,
    turnId: id,
    reason: 'answer',
    ...(agentId === undefined ? {} : { agentId }),
  })
}

test('counts a turn while it runs and once it ends, on every surface', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of SURFACES) {
    expect((await band($, surface)).state).toContain('Sin turnos aún')
  }

  await turn($, 't1')
  await clock.advance(5_000)
  for (const surface of SURFACES) {
    const now = await band($, surface)
    expect(now.state).toContain('Trabajando')
    expect(now.state).toContain('5s')
    expect(now.session).toContain('5s')
  }

  await clock.advance(60_000)
  await complete($, 't1')
  // Time between turns, waiting on the person, is not counted.
  await clock.advance(600_000)
  for (const surface of SURFACES) {
    const now = await band($, surface)
    expect(now.state).toContain('Último turno')
    expect(now.state).toContain('1m 05s')
    expect(now.session).toContain('1m 05s')
    expect(now.today).toContain('1m 05s')
  }
})

test('leaves out a question put to the person, and subagent turns', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, 't1')
  await clock.advance(10_000)
  const asked = $.tool.call({ tool: 'AskUserQuestion', questions: [] })
  await clock.settle()
  expect((await band($, 'desktop')).state).toContain('Esperándote')
  await clock.advance(30_000)
  await asked
  await turn($, 'sub', 'agent-1')
  await clock.advance(20_000)
  await complete($, 'sub', 'agent-1')
  await complete($, 't1')

  expect((await band($, 'desktop')).state).toContain('30s')
})

test('adds to what other sessions stored today', async ($, on) => {
  const day = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  const clock = engine(on, { today: { day: day(NOON), ms: 3_600_000 } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await turn($, 't1')
  await clock.advance(120_000)
  await complete($, 't1')

  const now = await band($, 'desktop')
  expect(now.session).toContain('2m 00s')
  expect(now.today).toContain('1h 02m')
})

test('charts the turns: a drawing on desktop, block bars on the terminal', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // One turn alone draws no chart.
  await turn($, 't1')
  await clock.advance(10_000)
  await complete($, 't1')
  expect((await band($, 'desktop')).chart).toBeUndefined()

  await turn($, 't2')
  await clock.advance(40_000)
  await complete($, 't2')

  const desktop = await band($, 'desktop')
  expect(desktop.chart).toBeDefined()
  expect(desktop.svgs).toHaveLength(1)

  const terminal = await band($, 'terminal')
  expect(terminal.svgs).toHaveLength(0)
  expect(terminal.chart?.text).toBe('▄█')
})

test('drops today, then the chart, then the session as the band narrows', async ($, on) => {
  const clock = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const id of ['t1', 't2']) {
    await turn($, id)
    await clock.advance(30_000)
    await complete($, id)
  }

  const narrow = await band($, 'terminal', { bodyColumns: 48 })
  expect(narrow.today).toBeUndefined()
  expect(narrow.session).toBeDefined()

  const narrowest = await band($, 'terminal', { bodyColumns: 20 })
  expect(narrowest.chart).toBeUndefined()
  expect(narrowest.session).toBeUndefined()
  expect(narrowest.state).toContain('30s')
})

test('shows nothing a survey would fight for', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  // Handed on to the engine, which the test leaves unanswered.
  await expect(
    $.ui.mount({ ...BAND, surface: 'desktop', props: { ...BAND.props, hasSurvey: true } }),
  ).rejects.toThrow('no implementation for ui.render')
})

test('a reopened session carries on from what it saved', async ($, on) => {
  const clock = engine(on, {
    [`session:${SESSION_ID}`]: { sessionMs: 600_000, lastMs: 90_000, turns: [30_000, 90_000], savedAt: NOON },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const reopened = await band($, 'desktop')
  expect(reopened.state).toContain('Último turno')
  expect(reopened.state).toContain('1m 30s')
  expect(reopened.session).toContain('10m 00s')
  expect(reopened.svgs).toHaveLength(1)

  await turn($, 't1')
  await clock.advance(60_000)
  await complete($, 't1')
  expect((await band($, 'desktop')).session).toContain('11m 00s')
})

test('saves the session as each turn ends, and forgets month-old ones', async ($, on) => {
  const clock = engine(on, {
    'session:old': { sessionMs: 1, lastMs: 1, turns: [1], savedAt: NOON - 40 * 24 * 60 * 60 * 1000 },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await clock.advance(45_000)
  await complete($, 't1')

  expect(store.get('session:old')).toBeUndefined()
  expect(store.get(`session:${SESSION_ID}`)).toMatchObject({ sessionMs: 45_000, lastMs: 45_000, turns: [45_000] })
})

test('adds a turn to today once, however many copies hear it end', async ($, on) => {
  const day = (ms: number) => {
    const d = new Date(ms)
    const pad = (n: number) => String(n).padStart(2, '0')

    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }
  // Another copy already counted t1's 20 seconds.
  const clock = engine(on, { today: { day: day(NOON), ms: 20_000, turnIds: ['t1'] } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await clock.advance(20_000)
  await complete($, 't1')

  expect((await band($, 'desktop')).today).toContain('20s')
  expect(store.get('today')).toMatchObject({ ms: 20_000 })
})
