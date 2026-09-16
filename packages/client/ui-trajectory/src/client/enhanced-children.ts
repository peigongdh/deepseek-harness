/** Demand-loaded child Session observations owned by one enhanced view. */
import type { ISessions, SessionBinding, SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import type { EnhancedFact } from './enhanced-facts.ts'

/** Loaded child evidence, or an explicit pending/failure state. */
export interface EnhancedChild {
  readonly parentId: SessionId
  readonly childId: SessionId
  readonly status: 'loading' | 'ready' | 'error'
  readonly error?: string
  readonly session?: SessionSnapshot
  readonly trajectory?: TrajectorySnapshot
  readonly facts?: readonly EnhancedFact[]
}

/** A view's expanded child snapshots; descendants use the same source. */
export type EnhancedChildren = ReadonlyMap<SessionId, EnhancedChild>

/** Child observation controls injected separately from the framework-bound hook. */
export interface EnhancedChildrenController extends ObservableSnapshot<EnhancedChildren> {
  /** @param parentId - Direct catalog owner. @param childId - Recorded child to expand. */
  expand(this: void, parentId: SessionId, childId: SessionId): Promise<void>
  /** @param childId - Child whose observation and descendants should be released. */
  collapse(this: void, childId: SessionId): void
  /** @param childId - Expanded child. @returns Completion of its ordinary history page request. */
  loadOlder(this: void, childId: SessionId): Promise<void>
  /** Release all observers without canceling any Agent. */
  dispose(): void
}

/**
 * Own child subscriptions outside React; the final view unsubscribe releases every attachment.
 * @param sessions - Authenticated Session access service.
 * @param trajectorySource - Existing raw trajectory source for a binding.
 * @param factsSource - Mechanism evidence source for a binding.
 * @returns A stable observable and child loading controls.
 */
export function createEnhancedChildren(
  sessions: ISessions,
  trajectorySource: (binding: SessionBinding) => ObservableSnapshot<TrajectorySnapshot>,
  factsSource: (binding: SessionBinding) => ObservableSnapshot<readonly EnhancedFact[]>,
): EnhancedChildrenController {
  let snapshot: EnhancedChildren = new Map()
  const listeners = new Set<() => void>()
  const entries = new Map<SessionId, { parentId: SessionId; release: () => void; binding?: SessionBinding }>()
  const publish = () => { for (const listener of listeners) listener() }
  const set = (id: SessionId, value: EnhancedChild) => {
    snapshot = new Map(snapshot).set(id, value)
    publish()
  }
  const collapse = (childId: SessionId) => {
    const entry = entries.get(childId)
    if (entry === undefined) return
    entries.delete(childId)
    for (const [id, descendant] of entries) {
      if (descendant.parentId === childId) collapse(id)
    }
    entry.release()
    const next = new Map(snapshot)
    next.delete(childId)
    snapshot = next
    publish()
  }
  const dispose = () => { for (const id of entries.keys()) collapse(id) }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) dispose()
      }
    },
    async expand(parentId, childId) {
      if (entries.has(childId)) return
      const entry: { parentId: SessionId; release: () => void; binding?: SessionBinding } = { parentId, release: () => {} }
      entries.set(childId, entry)
      set(childId, { parentId, childId, status: 'loading' })
      try {
        await sessions.refreshSubagents(parentId)
        if (entries.get(childId) !== entry) return
        const child = sessions.list.getSnapshot().subagentsByParent[parentId]?.entries.find(candidate =>
          candidate.kind === 'child' && candidate.id === childId)
        if (child?.kind !== 'child') throw new Error('Subagent catalog entry is unavailable')
        const observation = sessions.observeSubagent({ parentSessionId: parentId, childSessionId: childId, mode: child.mode })
        entry.binding = observation.binding
        const trajectory = trajectorySource(observation.binding)
        const facts = factsSource(observation.binding)
        const refresh = () => {
          if (entries.get(childId) !== entry) return
          const session = observation.binding.session.getSnapshot()
          set(childId, {
            parentId, childId, session,
            status: session.openState === 'error' ? 'error' : session.openState === 'open' ? 'ready' : 'loading',
            ...(session.openError === null ? {} : { error: session.openError.message }),
            trajectory: trajectory.getSnapshot(), facts: facts.getSnapshot(),
          })
        }
        const unsubscribers: (() => void)[] = []
        entry.release = () => { for (const unsubscribe of unsubscribers) unsubscribe(); observation.release() }
        unsubscribers.push(observation.binding.session.subscribe(refresh), trajectory.subscribe(refresh), facts.subscribe(refresh))
        refresh()
      } catch (error) {
        if (entries.get(childId) === entry) {
          entry.release()
          entry.release = () => {}
          set(childId, { parentId, childId, status: 'error', error: String(error) })
        }
      }
    },
    collapse,
    async loadOlder(childId) { await entries.get(childId)?.binding?.session.loadOlder() },
    dispose,
  }
}
