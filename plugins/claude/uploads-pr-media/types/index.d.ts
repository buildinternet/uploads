export type Binding = 'self' | 'none' | 'other' | 'unknown'

/** What `uploads staged --format json` reported for the current branch. */
export type Staged = {
  repo: string
  branch: string
  count: number
  binding: Binding
  autoAttach: boolean
}

/** The last PR this session opened that had staged files waiting for it. */
export type Attached = {
  repo: string
  branch: string
  pr: number
  count: number
  via: 'app' | 'cli'
}

declare module 'claude-code' {
  interface PluginState {
    'uploads-pr-media': {
      staged: Staged | null
      attached: Attached | null
      isHidden: boolean
    }
  }
}
