import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ServiceState, TaskItem, LinkItem, PanelLimit, PanelStatus, PanelTab, Peer, PeerGroup, PeerMessage, PeerWaiting } from '../types'

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
const tab = atom({ plugin: 'session-hub', key: 'tab' } as const, 'tasks')
const tasks = atom({ plugin: 'session-hub', key: 'tasks' } as const, [])
const services = atom({ plugin: 'session-hub', key: 'services' } as const, [])

// checked only while the Services tab is shown; a host that does not answer in time is down
const SERVICE_POLL_MS = 5_000
const SERVICE_TIMEOUT_MS = 4_000
const status = atom({ plugin: 'session-hub', key: 'status' } as const, null)
const waiting = atom({ plugin: 'session-hub', key: 'waiting' } as const, [])
const renaming = atom({ plugin: 'session-hub', key: 'renaming' } as const, null)
const links = atom({ plugin: 'session-hub', key: 'links' } as const, [])

const KEPT_LINKS = 50
// a web address, or a Windows path with its drive letter, as an answer writes them
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/g
const PATH_PATTERN = /(?<![\w/:])[A-Za-z]:[\\/][^\s<>"'`|*?]*[^\s<>"'`|*?.,;:!)\]]/g
// tools whose call leaves a file behind
const WRITING_TOOLS = new Set(['Write', 'NotebookEdit'])

const SIDEBAR_COLUMNS = 38
// long enough for the first draw to report the terminal's width
const STARTUP_OPEN_MS = 1_500
const KEPT_MESSAGES = 100
const SHOWN_IN_THREAD = 6
const MESSAGE_CHARS = 2000
// the tab row, each tab in its own box
const TAB_ROWS = 3
// the body's border, a row above and one below
const BODY_FRAME_ROWS = 2
// a thread's own lines around its messages: title, "earlier", input, buttons, refresh mode
const THREAD_CHROME_ROWS = 8

// ListAgents says only busy or idle, so a session blocked on a dialog says so
// itself: a marker file while the dialog is up, beaten every few seconds
const WAIT_BEAT_MS = 5_000
const WAIT_STALE_MS = 15_000
const WAIT_POLL_MS = 3_000
const AMBER = '#FFD23F'

// A rename goes the same way: a request file the named session's own
// session-hub picks up and runs as /rename, once it is idle.
const RENAME_STALE_MS = 120_000
const RENAME_WAIT_MS = 15_000
const NAME_CHARS = 60
const PENCIL = '✎'
const SELF_ROW = 'self'

// tools whose call is the dialog itself
const DIALOGS: Readonly<Record<string, PeerWaiting['kind']>> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' }
const WAIT_LABEL: Readonly<Record<PeerWaiting['kind'], string>> = {
  question: 'asking you',
  permission: 'needs approval',
  plan: 'plan to approve',
}

const TABS: readonly { id: PanelTab; label: string; hotkey: string }[] = [
  { id: 'tasks', label: 'Tasks', hotkey: '1' },
  { id: 'sessions', label: 'Sessions', hotkey: '2' },
  { id: 'links', label: 'Links', hotkey: '3' },
  { id: 'services', label: 'Services', hotkey: '4' },
]

// the status line script's "Aurora Full Sweep", one colour per row here
const SWEEP: readonly [number, number, number][] = [
  [0xb1, 0x4e, 0xff],
  [0x00, 0xe5, 0xff],
  [0xff, 0x2e, 0x9e],
  [0xff, 0xd2, 0x3f],
]

// plain Unicode symbols Cascadia Mono carries, so no Nerd Font is needed; the terminal alone draws them
const ICONS = {
  model: '◆ ',
  host: '⌂ ',
  folder: '▤ ',
  wallet: '◷ ',
  calendar: '▦ ',
  context: '≡ ',
  branch: '◇ ',
}
const NO_ICONS: typeof ICONS = {
  model: '',
  host: '',
  folder: '',
  wallet: '',
  calendar: '',
  context: 'ctx ',
  branch: '',
}

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

// "  claude-42 [c9c1f2]  ·  interactive  ·  idle  ·  started 1h ago"
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

function parseListing(result: Listing): { self: string | null; selfRef: string | null; peers: Peer[] } {
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

  const me = SELF.exec(result.listing)

  return { self: me?.[1] ?? null, selfRef: me?.[2] ?? null, peers: list }
}

const firstLine = (text: string) =>
  text
    .replace(/<[^>]+>/g, ' ')
    .split('\n')
    .map(line => line.trim())
    .find(line => line.length > 0) ?? ''

const clip = (text: string, max: number) => (text.length > max ? text.slice(0, Math.max(1, max - 1)) + '…' : text)

// A peer's delivery reads "<cross-session-message from=… from-name="claude-42" …>body</…>";
// the origin carries the same name and body at run time, though its type does not say so.
const ENVELOPE = /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/

function parseDelivery(text: string, origin: Record<string, unknown>) {
  const m = ENVELOPE.exec(text)
  const named = /from-name="([^"]*)"/.exec(m?.[1] ?? text)?.[1]
  const from = typeof origin.name === 'string' ? origin.name : (named ?? 'another session')
  const body = typeof origin.body === 'string' ? origin.body : (m?.[2] ?? text)

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

// What a dialog asks, in a line: the first question, or the tool and what it aims at.
function dialogDetail(tool: string, input: unknown) {
  const args = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {}
  const first: unknown = Array.isArray(args.questions) ? args.questions[0] : undefined
  const asked = typeof first === 'object' && first !== null ? (first as Record<string, unknown>).question : undefined
  if (typeof asked === 'string') return clip(firstLine(asked), 160)
  if (tool === 'ExitPlanMode') return 'plan ready'
  const aim = ['command', 'file_path', 'url', 'pattern', 'path'].map(key => args[key]).find(v => typeof v === 'string')
  const line = typeof aim === 'string' ? (aim.split('\n').find(part => part.trim() !== '') ?? '').trim() : ''

  return clip(line === '' ? tool : `${tool}: ${line}`, 160)
}

function parseWaiting(text: string): PeerWaiting | null {
  try {
    const m = JSON.parse(text) as Partial<Record<keyof PeerWaiting, unknown>>
    const kind = m.kind
    if (typeof m.id !== 'string' || typeof m.since !== 'number' || typeof m.at !== 'number') return null
    if (kind !== 'question' && kind !== 'permission' && kind !== 'plan') return null
    const orNull = (value: unknown) => (typeof value === 'string' ? value : null)

    return {
      id: m.id,
      name: orNull(m.name),
      ref: orNull(m.ref),
      cwd: orNull(m.cwd),
      kind,
      detail: orNull(m.detail) ?? '',
      since: m.since,
      at: m.at,
    }
  } catch {
    return null
  }
}

// a session that never listed its peers knows no name of its own: its folder stands in
function waitName(marker: PeerWaiting) {
  return (
    marker.name ??
    marker.cwd
      ?.split(/[\\/]/)
      .filter(part => part !== '')
      .at(-1) ??
    'a session'
  )
}

const isWaitFor = (marker: PeerWaiting, peer: Peer) =>
  (marker.ref !== null && marker.ref === peer.ref) || marker.name === peer.name

const fileHref = (path: string) => `file:///${encodeURI(path.replace(/\\/g, '/'))}`

function findLinks(text: string): Omit<LinkItem, 'at'>[] {
  const urls = [...text.matchAll(URL_PATTERN)].map(m => m[0].replace(/[.,;:!?]+$/, ''))
  const paths = [...text.matchAll(PATH_PATTERN)].map(m => m[0])

  return [
    ...urls.map(url => ({ href: url, text: url, isFile: false })),
    ...paths.map(path => ({ href: fileHref(path), text: path.replace(/\\/g, '/'), isFile: true })),
  ]
}

// newest first, each href once
async function addLinks($: EngineInterface, text: string) {
  const found = findLinks(text)
  if (found.length === 0) return
  const at = await $.clock.now()
  const fresh = [...new Map(found.map(f => [f.href, { ...f, at }])).values()].reverse()
  const hrefs = new Set(fresh.map(f => f.href))
  await update($, links, list => [...fresh, ...list.filter(l => !hrefs.has(l.href))].slice(0, KEPT_LINKS))
}

// "gpu=http://pc:8188, ollama=http://localhost:11434"; a bare URL names itself by its host
function parseServices(text: string) {
  return text
    .split(/[,;\n]/)
    .map(part => part.trim())
    .filter(part => part !== '')
    .flatMap(part => {
      const at = part.search(/=(?=https?:\/\/)/)
      const url = (at < 0 ? part : part.slice(at + 1)).trim().replace(/\/+$/, '')
      if (!/^https?:\/\//.test(url)) return []
      const name = at < 0 ? url.replace(/^https?:\/\//, '') : part.slice(0, at).trim()
      return [{ name, url }]
    })
}

// "cuda:0 NVIDIA GeForce RTX 5070 : cudaMallocAsync" reads "RTX 5070"
const gpuName = (raw: string) =>
  raw
    .replace(/^\w+:\d+\s*/, '')
    .replace(/\s*:.*$/, '')
    .replace(/^(NVIDIA )?GeForce /, '')
    .trim()

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1)

async function fetchWithin($: EngineInterface, url: string) {
  const late = $.clock.sleep(SERVICE_TIMEOUT_MS).then(() => {
    throw new Error('no answer in 4s')
  })
  return Promise.race([$.http.fetch(url), late])
}

const asJson = (text: string) => {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return undefined
  }
}

// Up is any answer at all; a ComfyUI one also gives its first GPU and its queue.
async function checkService($: EngineInterface, svc: { name: string; url: string }): Promise<ServiceState> {
  const blank = { gpu: null, vramFree: null, vramTotal: null, running: null, pending: null }
  const start = await $.clock.now()
  try {
    const stats = await fetchWithin($, `${svc.url}/system_stats`)
    const ms = (await $.clock.now()) - start
    const devices = asJson(stats.text)?.devices
    const gpu = Array.isArray(devices) ? (devices[0] as Record<string, unknown> | undefined) : undefined
    if (!stats.ok || gpu === undefined) return { ...svc, ...blank, isUp: true, ms, error: null }

    const queue = asJson((await quietly(fetchWithin($, `${svc.url}/queue`)))?.text ?? '')
    const count = (key: string) => (Array.isArray(queue?.[key]) ? (queue[key] as unknown[]).length : null)
    const num = (key: string) => (typeof gpu[key] === 'number' ? (gpu[key] as number) : null)

    return {
      ...svc,
      isUp: true,
      ms,
      error: null,
      gpu: typeof gpu.name === 'string' ? gpuName(gpu.name) : null,
      vramFree: num('vram_free'),
      vramTotal: num('vram_total'),
      running: count('queue_running'),
      pending: count('queue_pending'),
    }
  } catch (err) {
    return { ...svc, ...blank, isUp: false, ms: null, error: err instanceof Error ? err.message : String(err) }
  }
}

async function checkServices($: EngineInterface) {
  if (isChecking || settings.services.length === 0) return
  isChecking = true
  try {
    const found = await Promise.all(settings.services.map(svc => checkService($, svc)))
    const next = JSON.stringify(found)
    await update($, services, list => (JSON.stringify(list) === next ? list : found))
  } finally {
    isChecking = false
  }
}

const PLAN_ID = 'plan-'
const PLAN_STEPS = 20

// A plan's steps: its numbered items, else its top-level bullets, else its headings.
function planSteps(plan: string) {
  const lines = plan.split('\n')
  const pick = (pattern: RegExp) => lines.flatMap(line => pattern.exec(line)?.[1] ?? [])
  const numbered = pick(/^\s{0,3}\d+[.)]\s+(.+)/)
  const bullets = pick(/^[-*+]\s+(.+)/)
  const headings = pick(/^#{2,4}\s+(.+)/)
  const steps = numbered.length > 0 ? numbered : bullets.length > 0 ? bullets : headings

  return steps
    .map(step =>
      clip(
        step
          .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
          .replace(/\*\*|__|`/g, '')
          .trim(),
        120,
      ),
    )
    .filter(step => step !== '')
    .slice(0, PLAN_STEPS)
}

async function trackPlan($: EngineInterface, result: unknown) {
  const out = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const saved = typeof out.filePath === 'string' ? await quietly($.fs.read(out.filePath)) : undefined
  const plan = typeof out.plan === 'string' ? out.plan : typeof saved === 'string' ? saved : ''
  const steps = planSteps(plan)
  if (steps.length === 0) return
  const at = await $.clock.now()
  // a revised plan replaces the last one; tasks already made stay
  await update($, tasks, list => [
    ...list.filter(t => !t.id.startsWith(PLAN_ID)),
    ...steps.map((subject, i) => ({ id: `${PLAN_ID}${i}`, subject, status: 'pending' as const, at })),
  ])
}

// the task tools, read as they run, so the list needs no TaskList call of its own
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TodoWrite'])
const DONE_SHOWN = 8

const isTaskStatus = (s: unknown): s is TaskItem['status'] => s === 'pending' || s === 'in_progress' || s === 'completed'

async function trackTasks($: EngineInterface, tool: string, input: unknown, result: unknown) {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const out = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>
  const at = await $.clock.now()

  if (tool === 'TaskCreate') {
    const made = (out.task ?? {}) as Record<string, unknown>
    const id = typeof made.id === 'string' ? made.id : String(at)
    const subject = typeof made.subject === 'string' ? made.subject : String(args.subject ?? '')
    // real tasks take over from a plan's steps
    await update($, tasks, list => [
      ...list.filter(t => t.id !== id && !t.id.startsWith(PLAN_ID)),
      { id, subject, status: 'pending' as const, at },
    ])
    return
  }
  if (tool === 'TaskUpdate') {
    const id = String(args.taskId ?? '')
    if (args.status === 'deleted') {
      await update($, tasks, list => list.filter(t => t.id !== id))
      return
    }
    const status = isTaskStatus(args.status) ? args.status : undefined
    await update($, tasks, list =>
      list.map(t =>
        t.id !== id
          ? t
          : {
              ...t,
              subject: typeof args.subject === 'string' ? args.subject : t.subject,
              status: status ?? t.status,
              at: status !== undefined && status !== t.status ? at : t.at,
            },
      ),
    )
    return
  }
  // TodoWrite hands over the whole list each time
  const todos = Array.isArray(args.todos) ? (args.todos as Record<string, unknown>[]) : []
  await update($, tasks, () =>
    todos.map((todo, i) => ({
      id: `todo-${i}`,
      subject: String((todo.status === 'in_progress' ? todo.activeForm : undefined) ?? todo.content ?? ''),
      status: isTaskStatus(todo.status) ? todo.status : ('pending' as const),
      at,
    })),
  )
}

// one line, no runs of spaces, short enough for a list row
const cleanName = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS)

type RenameAsk = { ref: string; name: string; to: string; at: number }

function parseRename(text: unknown): RenameAsk | null {
  if (typeof text !== 'string' || text === '') return null
  try {
    const m = JSON.parse(text) as Partial<Record<keyof RenameAsk, unknown>>
    if (typeof m.ref !== 'string' || typeof m.name !== 'string' || typeof m.to !== 'string') return null
    if (typeof m.at !== 'number') return null
    return { ref: m.ref, name: m.name, to: m.to, at: m.at }
  } catch {
    return null
  }
}

// what a session that could not rename left in its request file
function errorOf(text: string) {
  try {
    const m = JSON.parse(text) as { error?: unknown }
    return typeof m.error === 'string' ? m.error : undefined
  } catch {
    return undefined
  }
}

type Settings = {
  pollMs: number
  awayMs: number
  pingPeerFinish: boolean
  deskSound: boolean
  showBand: boolean
  sidebar: boolean
  panelPercent: number
  services: { name: string; url: string }[]
}

let settings: Settings = {
  pollMs: 15000,
  awayMs: 60000,
  pingPeerFinish: true,
  deskSound: true,
  showBand: true,
  sidebar: true,
  panelPercent: 30,
  services: [],
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
let selfRef: string | null = null
// this session's own dialog, while one is up; `seq` is the tool call it came in
let ownWait: { kind: PeerWaiting['kind']; tool: string; detail: string; seq: number; since: number } | undefined
let isWaitWritten = false
let waitWrites: Promise<unknown> = Promise.resolve()
let waitBeat: Timer | undefined
let waitPoller: Timer | undefined
let lastWaiting: Set<string> | undefined
let foundHubDir: string | undefined
let callSeq = 0
let servicePoller: Timer | undefined
let isChecking = false
let lastNames: Map<string, string> | undefined
let pendingRename: { ref: string; from: string; to: string; at: number; path: string } | undefined

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

    // a renamed session keeps its ref: its thread follows it to the new name
    const named = lastNames
    lastNames = new Map(parsed.peers.map(peer => [peer.ref, peer.name]))
    for (const peer of parsed.peers) {
      const was = named?.get(peer.ref)
      if (was === undefined || was === peer.name) continue
      await update($, messages, list =>
        list.some(m => m.peer === was) ? list.map(m => (m.peer === was ? { ...m, peer: peer.name } : m)) : list,
      )
      await update($, target, picked => (picked === was ? peer.name : picked))
      if (pendingRename?.ref === peer.ref) {
        pendingRename = undefined
        await update($, note, () => `Renamed ${was} to ${peer.name}.`)
      }
    }

    const next = JSON.stringify(parsed.peers)
    await update($, peers, list => (JSON.stringify(list) === next ? list : parsed.peers))
    await update($, self, name => parsed.self ?? name)
    selfRef = parsed.selfRef ?? selfRef
    const now = await $.clock.now()
    await update($, updatedAt, () => now)
  } catch (err) {
    await update($, note, () => `Couldn't list sessions: ${String(err)}`)
  } finally {
    inFlight = false
  }
  await quietly(readWaiting($))
  await quietly(readRenames($))
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

// Beside the config folder, not the plugin's, which moves when installed from a marketplace.
async function hubDir($: EngineInterface) {
  if (foundHubDir !== undefined) return foundHubDir
  const config = await quietly($.env.get('CLAUDE_CONFIG_DIR'))
  const home = (await quietly($.env.get('USERPROFILE'))) || (await quietly($.env.get('HOME')))
  const base = config || (home ? `${home}/.claude` : undefined)
  foundHubDir = base ? `${base.replace(/[\\/]+$/, '')}/session-hub` : undefined

  return foundHubDir
}

const waitDir = async ($: EngineInterface) => {
  const hub = await hubDir($)
  return hub === undefined ? undefined : `${hub}/waiting`
}

const renameDir = async ($: EngineInterface) => {
  const hub = await hubDir($)
  return hub === undefined ? undefined : `${hub}/rename`
}

// This session's own name goes through /rename here; another's through its request file.
async function askRename($: EngineInterface, peer: Peer | null, typed: string) {
  await update($, renaming, () => null)
  const to = cleanName(typed)
  const from = peer?.name ?? (await read($, self))
  if (to === '' || to === from) return
  try {
    if (peer === null) {
      await update($, note, () => `Renaming this session to ${to}.`)
      await $.command.run({ command: 'rename', args: to })
      if (!(await read($, isManual))) $.clock.after(2000, () => void refresh($))
      return
    }
    const dir = await renameDir($)
    if (dir === undefined) {
      await update($, note, () => `Can't rename ${peer.name}: no Claude config folder found.`)
      return
    }
    const at = await $.clock.now()
    const path = `${dir}/${(peer.ref || peer.name).replace(/[^\w.-]+/g, '_')}.json`
    await $.fs.write(path, JSON.stringify({ ref: peer.ref, name: peer.name, to, at } satisfies RenameAsk))
    pendingRename = { ref: peer.ref, from: peer.name, to, at, path }
    await update($, note, () => `Asked ${peer.name} to rename to ${to}.`)
    $.clock.after(RENAME_WAIT_MS, () => void checkRename($))
    // its tick is 3s, then the list shows the new name
    if (!(await read($, isManual))) $.clock.after(5000, () => void refresh($))
  } catch (err) {
    await update($, note, () => `Couldn't rename ${from ?? 'this session'}: ${String(err)}`)
  }
}

// After the wait: a request still there was never picked up; an emptied one runs once it is idle.
async function checkRename($: EngineInterface) {
  const p = pendingRename
  // a newer request restarted the wait
  if (p === undefined || (await $.clock.now()) - p.at < RENAME_WAIT_MS) return
  pendingRename = undefined
  const left = await quietly($.fs.read(p.path))
  if (typeof left === 'string' && left !== '') {
    const failed = errorOf(left)
    const said =
      failed !== undefined
        ? `Couldn't rename ${p.from}: ${failed}`
        : `${p.from} hasn't picked it up: it needs session-hub loaded (/reload-plugins there), or run /rename ${p.to} in it.`
    await update($, note, () => said)
    return
  }
  if (!(await read($, peers)).some(peer => peer.ref === p.ref && peer.name === p.to)) {
    await update($, note, () => `${p.from} renames to ${p.to} once it is idle.`)
  }
}

// The requests named for this session: emptied first, so the next tick never runs one twice.
async function readRenames($: EngineInterface) {
  const dir = await renameDir($)
  const me = await read($, self)
  if (dir === undefined || (selfRef === null && me === null)) return
  const entries = (await quietly($.fs.list(dir))) ?? []
  const now = await $.clock.now()
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.size === 0 || !entry.name.endsWith('.json')) continue
    const path = `${dir}/${entry.name}`
    const ask = parseRename(await quietly($.fs.read(path)))
    if (ask === null || now - ask.at > RENAME_STALE_MS) continue
    const isMine = ask.ref !== '' ? ask.ref === selfRef : ask.name === me
    if (!isMine) continue
    await $.fs.write(path, '')
    const failed = await $.command.run({ command: 'rename', args: cleanName(ask.to) }).then(
      () => undefined,
      (err: unknown) => String(err),
    )
    if (failed !== undefined) await quietly($.fs.write(path, JSON.stringify({ error: failed })))
  }
}

async function writeWait($: EngineInterface) {
  if (ownWait === undefined && !isWaitWritten) return
  const dir = await waitDir($)
  const id = await quietly($.session.id())
  if (dir === undefined || id === undefined) return
  const name = await read($, self)
  const cwd = (await quietly($.session.cwd())) ?? null
  const at = await $.clock.now()
  // read last, so a clear that came in meanwhile wins
  const w = ownWait
  const marker: PeerWaiting | undefined =
    w === undefined ? undefined : { id, name, ref: selfRef, cwd, kind: w.kind, detail: w.detail, since: w.since, at }
  // the folder has no delete, so a cleared marker is an empty file
  await $.fs.write(`${dir}/${id}.json`, marker === undefined ? '' : JSON.stringify(marker))
  isWaitWritten = marker !== undefined
}

// one write at a time, so a heartbeat never lands after the clear
function queueWaitWrite($: EngineInterface) {
  waitWrites = waitWrites.then(() => writeWait($)).catch(() => undefined)
  return waitWrites
}

async function setWaiting($: EngineInterface, kind: PeerWaiting['kind'], tool: string, detail: string, seq: number) {
  try {
    ownWait = { kind, tool, detail, seq, since: await $.clock.now() }
    await queueWaitWrite($)
    waitBeat ??= $.clock.every(WAIT_BEAT_MS, () => void queueWaitWrite($))
  } catch {
    // no marker: the panels elsewhere just won't show this one
  }
}

async function clearWaiting($: EngineInterface) {
  ownWait = undefined
  waitBeat?.cancel()
  waitBeat = undefined
  await queueWaitWrite($)
}

// The other sessions' markers: a toast for each new one, the panel draws the rest.
async function readWaiting($: EngineInterface) {
  const dir = await waitDir($)
  if (dir === undefined) return
  const id = await quietly($.session.id())
  const entries = (await quietly($.fs.list(dir))) ?? []
  const now = await $.clock.now()
  const found: PeerWaiting[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || entry.size === 0 || !entry.name.endsWith('.json') || entry.name === `${id}.json`)
      continue
    const text = await quietly($.fs.read(`${dir}/${entry.name}`))
    const marker = typeof text === 'string' ? parseWaiting(text) : null
    if (marker !== null && marker.id !== id && now - marker.at <= WAIT_STALE_MS) found.push(marker)
  }
  found.sort((a, b) => a.since - b.since)

  const keys = new Set(found.map(m => `${m.id}:${m.since}`))
  // toast only: every open session reads the same folder, so a push from each would repeat
  if (lastWaiting !== undefined) {
    for (const m of found) {
      if (!lastWaiting.has(`${m.id}:${m.since}`))
        $.ui.toast(`${waitName(m)} ${WAIT_LABEL[m.kind]}: ${clip(m.detail, 120)}`)
    }
  }
  lastWaiting = keys

  // the heartbeat alone moves `at`, which is no reason to draw again
  const shape = (list: PeerWaiting[]) => JSON.stringify(list.map(m => ({ ...m, at: 0 })))
  const next = shape(found)
  await update($, waiting, list => (shape(list) === next ? list : found))
}

async function boot($: EngineInterface) {
  $.clock.after(STARTUP_OPEN_MS, () => void openAtStart($).catch(() => undefined))
  await readSurfaces($)
  await refreshStatus($, true)
  if (waitPoller === undefined) {
    await quietly(readWaiting($))
    waitPoller = $.clock.every(WAIT_POLL_MS, () => {
      void quietly(readWaiting($))
      void quietly(readRenames($))
    })
  }
  if (servicePoller === undefined && settings.services.length > 0) {
    servicePoller = $.clock.every(SERVICE_POLL_MS, () => {
      void read($, tab).then(shown => (shown === 'services' ? checkServices($) : undefined))
    })
  }
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

// A new session opens the panel itself, after the first draw has told the
// terminal's width; outside fullscreen the engine leaves it unplaced.
async function openAtStart($: EngineInterface) {
  if (!settings.sidebar || isSidebarAsked) return
  if ((await read($, isDocked)) || (await read($, isSidebarDismissed))) return
  isSidebarAsked = true
  await openSidebar($)
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
    services: parseServices(String(options.services ?? '')),
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

  // A question or plan is up for as long as its call runs; a permission prompt
  // for as long as the call it came in does.
  on('tool.call', async ($, e, next) => {
    callSeq += 1
    const seq = callSeq
    const kind = DIALOGS[e.tool]
    if (kind !== undefined) await setWaiting($, kind, e.tool, dialogDetail(e.tool, e), seq)
    try {
      const ran = await next(e)
      const path = (e as Record<string, unknown>).file_path ?? (e as Record<string, unknown>).notebook_path
      if (WRITING_TOOLS.has(e.tool) && ran.deny === undefined && ran.isError !== true && typeof path === 'string') {
        await quietly(addLinks($, path))
      }
      if (TASK_TOOLS.has(e.tool) && ran.deny === undefined && ran.isError !== true) {
        await quietly(trackTasks($, e.tool, e, ran.result))
      }
      // an approved plan: its steps stand as Next until real tasks arrive
      if (e.tool === 'ExitPlanMode' && ran.deny === undefined && ran.isError !== true) {
        await quietly(trackPlan($, ran.result))
      }
      return ran
    } finally {
      if (ownWait !== undefined && ownWait.tool === e.tool && ownWait.seq >= seq) await clearWaiting($)
    }
  })

  on('classic.PermissionRequest', async ($, e, next) => {
    const decided = await next(e)
    // a hook that answered leaves no dialog up; the question and plan tools mark their own
    if (decided?.decision === undefined && DIALOGS[e.tool_name] === undefined) {
      await setWaiting($, 'permission', e.tool_name, dialogDetail(e.tool_name, e.tool_input), callSeq)
    }

    return decided
  })

  on('session.end', async ($, e, next) => {
    if (ownWait !== undefined) await clearWaiting($)

    return next(e)
  })

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
    if (e.agentId === undefined) {
      $.clock.after(0, () => void refreshStatus($, true))
      await quietly(addLinks($, e.answer))
    }
    // whatever the turn left up has been answered or dropped by now
    if (e.agentId === undefined && ownWait !== undefined) $.clock.after(0, () => void clearWaiting($))

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
    const waits = await read($, waiting)
    if (list.length === 0 && attached.length === 0 && count === 0 && waits.length === 0) return next(e)

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
        {waits.length > 0 && (
          <Text color={AMBER}>
            ?{' '}
            {waits.length === 1
              ? `${clip(waitName(waits[0] as PeerWaiting), 24)} needs you`
              : `${waits.length} need you`}{' '}
          </Text>
        )}
        <Text dimColor wrap="truncate-end">
          Sessions: {parts.join(' · ')}{' '}
        </Text>
        <Button key="open" label="Open" onPress={() => void openPane($)} />
        {/* clicks only reach a Button in the fullscreen layout */}
        {e.surface === 'terminal' && e.viewport?.isFullscreen !== true && <Text dimColor> ctrl+x tab, Enter</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Link, Text } = elements
    const Input = 'Input' in elements ? elements.Input : undefined
    // inside the body's border and padding
    const width = Math.max(16, e.props.bodyColumns - 4)
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
    const waits = await read($, waiting)
    const editing = await read($, renaming)
    const saved = await read($, links)
    const tracked = await read($, tasks)
    const doing = tracked.filter(t => t.status === 'in_progress')
    const planned = tracked.filter(t => t.status === 'pending')
    // most recently finished first
    const done = tracked.filter(t => t.status === 'completed').sort((a, b) => b.at - a.at)
    const now = await $.clock.now()
    const refreshing =
      at === 0 ? 'not refreshed yet' : manual ? 'manual refresh' : `every ${Math.max(5, settings.pollMs / 1000)}s`

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
    const chosenWait = chosen === undefined ? undefined : waits.find(w => isWaitFor(w, chosen))
    // docked, the thread gets what the tabs, its own lines and the status box leave
    const room = isDock
      ? e.props.scroll.bodyRows -
        TAB_ROWS -
        BODY_FRAME_ROWS -
        statusRows -
        THREAD_CHROME_ROWS -
        (elsewhere > 0 ? 1 : 0) -
        (chosenWait === undefined ? 0 : 1) -
        (said === null ? 0 : 1)
      : Number.POSITIVE_INFINITY
    const shown = fitThread(thread, Math.max(3, room), width)
    // the links list: what the frame, the status box and its own buttons and hint leave
    const watched = await read($, services)
    const tabs = TABS.filter(t => t.id !== 'services' || settings.services.length > 0)
    const linkRoom = isDock
      ? Math.max(3, e.props.scroll.bodyRows - TAB_ROWS - BODY_FRAME_ROWS - statusRows - 4)
      : KEPT_LINKS
    const sentCount = thread.filter(m => m.isOutgoing).length

    return (
      <Box flexDirection="column" {...(isDock ? { minHeight: e.props.scroll.bodyRows } : {})}>
        <Box key="tabs" gap={1}>
          {tabs.map(t => {
            const isShown = t.id === shownTab
            return (
              <Box
                key={`tab-box-${t.id}`}
                borderStyle="round"
                {...(isShown ? { borderColor: '#00E5FF' } : { borderDimColor: true })}
                paddingX={1}
              >
                {/* no hotkey: a plain Button would draw its own "1:" ahead, unbolded */}
                <Button key={`tab-${t.id}`} plain onPress={() => {
                    void update($, tab, () => t.id)
                    if (t.id === 'services') void checkServices($)
                  }}>
                  {isShown ? (
                    <Text bold color="#00E5FF">
                      {t.hotkey}: {t.label}
                    </Text>
                  ) : (
                    <Text bold dimColor>
                      {t.hotkey}: {t.label}
                    </Text>
                  )}
                  {t.id === 'sessions' && waits.length > 0 && <Text color={AMBER}> ?{waits.length}</Text>}
                  {t.id === 'sessions' && unread.length > 0 && <Text color="#FF2E9E"> ●{unread.length}</Text>}
                  {t.id === 'links' && saved.length > 0 && <Text dimColor> {saved.length}</Text>}
                  {t.id === 'tasks' && tracked.length > 0 && (
                    <Text dimColor>
                      {' '}
                      {done.length}/{tracked.length}
                    </Text>
                  )}
                </Button>
              </Box>
            )
          })}
        </Box>
        <Box key="body" flexDirection="column" flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
          {shownTab === 'tasks' && (
            <Box key="tasks-view" flexDirection="column" flexGrow={1}>
              {tracked.length === 0 && <Text dimColor>No tasks yet. Claude's task list for this session shows here.</Text>}
              {doing.length > 0 && (
                <Box key="doing" flexDirection="column">
                  <Text bold color="#00E5FF">
                    Doing
                  </Text>
                  {doing.map(t => (
                    <Box key={`task-${t.id}`}>
                      <Text color="#00E5FF" wrap="truncate-end">
                        ▶ {t.subject}
                      </Text>
                    </Box>
                  ))}
                </Box>
              )}
              {planned.length > 0 && (
                <Box key="next" flexDirection="column" marginTop={doing.length > 0 ? 1 : 0}>
                  <Text bold>
                    Next <Text dimColor>({planned.length})</Text>
                  </Text>
                  {planned.map(t => (
                    <Box key={`task-${t.id}`}>
                      <Text wrap="truncate-end">○ {t.subject}</Text>
                    </Box>
                  ))}
                </Box>
              )}
              {done.length > 0 && (
                <Box key="done" flexDirection="column" marginTop={doing.length + planned.length > 0 ? 1 : 0}>
                  <Text bold dimColor>
                    Done ({done.length})
                  </Text>
                  {done.slice(0, DONE_SHOWN).map(t => (
                    <Box key={`task-${t.id}`}>
                      <Text dimColor wrap="truncate-end">
                        <Text color="#00E5FF">✓</Text> {t.subject}
                      </Text>
                    </Box>
                  ))}
                  {done.length > DONE_SHOWN && <Text dimColor>{done.length - DONE_SHOWN} earlier</Text>}
                </Box>
              )}
              <Box marginTop={1} gap={1}>
                {done.length > 0 && (
                  <Button
                    key="tasks-clear-done"
                    label="Clear done"
                    onPress={() => void update($, tasks, list => list.filter(t => t.status !== 'completed'))}
                  />
                )}
                <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($)} />
              </Box>
            </Box>
          )}
          {shownTab === 'services' && (
            <Box key="services-view" flexDirection="column" flexGrow={1}>
              {settings.services.length === 0 && (
                <Text dimColor>No services set. Add name=URL pairs under /plugin configure session-hub.</Text>
              )}
              {settings.services.map(svc => {
                const s = watched.find(w => w.name === svc.name)
                const queued =
                  s?.running == null ? '' : ` · ${s.running > 0 ? '▶ busy' : 'idle'}${s.pending ? ` +${s.pending} queued` : ''}`
                return (
                  <Box key={`svc-${svc.name}`} flexDirection="column" marginBottom={1}>
                    <Text wrap="truncate-end">
                      {s === undefined ? (
                        <Text dimColor>○ </Text>
                      ) : s.isUp ? (
                        <Text color="#00E5FF">● </Text>
                      ) : (
                        <Text color="#FF2E9E">● </Text>
                      )}
                      <Text bold>{svc.name}</Text>{' '}
                      <Text dimColor>
                        {s === undefined ? 'checking…' : s.isUp ? `up ${s.ms ?? 0}ms` : `down: ${s.error ?? ''}`}
                      </Text>
                    </Text>
                    {s?.gpu != null && (
                      <Text dimColor wrap="truncate-end">
                        {'  '}
                        {s.gpu}
                        {s.vramFree != null && s.vramTotal != null ? ` · ${gb(s.vramFree)}/${gb(s.vramTotal)} GB free` : ''}
                        {queued}
                      </Text>
                    )}
                    <Text dimColor wrap="truncate-middle">
                      {'  '}
                      {svc.url}
                    </Text>
                  </Box>
                )
              })}
              <Box gap={1}>
                {settings.services.length > 0 && (
                  <Button key="services-check" label="Check now" onPress={() => void checkServices($)} />
                )}
                <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($)} />
              </Box>
              {settings.services.length > 0 && <Text dimColor>every {SERVICE_POLL_MS / 1000}s while this tab is open</Text>}
            </Box>
          )}
          {shownTab === 'links' && (
            <Box key="links-view" flexDirection="column" flexGrow={1}>
              {saved.length === 0 && (
                <Text dimColor>Paths and web links from this session's answers and the files it writes show here.</Text>
              )}
              {saved.slice(0, linkRoom).map((l, i) => (
                <Box key={`link-${i}`}>
                  <Text wrap="truncate-middle">
                    <Text color={l.isFile ? '#00E5FF' : '#B14EFF'}>{l.isFile ? '▤ ' : '◎ '}</Text>
                    <Link href={l.href}>{l.text}</Link>
                  </Text>
                </Box>
              ))}
              {saved.length > linkRoom && <Text dimColor>{saved.length - linkRoom} older</Text>}
              <Box marginTop={1} gap={1}>
                {saved.length > 0 && (
                  <Button key="links-clear" label="Clear" onPress={() => void update($, links, () => [])} />
                )}
                <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($)} />
              </Box>
              {saved.length > 0 && <Text dimColor>ctrl+click opens one</Text>}
            </Box>
          )}
          {shownTab === 'sessions' && (
            <Box key="sessions-view" flexDirection="column" flexGrow={1}>
              {chosen === undefined && (
                <Box flexDirection="column">
                  {Input !== undefined && editing === SELF_ROW ? (
                    <Box key="rename-self-row" gap={1}>
                      <Input
                        key="rename-input-self"
                        label={`${PENCIL} `}
                        value={me ?? ''}
                        submitLabel="rename"
                        autoFocus
                        onSubmit={text => void askRename($, null, text)}
                      />
                      <Button key="rename-cancel" label="Cancel" onPress={() => void update($, renaming, () => null)} />
                    </Box>
                  ) : (
                    <Box key="me">
                      <Text bold wrap="truncate-end">
                        {me ?? 'This session'}
                      </Text>
                      {/* the name is known once the list came back */}
                      {Input !== undefined && me !== null && (
                        <Button key="rename-self" plain onPress={() => void update($, renaming, () => SELF_ROW)}>
                          {` ${PENCIL}`}
                        </Button>
                      )}
                    </Box>
                  )}
                  {attached.length > 0 && <Text dimColor>also on {attached.join(', ')}</Text>}
                  {waits.length > 0 && (
                    <Box
                      key="needs"
                      flexDirection="column"
                      marginTop={1}
                      borderStyle="round"
                      borderColor={AMBER}
                      paddingX={1}
                    >
                      <Text bold color={AMBER}>
                        Needs you <Text dimColor>({waits.length})</Text>
                      </Text>
                      {waits.map(w => {
                        const name = clip(waitName(w), 16)
                        const label = WAIT_LABEL[w.kind]
                        // its own border and padding take four more columns
                        const asked = clip(w.detail, Math.max(8, width - name.length - label.length - 12))
                        const line = [
                          <Text key="mark" color={AMBER}>
                            {'? '}
                          </Text>,
                          `${name} `,
                          <Text key="what" dimColor>
                            {label}: {asked}
                          </Text>,
                        ]
                        // a marker with no name has no thread to open
                        return w.name === null ? (
                          <Text key={`needs-${w.id}`}>{line}</Text>
                        ) : (
                          <Button key={`needs-${w.id}`} plain onPress={() => void toggleThread($, w.name ?? '')}>
                            {line}
                          </Button>
                        )
                      })}
                    </Box>
                  )}
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
                            {clip(
                              firstLine(waiting.at(-1)?.text ?? ''),
                              Math.max(8, width - Math.min(16, peer.length) - 8),
                            )}
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
                        {rows.length === 0 && <Text dimColor> none</Text>}
                        {rows.map(peer => {
                          const waiting = unreadBy.get(peer.name)?.length ?? 0
                          const badge = waiting > 0 ? ` ●${waiting}` : ''
                          const asks = waits.find(w => isWaitFor(w, peer))
                          const detail =
                            asks !== undefined
                              ? WAIT_LABEL[asks.kind]
                              : !isNarrow && peer.started !== null
                                ? `${peer.status} · ${peer.started}`
                                : peer.status
                          // only a session on this PC reads the request folder
                          const canRename =
                            Input !== undefined && group === 'local' && peer.ref !== '' && isOnline(peer)
                          if (canRename && editing === peer.ref) {
                            return (
                              <Box key={`row-${peer.ref}`} gap={1}>
                                <Input
                                  key={`rename-input-${peer.ref}`}
                                  label={`  ${PENCIL} `}
                                  value={peer.name}
                                  submitLabel="rename"
                                  autoFocus
                                  onSubmit={text => void askRename($, peer, text)}
                                />
                                <Button
                                  key="rename-cancel"
                                  label="Cancel"
                                  onPress={() => void update($, renaming, () => null)}
                                />
                              </Box>
                            )
                          }
                          return (
                            <Box key={`row-${peer.ref}`}>
                              <Button key={`peer-${peer.ref}`} plain onPress={() => void toggleThread($, peer.name)}>
                                {asks !== undefined ? <Text color={AMBER}>? </Text> : '  '}
                                {clip(
                                  peer.name,
                                  Math.max(8, width - detail.length - badge.length - (canRename ? 6 : 4)),
                                )}
                                {badge}{' '}
                                {asks !== undefined ? (
                                  <Text color={AMBER}>{detail}</Text>
                                ) : (
                                  <Text dimColor>{detail}</Text>
                                )}
                              </Button>
                              {canRename && (
                                <Button
                                  key={`rename-${peer.ref}`}
                                  plain
                                  onPress={() => void update($, renaming, () => peer.ref)}
                                >
                                  {` ${PENCIL}`}
                                </Button>
                              )}
                            </Box>
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
                  {chosenWait !== undefined && (
                    <Text color={AMBER} wrap="truncate-end">
                      ? {WAIT_LABEL[chosenWait.kind]}: {chosenWait.detail}, answer it in that session
                    </Text>
                  )}
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
                {chosen !== undefined && (
                  <Button key="back" label="Back" onPress={() => void update($, target, () => null)} />
                )}
                {unreadBy.size > 0 && (
                  <Button
                    key="read-all"
                    label="Mark read"
                    onPress={() =>
                      void update($, messages, ms => ms.map(m => (isUnread(m) ? { ...m, isRead: true } : m)))
                    }
                  />
                )}
                <Button key="close" label="Close" role="dismiss" onPress={() => void closePane($)} />
              </Box>
              <Text dimColor>{refreshing}</Text>
            </Box>
          )}
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
