import type { RenderElement } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const LISTING = {
  listing: [
    'This session is my-laptop-10 [165ba5] — the name other sessions use to message it.',
    '',
    'Peer sessions (3):',
    '  claude-42 [c9c1f2]  ·  interactive  ·  idle  ·  started 1h ago',
    '  video-job-8c [0cc848]  ·  interactive  ·  running  ·  started 5m ago',
    '  home-server-quiet-fox [426824]  ·  Remote Control  ·  offline',
  ].join('\n'),
  sections: [
    {
      kind: 'peer',
      total: 3,
      rows: [
        { name: 'claude-42', ref: 'c9c1f2', type: 'interactive', status: 'idle' },
        { name: 'video-job-8c', ref: '0cc848', type: 'interactive', status: 'running' },
        { name: 'home-server-quiet-fox', ref: '426824', type: 'Remote Control', status: 'offline' },
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
    await ui.press({ key: 'tab-sessions' })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ text: /my-laptop-10/ }))?.text).toContain('my-laptop-10')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('claude-42')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('started 1h ago')
    expect((await ui.find({ text: /Remote Control \(other PCs\)/ }))?.text).toContain('(1)')
    expect((await ui.find({ key: 'peer-426824' }))?.text).toContain('offline')

    await ui.press({ key: 'peer-c9c1f2' })
    await ui.input({ key: 'message-0', text: 'are you done with the render?' })

    expect(sent).toEqual([{ to: 'claude-42 [c9c1f2]', text: 'are you done with the render?' }])
    expect(await ui.find({ type: 'Text', text: 'are you done with the render?' })).toBeDefined()

    await $.session.receive({ origin: { kind: 'peer' }, text: REPLY })

    expect(await ui.find({ type: 'Text', text: 'All 12 shots rendered.' })).toBeDefined()
    // a fresh field for the next message
    expect(await ui.find({ key: 'message-1' })).toBeDefined()
  })
}

const REPLY = [
  'Another Claude session sent a message:',
  '<cross-session-message from="uds:\\\\.\\pipe\\LOCAL\\cc-msg-1" from-name="claude-42" from-mode="bypass">',
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
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })
  await $.session.receive({ origin: { kind: 'peer' }, text: REPLY })

  expect((await ui.find({ key: 'inbox-claude-42' }))?.text).toContain('All 12 shots')
  expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('●1')

  await ui.press({ key: 'inbox-claude-42' })

  expect(await ui.find({ key: 'inbox-claude-42' })).toBeUndefined()
  expect((await ui.find({ text: /With claude-42/ }))?.text).toContain('claude-42')
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
  await ui.press({ key: 'tab-sessions' })
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
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })
  await pushed

  expect(pushes).toEqual(['video-job-8c finished'])
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
  await pane.press({ key: 'tab-sessions' })
  await pane.press({ key: 'refresh' })
  expect((await pane.find({ text: /Other PCs \(RC\)/ }))?.text).toContain('(1)')
  expect((await pane.find({ key: 'peer-c9c1f2' }))?.text).toContain('claude-42')

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
    on('session.cwd', () => ({ value: 'C:\\Users\\demo' }))
    on('session.repo', () => ({ value: null }))
    on('env.get', { name: 'COMPUTERNAME' }, () => ({ value: 'DEMO-PC' }))
    // the model's own setting wins over the top-level one
    on('settings.read', () => ({ value: { effortLevel: 'high', modelSettings: { 'claude-opus-5-5': { effortLevel: 'xhigh' } } } }))

    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: { ...PANE_PROPS, bodyColumns: 46 },
    })
    await ui.press({ key: 'tab-sessions' })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ key: 'tab-sessions' }))?.text).toContain('Sessions')
    expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('claude-42')
    expect((await ui.find({ type: 'Text', text: /Opus 5\.5 \[xhigh\]/ }))?.text).toContain('DEMO-PC')
    expect((await ui.find({ type: 'Text', text: /5h 42%/ }))?.text).toContain('in 2h 05m')
    expect((await ui.find({ type: 'Text', text: /7d 18%/ }))?.text).toContain('resets in 3d 4h')
    expect((await ui.find({ type: 'Text', text: /38%/ }))?.text).toContain('(76K / 200K)  $0.42')
  })

  test(`the status line shows the effort the main loop's last request went out with (${surface})`, async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
    on('session.model', () => ({ value: 'claude-opus-5-5' }))
    on('session.repo', () => ({ value: null }))
    on('settings.read', () => ({ value: { effortLevel: 'high' } }))
    on('turn.step', async function* (_$, e) {
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
    })

    // a subagent's request, sent last, leaves it be
    for (const agentId of [undefined, 'a1']) {
      const step = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: agentId === undefined ? 'max' : 'low', messageCount: 1, agentId })
      for await (const chunk of step) void chunk
    }

    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface,
      component: 'Pane',
      requestId: 'session-hub',
      props: { ...PANE_PROPS, bodyColumns: 46 },
    })
    await ui.press({ key: 'tab-sessions' })
    await ui.press({ key: 'refresh' })

    expect((await ui.find({ type: 'Text', text: /Opus 5\.5/ }))?.text).toContain('Opus 5.5 [max]')
  })
}

const ASKED = {
  questions: [
    {
      question: 'Push to the repo now?',
      header: 'Push',
      options: [
        { label: 'Push', description: 'Send it up' },
        { label: 'Wait', description: 'Not yet' },
      ],
      multiSelect: false,
    },
  ],
}

test('a question this session asks is marked for the other sessions while it is up', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\someone' })
  on('session.id', () => ({ value: 'sess-a' }))
  on('session.cwd', () => ({ value: 'C:\\work\\demo' }))
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  let whileUp: typeof writes = []
  on('tool.call', { tool: 'AskUserQuestion' }, () => {
    whileUp = [...writes]
    return { result: { ...ASKED, answers: {} } }
  })

  await $.tool.call({ tool: 'AskUserQuestion', ...ASKED })

  expect(whileUp).toHaveLength(1)
  expect(whileUp[0]?.path.replace(/\\/g, '/')).toBe('C:/Users/someone/.claude/session-hub/waiting/sess-a.json')
  expect(JSON.parse(whileUp[0]?.text ?? '{}')).toMatchObject({
    id: 'sess-a',
    cwd: 'C:\\work\\demo',
    kind: 'question',
    detail: 'Push to the repo now?',
  })
  // answered, the marker is emptied
  expect(writes.at(-1)?.text).toBe('')
})

test('a permission prompt is marked until its call is done', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\someone' })
  on('session.id', () => ({ value: 'sess-a' }))
  const writes: string[] = []
  on('fs.write', (_$, e) => {
    writes.push(e.text)
    return { value: undefined }
  })
  // no settings hook answers, so the prompt shows
  on('classic.PermissionRequest', () => ({}))
  let whileUp: string[] = []
  on('tool.call', { tool: 'Bash' }, async () => {
    // the engine asks inside the call, as the prompt shows
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'git push -u origin main' } })
    whileUp = [...writes]
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'git push -u origin main' })

  expect(whileUp).toHaveLength(1)
  expect(JSON.parse(whileUp[0] ?? '{}')).toMatchObject({ kind: 'permission', detail: 'Bash: git push -u origin main' })
  expect(writes.at(-1)).toBe('')
})

test('a session waiting on you shows in the panel, a stale marker does not', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:\\Users\\someone' })
  on('session.id', () => ({ value: 'sess-a' }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  const markers: Record<string, string> = {
    'sess-b.json': JSON.stringify({
      id: 'sess-b',
      name: 'claude-42',
      ref: 'c9c1f2',
      cwd: 'C:\\work\\demo',
      kind: 'question',
      detail: 'Push to the repo now?',
      since: 990_000,
      at: 998_000,
    }),
    // its session died mid-dialog: no heartbeat for a minute
    'sess-c.json': JSON.stringify({
      id: 'sess-c',
      name: 'video-job-8c',
      ref: '0cc848',
      cwd: null,
      kind: 'permission',
      detail: 'Bash: rm -rf build',
      since: 900_000,
      at: 940_000,
    }),
    'sess-d.json': '',
  }
  on('fs.list', () => ({
    value: Object.entries(markers).map(([name, text]) => ({
      name,
      kind: 'file' as const,
      size: text.length,
      mtimeMs: 0,
      isLink: false,
    })),
  }))
  // the engine hands the path on with Windows separators
  on('fs.read', (_$, e) => ({ value: markers[e.path.split(/[\\/]/).at(-1) ?? ''] ?? '' }))

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ key: 'tab-sessions' }))?.text).toContain('?1')
  expect((await ui.find({ key: 'needs-sess-b' }))?.text).toContain('asking you: Push to the repo now?')
  expect((await ui.find({ key: 'peer-c9c1f2' }))?.text).toContain('asking you')
  expect(await ui.find({ key: 'needs-sess-c' })).toBeUndefined()
  expect((await ui.find({ key: 'peer-0cc848' }))?.text).toContain('running')

  await ui.press({ key: 'needs-sess-b' })
  expect((await ui.find({ type: 'Text', text: /answer it in that session/ }))?.text).toContain('Push to the repo now?')
})

test('the pencil beside a session on this PC asks it to rename itself', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/someone' })
  on('session.id', () => ({ value: 'sess-a' }))
  let listing = LISTING
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: listing }))
  on('session.receive', (_$, e) => ({ text: e.text }))
  const writes: { path: string; text: string }[] = []
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path.replace(/\\/g, '/'), text: e.text })
    return { value: undefined }
  })

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })

  // Remote Control sessions share no folder with this PC
  expect(await ui.find({ key: 'rename-426824' })).toBeUndefined()
  await ui.press({ key: 'rename-c9c1f2' })
  await ui.input({ key: 'rename-input-c9c1f2', text: '  render   box ' })

  const asked = writes.find(w => w.path.endsWith('/session-hub/rename/c9c1f2.json'))
  expect(JSON.parse(asked?.text ?? '{}')).toMatchObject({ ref: 'c9c1f2', name: 'claude-42', to: 'render box' })
  expect((await ui.find({ type: 'Text', text: /Asked claude-42/ }))?.text).toContain('render box')

  // it renamed: the same ref under the new name, and its thread follows it
  await $.session.receive({ origin: { kind: 'peer' }, text: REPLY })
  listing = {
    ...LISTING,
    listing: LISTING.listing.replace('claude-42', 'render box'),
    sections: LISTING.sections.map(section => ({
      ...section,
      rows: section.rows.map(row => (row.ref === 'c9c1f2' ? { ...row, name: 'render box' } : row)),
    })),
  }
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })

  expect((await ui.find({ type: 'Text', text: /Renamed claude-42/ }))?.text).toContain('render box')
  expect((await ui.find({ key: 'inbox-render box' }))?.text).toContain('All 12 shots')
})

test('a request named for this session runs /rename once and empties it', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.env(on, { USERPROFILE: 'C:/Users/someone' })
  on('session.id', () => ({ value: 'sess-a' }))
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  const ask = JSON.stringify({ ref: '165ba5', name: 'my-laptop-10', to: 'hub', at: 990_000 })
  const other = JSON.stringify({ ref: 'c9c1f2', name: 'claude-42', to: 'not me', at: 990_000 })
  const files: Record<string, string> = { '165ba5.json': ask, 'c9c1f2.json': other }
  on('fs.list', (_$, e) => ({
    value: /rename$/.test(e.path)
      ? Object.entries(files).map(([name, text]) => ({ name, kind: 'file' as const, size: text.length, mtimeMs: 0, isLink: false }))
      : [],
  }))
  on('fs.read', (_$, e) => ({ value: files[e.path.split(/[\\/]/).at(-1) ?? ''] ?? '' }))
  on('fs.write', (_$, e) => {
    files[e.path.split(/[\\/]/).at(-1) ?? ''] = e.text
    return { value: undefined }
  })
  const ran: { command: string; args?: string }[] = []
  on('command.run', (_$, e) => {
    ran.push({ command: e.command, args: e.args })
    return { text: '' }
  })

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'tab-sessions' })
  await ui.press({ key: 'refresh' })

  expect(ran).toEqual([{ command: 'rename', args: 'hub' }])
  expect(files['165ba5.json']).toBe('')
  expect(files['c9c1f2.json']).toBe(other)
})

test('the Links tab lists the paths and web links an answer named and the files written', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  on('tool.call', { tool: 'Write' }, () => ({ result: { type: 'create', filePath: 'C:/out/report.md', content: '' } }))
  on('turn.complete', () => ({ text: '' }))

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await $.tool.call({ tool: 'Write', file_path: 'C:/out/report.md', content: '# hi' })
  await $.turn.complete({
    answer: 'Saved the render to C:/renders/cat.png. Preview: https://example.com/view?id=7.',
    durationMs: 1_000,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })
  await ui.press({ key: 'tab-links' })

  expect((await ui.find({ key: 'tab-links' }))?.text).toContain('3')
  expect((await ui.find({ key: 'link-0' }))?.text).toContain('C:/renders/cat.png')
  expect((await ui.find({ key: 'link-1' }))?.text).toContain('https://example.com/view?id=7')
  expect((await ui.find({ key: 'link-2' }))?.text).toContain('C:/out/report.md')
})

test('the Tasks tab opens first and splits doing, next and done', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  let made = 0
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => {
    made += 1
    return { result: { task: { id: String(made), subject: e.subject } } }
  })
  on('tool.call', { tool: 'TaskUpdate' }, (_$, e) => ({
    result: { success: true, taskId: e.taskId, updatedFields: ['status'] },
  }))

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  for (const subject of ['Read the config', 'Add the Tasks tab', 'Run the tests']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  expect((await ui.find({ key: 'tab-tasks' }))?.text).toContain('1/3')
  expect((await ui.find({ key: 'doing' }))?.text).toContain('Add the Tasks tab')
  expect((await ui.find({ key: 'next' }))?.text).toContain('Run the tests')
  expect((await ui.find({ key: 'done' }))?.text).toContain('Read the config')
})

test(
  'the Services tab shows a ComfyUI GPU and queue, and a host that does not answer as down',
  { options: { services: 'gpu=http://pc:8188, nas=http://nas:9000' } },
  async ($, on) => {
    mock.clock(on, { now: 1_000_000 })
    on('http.fetch', (_$, e) => {
      if (e.url === 'http://pc:8188/system_stats') {
        const devices = [{ name: 'cuda:0 NVIDIA GeForce RTX 5070 : cudaMallocAsync', vram_total: 12 * 1024 ** 3, vram_free: 9 * 1024 ** 3 }]
        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ devices }) } }
      }
      if (e.url === 'http://pc:8188/queue') {
        return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ queue_running: [[1]], queue_pending: [[2], [3]] }) } }
      }
      return { deny: 'connection refused' }
    })

    const ui = await $.ui.mount({
      plugin: 'session-hub',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'session-hub',
      props: PANE_PROPS,
    })
    await ui.press({ key: 'tab-services' })
    await ui.press({ key: 'services-check' })

    const gpu = (await ui.find({ key: 'svc-gpu' }))?.text
    expect(gpu).toContain('up')
    expect(gpu).toContain('RTX 5070 · 9.0/12.0 GB free · ▶ busy +2 queued')
    expect((await ui.find({ key: 'svc-nas' }))?.text).toContain('down')
  },
)

test('an approved plan lists its steps under Next until real tasks arrive', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const plan = ['# Panel plan', '', 'Context first.', '', '1. Read the **config** file', '2. Add the `Tasks` tab', '   - a sub-point', '3. Run the tests'].join('\n')
  on('tool.call', { tool: 'ExitPlanMode' }, () => ({ result: { plan, isAgent: false } }))
  on('tool.call', { tool: 'TaskCreate' }, (_$, e) => ({ result: { task: { id: '1', subject: e.subject } } }))

  const ui = await $.ui.mount({
    plugin: 'session-hub',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'session-hub',
    props: PANE_PROPS,
  })
  await $.tool.call({ tool: 'ExitPlanMode' })

  const next = (await ui.find({ key: 'next' }))?.text
  expect(next).toContain('(3)')
  expect(next).toContain('Read the config file')
  expect(next).toContain('Add the Tasks tab')
  expect(next).not.toContain('sub-point')

  await $.tool.call({ tool: 'TaskCreate', subject: 'Read the config', description: '' })
  expect((await ui.find({ key: 'next' }))?.text).toContain('(1)')
})

test('a new session opens the panel by itself', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: LISTING }))
  const opens: string[] = []
  on('ui.open', (_$, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))

  await $.session.start({ cwd: 'C:/work', surface: 'terminal', isInteractive: true })
  await clock.settle()
  await clock.advance(2_000)
  await clock.settle()

  expect(opens).toEqual(['session-hub'])
})
