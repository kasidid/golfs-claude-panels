import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { PanelLimit, PanelStatus, PanelTab, Peer, PeerGroup, PeerMessage } from '../types'

// the id stays the sessions pane's, so the 110-column floor it earned carries over
const PANE = 'session-hub'
const PANE_TITLE = 'Panel'

const peers = atom({ plugin: 'session-hub', key: 'peers' } as const, [])
const self = atom({ plugin: 'session-hub', key: 'self' } as const, null)
const surfaces = atom({ plugin: 'session-hub', key: 'surfaces' } as const, [])
const messages = atom({ plugin: 'session-hub', key: 'messages' } as const, [])
const target = atom({ plugin: 'session-hub', key: 'target' } as const, null)
const note = atom({ plugin: 'session-hub', key: 'note' } as const, null)
const updatedAt = atom({ plugin: 'session-hub', key: 'updatedAt' } as const, 0)
const isManual = atom({ plugin: 'session-hub', key: 'isManual' } as const, false)
const isDocked = atom({ plugin: 'session-hub', key: 'isDocked' } as const, false)
const isSidebarDismissed = atom({ plugin: 'session-hub', key: 'isSidebarDismissed' } as const, false)
const tab = atom({ plugin: 'session-hub', key: 'tab' } as const, 'sessions')
const status = atom({ plugin: 'session-hub', key: 'status' } as const, null)

const SIDEBAR_COLUMNS = 38
const KEPT_MESSAGES = 100
const SHOWN_IN_THREAD = 6
const MESSAGE_CHARS = 2000
// the tab row and the rule under it
const TAB_ROWS = 2
// a thread's own lines around its messages: title, "earlier", input, buttons, refresh mode
const THREAD_CHROME_ROWS = 8

const TABS: readonly { id: PanelTab; label: string; hotkey: string }[] = [
  { id: 'sessions', label: 'Sessions', hotkey: '1' },
]

// the status line script's "Aurora Full Sweep", one colour per row here
const SWEEP: readonly [number, number, number][] = [
  [0xb1, 0x4e, 0xff],
  [0x00, 0xe5, 0xff],
  [0xff, 0x2e, 0x9e],
  [0xff, 0xd2, 0x3f],
]

// Nerd Font glyphs as statusline-command.ps1 draws them; the terminal alone has the font
const ICONS = {
  model: ' ',
  host: ' ',
  folder: ' ',
  wallet: ' ',
  calendar: ' ',
  context: ' ',
  branch: '⎇ ',
}
const NO_ICONS: typeof ICONS = { model: '', host: '', folder: '', wallet: '', calendar: '', context: 'ctx ', branch: '' }

const GROUPS: readonly { group: PeerGroup; label: string; short: string }[] = [
  { group: 'local', label: 'On this PC', short: 'This PC' },
  { group: 'remote', label: 'Remote Control (other PCs)', short: 'Other PCs (RC)' },
  { group: 'cloud', label: 'Cloud', short: 'Cloud' },
]

// Statuses ListAgents has shown so far are idle and offline; anything that
// reads as in-progress counts as working, so an unknown word never fakes a finish.
const BUSY = /running|busy|working|thinking|pending/i
const GONE = /offline|exited|ended|stopped/i
const isBusy = (peer: Peer) => BUSY.test(peer.status)
const isOnline = (peer: Peer) => !GONE.test(peer.status)

// "  nova-73 [c9c1f2]  ·  interactive  ·  idle  ·  started 1h ago"
const ROW = /^\s+(.+?) \[(\w+)\]\s+·\s+([^·]+?)\s+·\s+([^·]+?)(?:\s+·\s+(.+?))?\s*$/
const SELF = /This session is (.+?) \[(\w+)\]/

type Listing = {
  listing: string
  sections?: {
    kind: string
    rows: { name?: string; ref?: string; id?: string; type?: string; status?: string }[]
  }[]
}

function groupOf(type: string): PeerGroup {
  if (/remote/i.test(type)) return 'remote'
  if (/cloud/i.test(type)) return 'cloud'
  return 'local'
}

function parseListing(result: Listing): { self: string | null; peers: Peer[] } {
  const fromText = new Map<string, Peer>()
  for (const line of result.listing.split('\n')) {
    const m = ROW.exec(line)
    if (!m) continue
    const type = (m[3] ?? '').trim()
    const ref = m[2] ?? ''
    fromText.set(ref, {
      name: m[1] ?? ref,
      ref,
      group: groupOf(type),
      type,
      status: (m[4] ?? 'unknown').trim(),
      started: m[5]?.trim() ?? null,
    })
  }

  const rows = (result.sections ?? []).flatMap(section =>
    section.rows.map(row => ({ ...row, type: row.type ?? section.kind })),
  )
  const list: Peer[] =
    rows.length === 0
      ? [...fromText.values()]
      : rows
          .filter(row => row.name !== undefined)
          .map(row => {
            const ref = row.ref ?? row.id ?? row.name ?? ''
            return {
              name: row.name ?? ref,
              ref,
              group: groupOf(row.type),
              type: row.type,
              status: row.status ?? fromText.get(ref)?.status ?? 'unknown',
              started: fromText.get(ref)?.started ?? null,
            }
          })

  return { self: SELF.exec(result.listing)?.[1] ?? null, peers: list }
}

const firstLine = (text: string) =>
  text
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''

const clip = (text: string, max: number) =>
  text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text

// A peer's delivery reads "<cross-session-message from=… from-name="nova-73" …>body</…>";
// the origin carries the same name and body at run time, though its type does not say so.
const ENVELOPE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/

function parseDelivery(text: string, origin: Record<string, unknown>) {
  const m = ENVELOPE.exec(text)
  const named = /from-name="([^"]*)"/.exec(m?.[1] ?? text)?.[1]
  const from = typeof origin.name === 'string' ? origin.name : named ?? 'another session'
  const body = typeof origin.body === 'string' ? origin.body : m?.[2] ?? text

  return { from, body: body.trim() }
}

const isUnread = (message: PeerMessage) => !message.isOutgoing && !message.isRead

function clockTime(ms: number) {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function minutes(ms: number) {
  const s = Math.round(ms / 1000)
  return s < 90 ? `${s}s` : `${Math.round(s / 60)}m`
}

// rows a text takes wrapped at `width`
function rowsOf(text: string, width: number) {
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / Math.max(1, width))), 0)
}

// The newest messages that fit in `rows`, so the status box stays on screen;
// the newest alone is cut to fit when it does not.
function fitThread(thread: PeerMessage[], rows: number, width: number) {
  const shown: { message: PeerMessage; text: string }[] = []
  let used = 0
  for (const message of [...thread].reverse()) {
    if (shown.length === SHOWN_IN_THREAD) break
    const text = clip(message.text, MESSAGE_CHARS)
    // the gap and the sender's line above each one
    const cost = 2 + rowsOf(text, width)
    if (shown.length === 0 && cost > rows) {
      shown.unshift({ message, text: clip(text, Math.max(1, rows - 2) * width) })
      break
    }
    if (used + cost > rows) break
    shown.unshift({ message, text })
    used += cost
  }

  return shown
}

// "claude-opus-5-5" reads "Opus 5.5"; a name /model already spells out passes as it is
function modelName(id: string) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const family = m?.[1]
  if (m === null || family === undefined) return id
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${m[2] ?? ''}${m[3] === undefined ? '' : `.${m[3]}`}`
}

// "## main...origin/main [ahead 1]", "## No commits yet on main"
function parseBranch(head: string) {
  return /^## (?:No commits yet on )?(.+?)(?:\.\.\.| \[|$)/.exec(head)?.[1] ?? null
}

// the colour `index` of `count` rows takes along the sweep
function sweep(index: number, count: number) {
  const pos = (count > 1 ? index / (count - 1) : 0) * (SWEEP.length - 1)
  const k = Math.min(Math.floor(pos), SWEEP.length - 2)
  const from = SWEEP[k]
  const to = SWEEP[k + 1]
  if (from === undefined || to === undefined) return 'white'
  const channels = from.map((c, i) => Math.round(c + ((to[i] ?? c) - c) * (pos - k)))

  return `#${channels.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

function bar(percent: number) {
  const filled = Math.min(10, Math.max(0, Math.floor(percent / 10)))
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function limitText(limit: PanelLimit, now: number, icons: typeof ICONS) {
  const used = `${Math.round(limit.percentUsed)}%`
  // an ISO time, or the unix seconds the status line's JSON carries
  const stamp = limit.resetsAt === null ? Number.NaN : Number(limit.resetsAt)
  const at =
    limit.resetsAt === null
      ? Number.NaN
      : Number.isFinite(stamp)
        ? stamp < 1e12
          ? stamp * 1000
          : stamp
        : Date.parse(limit.resetsAt)
  const left = Math.max(0, at - now)
  const hours = Math.floor(left / 3_600_000)
  if (limit.kind === 'five_hour') {
    const mins = String(Math.floor(left / 60_000) % 60).padStart(2, '0')
    return `${icons.wallet}5h ${used}${Number.isNaN(at) ? '' : ` (resets ${clockTime(at)}, in ${hours}h ${mins}m)`}`
  }
  if (limit.kind === 'seven_day') {
    return `${icons.calendar}7d ${used}${Number.isNaN(at) ? '' : ` (resets in ${Math.floor(hours / 24)}d ${hours % 24}h)`}`
  }

  return `${icons.wallet}${limit.kind.replace(/_/g, ' ')} ${used}`
}

// The status line's rows: who and where, then the limits, then context and cost.
function statusLines(s: PanelStatus, now: number, icons: typeof ICONS) {
  const join = (parts: string[]) => parts.filter(part => part !== '').join('  ')
  const percent =
    s.contextPercent ?? (s.contextTokens !== null && s.contextWindow ? (s.contextTokens / s.contextWindow) * 100 : null)
  const sized =
    s.contextTokens === null || s.contextWindow === null
      ? ''
      : ` (${Math.round(s.contextTokens / 1000)}K / ${Math.round(s.contextWindow / 1000)}K)`
  const rows = [
    {
      key: 'who',
      text: join([
        s.model === null ? '' : `${icons.model}${s.model}${s.effort === null ? '' : ` [${s.effort}]`}`,
        s.host === null ? '' : `${icons.host}${s.host}`,
      ]),
    },
    {
      key: 'where',
      text: join([
        s.cwd === null ? '' : `${icons.folder}${s.cwd}`,
        s.branch === null ? '' : `${icons.branch}${s.branch}${s.dirty > 0 ? ` ±${s.dirty}` : ''}`,
      ]),
    },
    ...s.limits.map(limit => ({ key: `limit-${limit.kind}`, text: limitText(limit, now, icons) })),
    {
      key: 'context',
      text: join([
        percent === null ? '' : `${icons.context}${bar(percent)} ${Math.round(percent)}%${sized}`,
        s.costUsd === null ? '' : `$${s.costUsd.toFixed(2)}`,
      ]),
    },
  ].filter(row => row.text !== '')

  return rows.map((row, i) => ({ ...row, color: sweep(i, rows.length) }))
}

// a figure the engine cannot give leaves its place in the status box empty
function quietly<T>(pending: Promise<T>): Promise<T | undefined> {
  return pending.catch(() => undefined)
}

type Settings = {
  pollMs: number
  awayMs: number
  pingPeerFinish: boolean
  deskSound: boolean
  showBand: boolean
  sidebar: boolean
  panelPercent: number
}

let settings: Settings = {
  pollMs: 15000,
  awayMs: 60000,
  pingPeerFinish: true,
  deskSound: true,
  showBand: true,
  sidebar: true,
  panelPercent: 30,
}

// The module's own run state: a reload starts it over, which costs one
// missed finish at most.
let inFlight = false
let probeUntil = 0
let isPolluted = false
let poller: Timer | undefined
let lastStatus: Map<string, string> | undefined
let isFullscreenLayout = false
let isSidebarAsked = false
let messageSeq = 0
let terminalColumns = 0

// the panel's share of the terminal (7:3 at 30%), less the frame and the gap to the transcript
function panelColumns() {
  if (terminalColumns === 0) return SIDEBAR_COLUMNS
  return Math.max(SIDEBAR_COLUMNS, Math.round((terminalColumns * settings.panelPercent) / 100) - 3)
}

async function chime($: EngineInterface) {
  if (!settings.deskSound || (await $.env.get('OS')) !== 'Windows_NT') return
  await $.process
    .run([
      'powershell',
      '-NoProfile',
      '-Command',
      "(New-Object Media.SoundPlayer 'C:\\Windows\\Media\\Windows Notify System Generic.wav').PlaySync()",
    ])
    .catch(() => undefined)
}

// Push to the phone when away; the engine decides presence and answers
// user_present, in which case a toast and a chime stand in.
async function alert($: EngineInterface, message: string) {
  const text = clip(message, 190)
  try {
    const ran = await $.tool.call({ tool: 'PushNotification', message: text, status: 'proactive' })
    if (ran.deny === undefined && ran.isError !== true) {
      const sent = ran.result
      if (sent.pushSent === true || sent.localSent === true) return
      if (sent.disabledReason === 'user_present') {
        $.ui.toast(text)
        await chime($)
        return
      }
    }
  } catch {
    // no PushNotification tool in this session: fall through to the OS notification
  }
  $.ui.toast(text)
  await $.ui.notify(text, { title: 'Claude Code' }).catch(() => undefined)
}

async function refresh($: EngineInterface) {
  if (inFlight) return
  inFlight = true
  try {
    probeUntil = Number.POSITIVE_INFINITY
    const ran = await $.tool.call({ tool: 'ListAgents' }).finally(async () => {
      probeUntil = (await $.clock.now()) + 3000
    })
    if (ran.deny !== undefined || ran.isError === true) {
      await update($, note, () => `Couldn't list sessions: ${ran.deny ?? ran.text ?? 'error'}`)
      return
    }

    const parsed = parseListing(ran.result as Listing)
    const before = lastStatus
    lastStatus = new Map(parsed.peers.map(peer => [peer.ref, peer.status]))
    if (before !== undefined) {
      for (const peer of parsed.peers) {
        const was = before.get(peer.ref)
        if (was !== undefined && BUSY.test(was) && !isBusy(peer) && isOnline(peer)) {
          if (settings.pingPeerFinish) void alert($, `${peer.name} finished`)
          else $.ui.toast(`${peer.name} finished`)
        }
      }
    }

    const next = JSON.stringify(parsed.peers)
    await update($, peers, list => (JSON.stringify(list) === next ? list : parsed.peers))
    await update($, self, name => parsed.self ?? name)
    const now = await $.clock.now()
    await update($, updatedAt, () => now)
  } catch (err) {
    await update($, note, () => `Couldn't list sessions: ${String(err)}`)
  } finally {
    inFlight = false
  }
  await refreshStatus($, false)

  // A plugin's tool call that lands in the transcript would flood the
  // context on a timer, so stop polling the first time one shows up.
  if (isPolluted && poller !== undefined) {
    poller.cancel()
    poller = undefined
    await update($, isManual, () => true)
    $.ui.log('session-hub: ListAgents calls show up in the transcript; auto-refresh is off, press Refresh in /sessions')
  }
}

async function readSurfaces($: EngineInterface) {
  const drawn = await $.session.surfaces()
  await update($, surfaces, () => [...drawn])
}

// The usage figures are free to read on every poll; the model, effort and
// git status are read at the start, after each turn and on Refresh.
async function refreshStatus($: EngineInterface, isFull: boolean) {
  const was = await read($, status)
  const usage = await quietly($.session.usage())
  const limits = (usage?.rateLimits ?? []).map(limit => ({
    kind: limit.kind,
    percentUsed: limit.percentUsed,
    resetsAt: limit.resetsAt ?? null,
  }))
  const figures = {
    limits,
    contextPercent: usage?.context.percent ?? null,
    contextTokens: usage?.context.tokens ?? null,
    contextWindow: usage?.context.window ?? null,
    costUsd: usage?.cost?.usd ?? null,
  }
  if (!isFull && was !== null) {
    const next: PanelStatus = { ...was, ...figures }
    await update($, status, s => (JSON.stringify(s) === JSON.stringify(next) ? s : next))
    return
  }

  const model = await quietly($.session.model())
  const cwd = await quietly($.session.cwd())
  const host = await quietly($.env.get('COMPUTERNAME'))
  const merged = (await quietly($.settings.read())) as Record<string, unknown> | undefined
  const effort = (await quietly($.env.get('CLAUDE_EFFORT'))) ?? merged?.effortLevel
  let branch: string | null = null
  let dirty = 0
  if (cwd !== undefined && (await quietly($.session.repo())) != null) {
    const git = await quietly(
      $.process.run(['git', '-C', cwd, '--no-optional-locks', 'status', '--porcelain', '-b'], { timeoutMs: 5000 }),
    )
    if (git !== undefined && git.exitCode === 0) {
      const [head = '', ...changes] = git.stdout.split('\n').filter(line => line.trim() !== '')
      branch = parseBranch(head)
      dirty = changes.length
    }
  }
  const next: PanelStatus = {
    model: model === undefined ? null : modelName(model),
    effort: typeof effort === 'string' ? effort : null,
    host: host ?? null,
    cwd: cwd ?? null,
    branch,
    dirty,
    ...figures,
  }
  await update($, status, s => (JSON.stringify(s) === JSON.stringify(next) ? s : next))
}

async function boot($: EngineInterface) {
  await readSurfaces($)
  await refreshStatus($, true)
  const { decision } = await $.tool.check({ tool: 'ListAgents', input: {} })
  if (decision !== 'allow' || settings.pollMs === 0) {
    await update($, isManual, () => true)
    if (decision !== 'allow') {
      await update($, note, () => 'ListAgents needs approval here, so the list refreshes only when you press Refresh.')
    }
    return
  }
  await update($, isManual, () => false)
  await refresh($)
  if (!isPolluted) {
    poller = $.clock.every(Math.max(5000, settings.pollMs), () => void refresh($))
  }
}

// Opened unasked, the engine seats it only where it docks beside the
// transcript (the fullscreen layout), so this never takes over the screen.
async function openSidebar($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, columns: panelColumns() })
  await update($, isDocked, () => opened.isPlaced)
}

async function openPane($: EngineInterface) {
  await update($, isSidebarDismissed, () => false)
  void refresh($)
  const opened = await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, columns: panelColumns() })
  await update($, isDocked, () => opened.isPlaced && isFullscreenLayout)

  return opened
}

async function closePane($: EngineInterface) {
  await update($, isSidebarDismissed, () => true)
  await $.ui.close({ id: PANE })
}

async function addMessage($: EngineInterface, message: Omit<PeerMessage, 'id' | 'at'>) {
  const at = await $.clock.now()
  messageSeq += 1
  const kept: PeerMessage = { ...message, id: `${at}-${messageSeq}`, at }
  await update($, messages, list => [...list, kept].slice(-KEPT_MESSAGES))
}

async function markRead($: EngineInterface, peer: string) {
  await update($, messages, list =>
    list.some(m => isUnread(m) && m.peer === peer)
      ? list.map(m => (isUnread(m) && m.peer === peer ? { ...m, isRead: true } : m))
      : list,
  )
}

async function toggleThread($: EngineInterface, peer: string) {
  const isOpening = (await read($, target)) !== peer
  await update($, target, () => (isOpening ? peer : null))
  if (isOpening) await markRead($, peer)
}

async function isThreadInView($: EngineInterface, peer: string) {
  if ((await read($, target)) !== peer) return false
  try {
    return (await $.ui.panes()).some(pane => pane.id === PANE && pane.isShown)
  } catch {
    return false
  }
}

async function send($: EngineInterface, peer: Peer, text: string) {
  if (text.trim() === '') return
  const to = peer.ref === '' ? peer.name : `${peer.name} [${peer.ref}]`
  const sent = await $.session.send({ to, text }).catch(err => ({ isDelivered: false as const, reason: String(err) }))
  if (sent.isDelivered) {
    await addMessage($, { peer: peer.name, isOutgoing: true, text, isRead: true })
    await update($, note, () => null)
  } else {
    await update($, note, () => `Not sent to ${peer.name}: ${sent.reason}`)
  }
}

export const register: Register = (on, options) => {
  settings = {
    pollMs: Math.max(0, Number(options.pollSeconds ?? 15)) * 1000,
    awayMs: Math.max(0, Number(options.awaySeconds ?? 60)) * 1000,
    pingPeerFinish: options.pingPeerFinish !== false,
    deskSound: options.deskSound !== false,
    showBand: options.showBand !== false,
    sidebar: options.sidebar !== false,
    panelPercent: Math.min(60, Math.max(15, Number(options.panelPercent ?? 30))),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Show local, Remote Control and cloud sessions, and message one',
    })
    await $.command.register({
      name: 'panel',
      description: 'Open the right-hand panel: session tabs above, the status line below',
    })
    const started = await next(e)
    void boot($).catch(err => $.ui.log(`session-hub: ${String(err)}`))

    return started
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    terminalColumns = e.presentation.columns
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Panel opened.' : `Panel waiting: ${opened.reason}` }
  })

  on('command.run', { command: 'panel' }, async ($, e) => {
    terminalColumns = e.presentation.columns
    const opened = await openPane($)

    return { text: opened.isPlaced ? 'Panel opened.' : `Panel waiting: ${opened.reason}` }
  })

  on('session.append', async ($, e, next) => {
    if (probeUntil > 0 && e.agentId === undefined && JSON.stringify(e.origin).includes('ListAgents')) {
      if ((await $.clock.now()) <= probeUntil) isPolluted = true
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.receive', async ($, e, next) => {
    const received = await next(e)
    const isPeer = e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message'
    if (isPeer && e.agentId === undefined && received.consumed === undefined) {
      const { from, body } = parseDelivery(e.text, { ...e.origin })
      const isInView = await isThreadInView($, from)
      await addMessage($, { peer: from, isOutgoing: false, text: body, isRead: isInView })
      if (!isInView) $.ui.toast(`${from}: ${clip(firstLine(body), 120)}`)
    }

    return received
  }).catch(($, e, next) => next(e))

  on('ui.close', async ($, e, next) => {
    const closed = await next(e)
    if (e.id === PANE) {
      await update($, isDocked, () => false)
      if (e.origin.kind === 'person') await update($, isSidebarDismissed, () => true)
    }

    return closed
  }).catch(($, e, next) => next(e))

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    await readSurfaces($)

    return attached
  })

  on('session.detach', async ($, e, next) => {
    const detached = await next(e)
    await readSurfaces($).catch(() => undefined)

    return detached
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && !e.isAborted && settings.awayMs > 0 && e.durationMs >= settings.awayMs) {
      const name = (await read($, self)) ?? 'Claude'
      const gist = firstLine(e.answer)
      const message = `${name}: done after ${minutes(e.durationMs)}${gist === '' ? '' : ` — ${gist}`}`
      // its own dispatch, so the push outlives this hook
      $.clock.after(0, () => void alert($, message))
    }
    if (e.agentId === undefined) $.clock.after(0, () => void refreshStatus($, true))

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    isFullscreenLayout = e.viewport?.isFullscreen === true
    const docked = await read($, isDocked)
    // beside a docked panel this is the transcript's width, not the terminal's
    if (!docked && e.viewport !== undefined) terminalColumns = e.viewport.columns
    const dismissed = await read($, isSidebarDismissed)
    // still docked across a reload, the panel keeps its width rather than one guessed blind
    if (settings.sidebar && isFullscreenLayout && !docked && !dismissed && !isSidebarAsked) {
      isSidebarAsked = true
      $.clock.after(0, () => void openSidebar($))
    }

    // the sidebar replaces the band while it is docked
    if (!settings.showBand || e.props.hasSurvey || docked) return next(e)

    const list = await read($, peers)
    const attached = (await read($, surfaces)).filter(surface => surface !== 'terminal')
    const count = (await read($, messages)).filter(isUnread).length
    if (list.length === 0 && attached.length === 0 && count === 0) return next(e)

    const local = list.filter(peer => peer.group === 'local')
    const remote = list.filter(peer => peer.group === 'remote')
    const cloud = list.filter(peer => peer.group === 'cloud')
    const busy = list.filter(isBusy).length
    const parts = [
      local.length > 0 ? `${local.length} on this PC` : '',
      remote.length > 0 ? `${remote.filter(isOnline).length}/${remote.length} RC online` : '',
      cloud.length > 0 ? `${cloud.length} cloud` : '',
      busy > 0 ? `${busy} working` : '',
      attached.includes('mobile') ? 'phone attached' : '',
      attached.some(surface => surface !== 'mobile') ? 'app attached' : '',
      count > 0 ? `${count} unread` : '',
    ].filter(part => part !== '')

    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text dimColor wrap="truncate-end">
          Sessions: {parts.join(' · ')}{' '}
        </Text>
        <Button key="open" label="Open" onPress={() => void openPane($)} />
        {/* clicks only reach a Button in the fullscreen layout */}
        {e.surface === 'terminal' && e.viewport?.isFullscreen !== true && (
          <Text dimColor> ctrl+x tab, Enter</Text>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    const width = Math.max(20, e.props.bodyColumns)
    const isNarrow = width < 60
    const isDock = e.props.placement === 'dock'

    const list = await read($, peers)
    const me = await read($, self)
    const attached = (await read($, surfaces)).filter(surface => surface !== 'terminal')
    const all = await read($, messages)
    const picked = await read($, target)
    const said = await read($, note)
    const at = await read($, updatedAt)
    const manual = await read($, isManual)
    const shownTab = await read($, tab)
    const figures = await read($, status)
    const now = await $.clock.now()
    const refreshing = at === 0 ? 'not refreshed yet' : manual ? 'manual refresh' : `every ${Math.max(5, settings.pollMs / 1000)}s`

    const lines = figures === null ? [] : statusLines(figures, now, e.surface === 'terminal' ? ICONS : NO_ICONS)
    // the box's border takes a row above and one below
    const statusRows = lines.length === 0 ? 0 : lines.length + 2

    // a sender missing from the list (a teammate, a session since closed) still gets a thread
    const chosen: Peer | undefined =
      picked === null
        ? undefined
        : (list.find(peer => peer.name === picked) ?? {
            name: picked,
            ref: '',
            group: 'local',
            type: '',
            status: 'not listed',
            started: null,
          })
    const unread = all.filter(isUnread)
    const unreadBy = new Map<string, PeerMessage[]>()
    for (const m of unread) unreadBy.set(m.peer, [...(unreadBy.get(m.peer) ?? []), m])
    const thread = chosen === undefined ? [] : all.filter(m => m.peer === chosen.name)
    const elsewhere = chosen === undefined ? 0 : unread.filter(m => m.peer !== chosen.name).length
    // docked, the thread gets what the tabs, its own lines and the status box leave
    const room = isDock
      ? e.props.scroll.bodyRows - TAB_ROWS - statusRows - THREAD_CHROME_ROWS - (elsewhere > 0 ? 1 : 0) - (said === null ? 0 : 1)
      : Number.POSITIVE_INFINITY
    const shown = fitThread(thread, Math.max(3, room), width)
    const sentCount = thread.filter(m => m.isOutgoing).length

    return (
      <Box flexDirection="column" {...(isDock ? { minHeight: e.props.scroll.bodyRows } : {})}>
        <Box key="tabs" gap={2}>
          {TABS.map(t => (
            // a plain Button draws its hotkey ahead of the label: "1: Sessions"
            <Button key={`tab-${t.id}`} plain hotkey={t.hotkey} onPress={() => void update($, tab, () => t.id)}>
              {t.id === shownTab ? (
                <Text bold color="#00E5FF">
                  {t.label}
                </Text>
              ) : (
                <Text dimColor>{t.label}</Text>
              )}
              {t.id === 'sessions' && unread.length > 0 && <Text color="#FF2E9E"> ●{unread.length}</Text>}
            </Button>
          ))}
        </Box>
        <Text dimColor wrap="truncate-end">
          {'─'.repeat(width)}
        </Text>
        <Box key="body" flexDirection="column" flexGrow={1}>
          {chosen === undefined && (
            <Box flexDirection="column">
              <Text bold wrap="truncate-end">
                {me ?? 'This session'}
              </Text>
              {attached.length > 0 && <Text dimColor>also on {attached.join(', ')}</Text>}
              {unreadBy.size > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text bold>
                    Unread <Text dimColor>({unread.length})</Text>
                  </Text>
                  {[...unreadBy].map(([peer, waiting]) => (
                    <Button key={`inbox-${peer}`} plain onPress={() => void toggleThread($, peer)}>
                      {'● '}
                      {clip(peer, 16)}
                      {waiting.length > 1 ? ` (${waiting.length})` : ''}{' '}
                      <Text dimColor>
                        {clip(firstLine(waiting.at(-1)?.text ?? ''), Math.max(8, width - Math.min(16, peer.length) - 8))}
                      </Text>
                    </Button>
                  ))}
                </Box>
              )}
              {GROUPS.map(({ group, label, short }) => {
                const rows = list.filter(peer => peer.group === group)
                return (
                  <Box key={`group-${group}`} flexDirection="column" marginTop={1}>
                    <Text bold>
                      {isNarrow ? short : label} <Text dimColor>({rows.length})</Text>
                    </Text>
                    {rows.length === 0 && <Text dimColor>  none</Text>}
                    {rows.map(peer => {
                      const waiting = unreadBy.get(peer.name)?.length ?? 0
                      const badge = waiting > 0 ? ` ●${waiting}` : ''
                      const detail = !isNarrow && peer.started !== null ? `${peer.status} · ${peer.started}` : peer.status
                      return (
                        <Button key={`peer-${peer.ref}`} plain onPress={() => void toggleThread($, peer.name)}>
                          {'  '}
                          {clip(peer.name, Math.max(8, width - detail.length - badge.length - 4))}
                          {badge}{' '}
                          <Text dimColor>{detail}</Text>
                        </Button>
                      )
                    })}
                  </Box>
                )
              })}
              <Box marginTop={1}>
                <Text dimColor>Pick a session to read and send messages.</Text>
              </Box>
            </Box>
          )}
          {chosen !== undefined && (
            <Box key="thread" flexDirection="column" marginTop={1}>
              <Text bold wrap="truncate-end">
                With {chosen.name} <Text dimColor>{chosen.status}</Text>
              </Text>
              {elsewhere > 0 && <Text color="#FF2E9E">● {elsewhere} unread from others, Back to see</Text>}
              {thread.length === 0 && <Text dimColor>No messages yet.</Text>}
              {thread.length > shown.length && <Text dimColor>{thread.length - shown.length} earlier</Text>}
              {shown.map(({ message: m, text }) => (
                <Box key={`msg-${m.id}`} flexDirection="column" marginTop={1}>
                  <Text dimColor>
                    {m.isOutgoing ? 'you' : chosen.name} · {clockTime(m.at)}
                  </Text>
                  <Text>{text}</Text>
                </Box>
              ))}
              <Box flexDirection="column" marginTop={1}>
                {Input !== undefined ? (
                  <Input
                    key={`message-${sentCount}`}
                    label={`To ${clip(chosen.name, isNarrow ? 12 : 24)}: `}
                    placeholder={isOnline(chosen) ? 'message' : 'offline, may not arrive'}
                    submitLabel="send"
                    autoFocus
                    onSubmit={text => void send($, chosen, text)}
                  />
                ) : (
                  <Text dimColor>Reply from the terminal or desktop app.</Text>
                )}
              </Box>
            </Box>
          )}
          {said !== null && <Text dimColor>{said}</Text>}
          <Box marginTop={1} gap={1} flexWrap="wrap">
            <Button
              key="refresh"
              label="Refresh"
              hotkey="r"
              onPress={() => void refresh($).then(() => refreshStatus($, true))}
            />
            {chosen !== undefined && <Button key="back" label="Back" onPress={() => void update($, target, () => null)} />}
            {unreadBy.size > 0 && (
              <Button
                key="read-all"
                label="Mark read"
                onPress={() => void update($, messages, ms => ms.map(m => (isUnread(m) ? { ...m, isRead: true } : m)))}
              />
            )}
            <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($)} />
          </Box>
          <Text dimColor>{refreshing}</Text>
        </Box>
        {lines.length > 0 && (
          <Box key="status" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            {lines.map(line => (
              <Box key={`status-${line.key}`}>
                <Text color={line.color} wrap={line.key === 'where' ? 'truncate-middle' : 'truncate-end'}>
                  {line.text}
                </Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
