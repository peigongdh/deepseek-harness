import type { Context } from '@deepseek-ai/cordis'
import type { SessionLiveEventEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import {
  ConversationNodeAssembler, inspectRequestPrompt,
  type ConversationNodeDefinition, type ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { describe, expect, it } from 'vitest'
import { inspectSystemPrompt } from '../../ui-conversation/src/client/contract/system-prompt.ts'
import { registerTrajectoryMessageDefinitions } from '../src/client/trajectory-message-definitions.ts'
import { registerTrajectoryRequestHeaderDefinition } from '../src/client/trajectory-request-header-definition.ts'
import { registerTrajectoryAssistantDefinition } from '../src/client/trajectory-assistant-definition.ts'
import { registerTrajectoryToolDefinition } from '../src/client/trajectory-tool-definition.ts'
import { registerTrajectoryCompactionDefinitions } from '../src/client/trajectory-compaction-definition.ts'
import { registerTrajectoryConversationView } from '../src/client/trajectory-snapshot-builder.ts'
import { registerEnhancedFacts } from '../src/client/enhanced-facts.ts'
import { deriveEnhancedModel, enhancedCapability } from '../src/client/enhanced-model.ts'
import { t } from './locale.client.ts'

function event(seq: number, type: string, data: unknown): SessionLiveEventEntry {
  return { type: 'event', event: { seq, type, time: 1_700_000_000_000 + seq, data } as SessionEvent }
}

function user(seq: number, id: string, text: string, source: unknown = { kind: 'user' }): SessionLiveEventEntry {
  return event(seq, 'user/message', { id, role: 'user', source, content: [{ type: 'text', text }] })
}

function assembly(events: readonly SessionLiveEventEntry[], hasMore = false) {
  const definitions: ConversationNodeDefinition[] = []
  const views: ConversationViewDefinition[] = []
  const ctx = { uiConversation: {
    events: { register: (value: ConversationNodeDefinition) => definitions.push(value) },
    views: { register: (value: ConversationViewDefinition) => views.push(value) },
    inspectRequestPrompt, inspectSystemPrompt,
  } } as unknown as Context
  registerTrajectoryMessageDefinitions(ctx)
  registerTrajectoryRequestHeaderDefinition(ctx)
  registerTrajectoryAssistantDefinition(ctx)
  registerTrajectoryToolDefinition(ctx)
  registerTrajectoryCompactionDefinitions(ctx)
  registerTrajectoryConversationView(ctx)
  registerEnhancedFacts(ctx)
  const value = new ConversationNodeAssembler(
    { entries: () => definitions, fallbackEntry: () => undefined }, { entries: () => views },
  )
  value.replaceWindow(events, hasMore)
  value.activateTarget('trajectory')
  value.activateTarget('enhanced-trajectory')
  return {
    value,
    model: (partial = hasMore) => deriveEnhancedModel(value.get('trajectory')!, value.get('enhanced-trajectory')!, partial, t),
  }
}

describe('enhanced request projection', () => {
  it('starts a request when next-step input was queued while idle before the turn opened', () => {
    const { model } = assembly([
      event(0, 'plan/mode', { active: true }),
      event(1, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ id: 'first' }] }),
      event(2, 'turn/start', { turn: 1 }),
      event(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      user(4, 'first', 'Plan the work'),
    ])
    expect(model().groups.map(group => [group.kind, group.title])).toEqual([['request', 'Plan the work']])
  })

  it('keeps claimed steering and automatic turns with the request, then separates a new user request', () => {
    const events = [
      event(0, 'turn/start', { turn: 1 }), user(1, 'first', 'Investigate'),
      event(2, 'agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [{ id: 'steer' }] }),
      event(3, 'agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }),
      user(4, 'steer', 'Keep the scope small'), event(5, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(6, 'turn/start', { turn: 2 }), user(7, 'auto', 'Continue', { kind: 'goal', goalId: 'goal', revision: 1 }),
      event(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }), event(9, 'turn/start', { turn: 3 }), user(10, 'next', 'Explain the result'),
    ]
    const { model } = assembly(events)
    const groups = model().groups
    expect(groups.map(group => group.title)).toEqual(['Investigate', 'Explain the result'])
    expect(groups[0]?.items.filter(item => item.cell.kind === 'user')).toHaveLength(2)
    expect(groups[0]?.items.some(item => item.cell.previewMarkdown === 'Continue')).toBe(true)
  })

  it('places a manual compaction and its checkpoint between user requests', () => {
    const { model } = assembly([
      event(0, 'turn/start', { turn: 1 }), user(1, 'first', 'First'), event(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      event(3, 'compaction/start', { compactionId: 'compact', turn: null }),
      user(4, 'checkpoint', 'Checkpoint', { kind: 'plugin', plugin: 'compact', compactionId: 'compact' }),
      event(5, 'compaction/end', { compactionId: 'compact' }),
      event(6, 'turn/start', { turn: 2 }), user(7, 'auto', 'Continue', { kind: 'goal', goalId: 'goal', revision: 1 }),
      event(8, 'turn/end', { turn: 2, reason: { kind: 'completed' } }),
      event(9, 'turn/start', { turn: 3 }), user(10, 'second', 'Second'),
    ])
    expect(model().groups.map(group => group.kind)).toEqual(['request', 'interlude', 'request'])
    expect(model().groups[1]?.items.map(item => item.seq)).toEqual([3, 4])
    expect(model().groups[0]?.items.some(item => item.seq === 7)).toBe(true)
  })

  it('does not report unloaded requests for a complete context-only Session', () => {
    const { model } = assembly([user(0, 'context', 'Reference', { kind: 'session-reference', references: [] })])
    expect(model().groups[0]?.kind).toBe('context')
    expect(model().groups[0]?.title).toBe('Session context')
  })

  it('reconciles a tail-only request on prepend without changing record identities', () => {
    const head = [event(0, 'turn/start', { turn: 1 }), user(1, 'first', 'First')]
    const tail = [user(2, 'context', 'Reference', { kind: 'session-reference', references: [] })]
    const { value, model } = assembly(tail, true)
    expect(model().groups[0]?.kind).toBe('incomplete')
    const id = model().groups[0]?.items[0]?.id
    value.replaceWindow([...head, ...tail], false)
    value.flush()
    expect(model(false).groups).toHaveLength(1)
    expect(model(false).groups[0]?.items.some(item => item.id === id)).toBe(true)
    expect(model(false).groups[0]?.title).toBe('First')
  })

  it('uses durable workflow child references once and labels a fork prefix as inherited', () => {
    const { model } = assembly([
      user(0, 'prefix', 'Inherited'), event(1, 'session/end-seed', { inherited: true }),
      user(2, 'own', 'Own work'),
      event(3, 'subagent/catalog', { childId: 'child', mode: 'one-shot', version: 0 }),
      event(4, 'tool-workflow/agent-start', { runId: 'run', childId: 'child', seq: 1, label: 'Audit', phase: 'review' }),
    ])
    const items = model().groups.flatMap(group => group.items)
    expect(items.find(item => item.seq === 0)?.inherited).toBe(true)
    expect(items.find(item => item.seq === 2)?.inherited).toBe(false)
    expect(items.filter(item => item.childId === 'child')).toHaveLength(1)
    expect(items.find(item => item.childId === 'child')?.cell.previewMarkdown).toBe('review · Audit')
  })

  it('exposes plan and state evidence without inventing tool calls', () => {
    const { model } = assembly([
      user(0, 'first', 'Plan'), event(1, 'plan/mode', { active: true }),
      event(2, 'goal/change', { operation: 'create', goal: { objective: 'Finish' } }),
      event(3, 'todo/write', { todos: [] }),
    ])
    const evidence = model().groups.flatMap(group => group.items).filter(item => item.evidence)
    expect(evidence).toHaveLength(3)
    expect(evidence.every(item => item.cell.callId === undefined && item.capability === 'planning')).toBe(true)
  })

  it('leaves unknown and shell tools honest about their recorded identity', () => {
    expect(enhancedCapability('third_party_reflect')).toBe('other')
    expect(enhancedCapability('bash')).toBe('files')
    expect(enhancedCapability('skill')).toBe('skills')
    expect(enhancedCapability('ask_user_question')).toBe('human')
  })
})
