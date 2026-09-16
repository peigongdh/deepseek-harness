import { describe, expect, it, vi } from 'vitest'
import type { ISessions, SessionBinding, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createEnhancedChildren } from '../src/client/enhanced-children.ts'
import { EMPTY_TRAJECTORY_SNAPSHOT } from '../src/client/trajectory-snapshot-builder.ts'
import { EMPTY_ENHANCED_FACTS } from '../src/client/enhanced-facts.ts'

const parent = 'parent' as SessionId
const child = 'child' as SessionId
const grandchild = 'grandchild' as SessionId

function bench() {
  const session = createSnapshotStore({ openState: 'open', openError: null, hasMore: true } as SessionSnapshot)
  const loadOlder = vi.fn(async () => {})
  const release = vi.fn()
  const binding = { session: { ...session, loadOlder } } as unknown as SessionBinding
  const refresh = vi.fn(async () => {})
  const observe = vi.fn(() => ({ binding, release }))
  const sessions = {
    refreshSubagents: refresh, observeSubagent: observe,
    list: { getSnapshot: () => ({ subagentsByParent: {
      [parent]: { entries: [{ kind: 'child', id: child, mode: 'continuable' }] },
      [child]: { entries: [{ kind: 'child', id: grandchild, mode: 'one-shot' }] },
    } }) },
  } as unknown as ISessions
  const trajectory = createSnapshotStore(EMPTY_TRAJECTORY_SNAPSHOT)
  const facts = createSnapshotStore(EMPTY_ENHANCED_FACTS)
  const controller = createEnhancedChildren(sessions, () => trajectory, () => facts)
  return { controller, release, refresh, observe, session, loadOlder, trajectory }
}

describe('enhanced child observation lifecycle', () => {
  it('loads on demand, follows updates, pages independently, and releases descendants', async () => {
    const b = bench()
    const unsubscribe = b.controller.subscribe(() => {})
    try {
      expect(b.observe).not.toHaveBeenCalled()
      await b.controller.expand(parent, child)
      await b.controller.expand(parent, child)
      expect(b.observe).toHaveBeenCalledTimes(1)
      expect(b.controller.getSnapshot().get(child)?.status).toBe('ready')
      b.session.set({ ...b.session.getSnapshot(), hasMore: false })
      expect(b.controller.getSnapshot().get(child)?.session?.hasMore).toBe(false)
      await b.controller.loadOlder(child)
      expect(b.loadOlder).toHaveBeenCalledTimes(1)
      await b.controller.expand(child, grandchild)
      b.controller.collapse(child)
      expect(b.controller.getSnapshot().size).toBe(0)
      expect(b.release).toHaveBeenCalledTimes(2)
      b.trajectory.set({ ...EMPTY_TRAJECTORY_SNAPSHOT })
      expect(b.controller.getSnapshot().size).toBe(0)
    } finally { unsubscribe() }
  })

  it('does not attach after the last subscriber leaves during discovery', async () => {
    const b = bench()
    let resolve!: () => void
    b.refresh.mockImplementation(() => new Promise<void>((done) => { resolve = done }))
    const unsubscribe = b.controller.subscribe(() => {})
    const pending = b.controller.expand(parent, child)
    expect(b.controller.getSnapshot().get(child)?.status).toBe('loading')
    unsubscribe()
    resolve()
    await pending
    expect(b.observe).not.toHaveBeenCalled()
    expect(b.controller.getSnapshot().size).toBe(0)
  })

  it('shows discovery failures and permits an explicit collapse and retry', async () => {
    const b = bench()
    const unsubscribe = b.controller.subscribe(() => {})
    try {
      b.refresh.mockRejectedValueOnce(new Error('offline'))
      await b.controller.expand(parent, child)
      expect(b.controller.getSnapshot().get(child)).toMatchObject({ status: 'error', error: 'Error: offline' })
      b.controller.collapse(child)
      await b.controller.expand(parent, child)
      expect(b.controller.getSnapshot().get(child)?.status).toBe('ready')
    } finally { unsubscribe() }
    expect(b.release).toHaveBeenCalledTimes(1)
  })
})
