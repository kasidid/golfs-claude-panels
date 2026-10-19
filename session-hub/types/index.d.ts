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

export type PanelTab = 'sessions'

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
    }
  }
}
