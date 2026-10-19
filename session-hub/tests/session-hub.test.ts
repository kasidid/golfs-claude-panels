import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const LISTING = {
  listing: [
    'This session is wren-10 [165ba5] — the name other sessions use to message it.',
    '',
    'Peer sessions (3):',
    '  nova-73 [c9c1f2]  ·  interactive  ·  idle  ·  started 1h ago',
    '  sable-8c [0cc848]  ·  interactive  ·  running  ·  started 5m ago',
    '  jans-home-server-cedar-fox [426824]  ·  Remote Control  ·  offline',
  ].join('\n'),
  sections: [
    {
      kind: 'peer',
      total: 3,
      rows: [
        { name: 'nova-73', ref: 'c9c1f2', type: 'interactive', status: 'idle' },
        { name: 'sable-8c', ref: '0cc848', type: 'interactive', status: 'running' },
        { name: 'jans-home-server-cedar-fox', ref: '426824', type: 'Remote Control', status: 'offline' },
      ],
    },
  ],
}

const PANE_PROPS = {
  title: 'Sessions',
  isFocused: true,
  bodyColumns: 90,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane groups local and Remote Control sessions and sends a message (${surface})`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
    const sent: { to: string; text: string }[] = []
    on('session.send', (_$, e) => {
      sent.push({ to: e.to, text: e.text })
      return { isDelivered: true as const }
    })
    on('session.receive', (_$, e) => ({ text: e.text }))

    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: PANE_PROPS,
    })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ text: /wren-10/ }))?.text).toContain('wren-10')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('nova-73')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('started 1h ago')
    expect((await ui.find({ text: /Remote Control \(other PCs\)/ }))?.text).toContain('(1)')
    expect((await ui.find({ key: 'peer-426824' }))?.text).toContain('offline')

    await ui.press({ key: 'peer-c9c1f2' })
    await ui.input({ key: 'message-0', text: 'are you done with the render?' })

    expect(sent).toEqual([{ to: 'nova-73 [c9c1f2]', text: 'are you done with the render?' }])
    expect(await ui.find({ type: 'Text', text: 'are you done with the render?' })).toBeDefined()

    await $.session.receive({ origin: { kind: 'peer' }, text: REPLY })

    expect(await ui.find({ type: 'Text', text: 'All 12 shots rendered.' })).toBeDefined()
    // a fresh field for the next message
    expect(await ui.find({ key: 'message-1' })).toBeDefined()
  })
}

const REPLY = [
  'Another Claude session sent a message:',
  '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1" from-name="nova-73" from-mode="bypass">',
  'All 12 shots rendered.',
  '</cross-session-message>',
].join('\n')

test('an unread reply waits in the inbox and opens its thread', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  on('session.receive', (_$, e) => ({ text: e.text }))

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: { ...PANE_PROPS, bodyColumns: 36 },
  })
  await ui.press({ key: 'refresh' })
  await $.session.receive({ origin: { kind: 'peer' }, text: REPLY })

  expect((await ui.find({ key: 'inbox-nova-73' }))?.text).toContain('All 12 shots')
  expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('●1')

  await ui.press({ key: 'inbox-nova-73' })

  expect(await ui.find({ key: 'inbox-nova-73' })).toBeUndefined()
  expect((await ui.find({ text: /With nova-73/ }))?.text).toContain('nova-73')
  expect(await ui.find({ type: 'Text', text: 'All 12 shots rendered.' })).toBeDefined()
})

test('a long turn pushes, a short one does not', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const pushes: string[] = []
  let markPushed: () => void = () => undefined
  const pushed = new Promise<void>(resolve => {
    markPushed = resolve
  })
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    pushes.push(e.message)
    markPushed()
    return { result: { message: e.message, pushSent: true } }
  })
  on('turn.complete', () => ({ text: '' }))

  await $.turn.complete({ answer: 'Short.', durationMs: 5_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await clock.advance(10)
  expect(pushes).toEqual([])

  await $.turn.complete({
    answer: 'Rendered all 12 shots.\nDetails below.',
    durationMs: 180_000,
    isAborted: false,
    turnId: 't2',
    reason: 'answer',
  })
  await clock.advance(10)
  await pushed

  expect(pushes).toHaveLength(1)
  expect(pushes[0]).toContain('done after 3m')
  expect(pushes[0]).toContain('Rendered all 12 shots.')
})

test('a peer going from running to idle pings once', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let listing = LISTING
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: listing }))
  const pushes: string[] = []
  let markPushed: () => void = () => undefined
  const pushed = new Promise<void>(resolve => {
    markPushed = resolve
  })
  on('tool.call', { tool: 'PushNotification' }, (_$, e) => {
    pushes.push(e.message)
    markPushed()
    return { result: { message: e.message, pushSent: true } }
  })

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'refresh' })
  expect(pushes).toEqual([])

  listing = {
    ...LISTING,
    listing: LISTING.listing.replace('running', 'idle'),
    sections: LISTING.sections.map(section => ({
      ...section,
      rows: section.rows.map(row => (row.ref === '0cc848' ? { ...row, status: 'idle' } : row)),
    })),
  }
  await ui.press({ key: 'refresh' })
  await pushed

  expect(pushes).toEqual(['sable-8c finished'])
})

test('in fullscreen the sidebar docks on the right and replaces the band', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  const opens: { id: string; columns?: number }[] = []
  on('ui.open', (_$, e) => {
    opens.push({ id: e.id, columns: e.columns })
    return { value: { isPlaced: true as const } }
  })
  // stands for the engine's own empty band
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return h(Box, { key: 'engine-band' }) as RenderElement
  })

  const pane = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: { ...PANE_PROPS, bodyColumns: 36 },
  })
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ text: /Other PCs \(RC\)/ }))?.text).toContain('(1)')
  expect((await pane.find({ key: 'peer-c9c1f2' }))?.text).toContain('nova-73')

  const band = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 10 }, view: {} },
    viewport: { columns: 160, rows: 50, isFullscreen: true },
  })
  await clock.advance(10)
  await clock.settle()

  // 30% of 160 columns, less the frame and the gap: a 7:3 split
  expect(opens).toEqual([{ id: 'session-hub', columns: 45 }])
  expect(await band.find({ key: 'open' })).toBeUndefined()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`docked, the panel shows a Sessions tab above and the status line below (${surface})`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
    on('session.usage', () => ({
      value: {
        startedAt: 0,
        context: { tokens: 76_000, window: 200_000, percent: 38 },
        rateLimits: [
          { kind: 'five_hour', percentUsed: 42, resetsAt: new Date(1_000_000 + 125 * 60_000).toISOString() },
          // unix seconds, as the status line's JSON carries it: 3 days 4 hours on
          { kind: 'seven_day', percentUsed: 18, resetsAt: String(1_000 + 76 * 3_600) },
        ],
        cost: { usd: 0.42 },
      },
    }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.cwd', () => ({ value: 'C:\\Users\\wren' }))
    on('session.repo', () => ({ value: null }))
    on('env.get', { name: 'COMPUTERNAME' }, () => ({ value: 'WREN-PC' }))
    on('settings.read', () => ({ value: { effortLevel: 'high' } }))

    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: { ...PANE_PROPS, bodyColumns: 46 },
    })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'tab-sessions' }))?.text).toContain('Sessions')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('nova-73')
    expect((await ui.find({ type: 'Text', text: /Opus 5\.5 \[high\]/ }))?.text).toContain('WREN-PC')
    expect((await ui.find({ type: 'Text', text: /5h 42%/ }))?.text).toContain('in 2h 05m')
    expect((await ui.find({ type: 'Text', text: /7d 18%/ }))?.text).toContain('resets in 3d 4h')
    expect((await ui.find({ type: 'Text', text: /38%/ }))?.text).toContain('(76K / 200K)  $0.42')
  })
}
