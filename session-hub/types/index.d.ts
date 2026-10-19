export type PeerGroup = 'local' | 'remote' | 'cloud'

export type Peer = {
  name: string
  ref: string
  group: PeerGroup
  type: string
  status: string
  started: string | null
}

export type PeerMessage = {
  id: string
  peer: string
  isOutgoing: boolean
  text: string
  at: number
  isRead: boolean
}

// A session blocked on the person, as that session's own session-hub writes it
// to the shared folder; `at` is its heartbeat, so a crashed one goes stale.
export type PeerWaiting = {
  id: string
  name: string | null
  ref: string | null
  cwd: string | null
  kind: 'question' | 'permission' | 'plan'
  detail: string
  since: number
  at: number
}

export type PanelTab = 'tasks' | 'sessions' | 'links' | 'services'

// one watched service as its last check found it; the ComfyUI fields only where it answered as one
export type ServiceState = {
  name: string
  url: string
  isUp: boolean
  ms: number | null
  error: string | null
  gpu: string | null
  vramFree: number | null
  vramTotal: number | null
  running: number | null
  pending: number | null
}

// a task of this session's, as its task tools (TaskCreate, TaskUpdate, TodoWrite) left it
export type TaskItem = { id: string; subject: string; status: 'pending' | 'in_progress' | 'completed'; at: number }

// a URL or a file path the session's answers or writes named, newest first
export type LinkItem = { href: string; text: string; isFile: boolean; at: number }

export type PanelLimit = { kind: string; percentUsed: number; resetsAt: string | null }

// what the bottom box draws: the status line's figures, read natively
export type PanelStatus = {
  model: string | null
  effort: string | null
  host: string | null
  cwd: string | null
  branch: string | null
  dirty: number
  limits: PanelLimit[]
  contextPercent: number | null
  contextTokens: number | null
  contextWindow: number | null
  costUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-hub': {
      peers: Peer[]
      self: string | null
      surfaces: string[]
      messages: PeerMessage[]
      target: string | null
      note: string | null
      updatedAt: number
      isManual: boolean
      isDocked: boolean
      isSidebarDismissed: boolean
      tab: PanelTab
      status: PanelStatus | null
      waiting: PeerWaiting[]
      // the ref of the row whose name is being edited, `self` for this session's own
      renaming: string | null
      links: LinkItem[]
      tasks: TaskItem[]
      services: ServiceState[]
    }
  }
}
