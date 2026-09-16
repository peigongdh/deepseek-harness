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
import { schedulingOverlap } from '../src/client/enhanced-scheduling.ts'
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

  it('connects interleaved Workflow members by run and member identity, including partial history', () => {
    const events = [
      user(0, 'first', 'Review'),
      event(1, 'tool-workflow/run-start', { runId: 'a', name: 'Review' }),
      event(2, 'tool-workflow/agent-start', { runId: 'a', seq: 0, childId: 'a0', label: 'Read' }),
      event(3, 'tool-workflow/agent-start', { runId: 'b', seq: 0, childId: 'b0', label: 'Audit' }),
      event(4, 'tool-workflow/agent-start', { runId: 'a', seq: 1, childId: 'a1', label: 'Check' }),
      event(5, 'tool-workflow/agent-end', { runId: 'a', seq: 1, outcome: 'completed' }),
      event(6, 'tool-workflow/agent-end', { runId: 'b', seq: 0, outcome: 'completed' }),
      event(7, 'tool-workflow/agent-end', { runId: 'a', seq: 0, outcome: 'completed' }),
      event(8, 'tool-workflow/run-end', { runId: 'a', stopReason: 'completed' }),
    ]
    const items = assembly(events).model().groups.flatMap(group => group.items)
    const node = (seq: number) => items.find(item => item.seq === seq)?.mechanism
    expect(node(3)?.missingOrigin).toBe(true)
    expect(node(5)?.links.map(link => link.seq)).toEqual([4])
    expect(node(6)?.links.map(link => link.seq)).toEqual([3])
    expect(node(6)?.missingOrigin).toBe(false)
    expect(node(7)?.links.map(link => link.seq)).toEqual([2])
    expect(node(8)?.links.map(link => link.seq)).toEqual([5, 7])
    expect(node(8)?.links.some(link => link.seq === 6)).toBe(false)
  })

  it('links Goal continuations to the recorded revision and keeps Todo and Plan independent', () => {
    const { model } = assembly([
      user(0, 'first', 'Plan'),
      event(1, 'goal/change', { operation: 'create', goal: { id: 'goal', revision: 1, objective: 'Finish' } }),
      event(2, 'plan/mode', { active: true }),
      event(3, 'todo/write', { todos: [{ content: 'Read', status: 'pending' }] }),
      event(4, 'goal/change', { operation: 'edit', goal: { id: 'goal', revision: 2, objective: 'Finish carefully' } }),
      user(5, 'continue', 'Continue', { kind: 'goal', goalId: 'goal', revision: 1, round: 2 }),
      user(6, 'missing', 'Continue', { kind: 'goal', goalId: 'other', revision: 1, round: 1 }),
      event(7, 'todo/write', { todos: [{ content: 'Renamed', status: 'completed' }] }),
      event(8, 'plan/mode', { active: false }),
      event(9, 'goal/change', { operation: 'complete', goal: { id: 'goal', revision: 3, objective: 'Finish carefully', phase: 'complete' } }),
    ])
    const items = model().groups.flatMap(group => group.items)
    const at = (seq: number) => items.find(item => item.seq === seq)
    expect(at(5)?.mechanism?.links.map(link => link.seq)).toEqual([1])
    expect(at(5)?.lane).toBe('tool')
    expect(at(5)?.cell.messageSource).toMatchObject({ kind: 'goal', revision: 1 })
    expect(at(6)?.mechanism).toMatchObject({ missingOrigin: true, links: [] })
    expect(at(7)?.mechanism?.links.map(link => link.seq)).toEqual([3])
    expect(at(7)?.mechanism?.summary).toContain('Pending 1')
    expect(at(7)?.mechanism?.summary).toContain('Complete 1')
    expect(at(8)?.mechanism?.links.map(link => link.seq)).toEqual([2])
    expect(at(9)?.mechanism?.links.map(link => link.seq)).toEqual([4])
  })

  it('distinguishes Agent messages from runtime settlement and does not join inherited child identities', () => {
    const { model } = assembly([
      user(0, 'first', 'Delegate'),
      event(1, 'subagent/catalog', { childId: 'child', mode: 'continuable', version: 1, label: 'Research' }),
      user(2, 'message', 'Progress', { kind: 'agent-message', senderSessionId: 'child', form: 'relay' }),
      user(3, 'done', 'Finished', { kind: 'subagent-settled', senderSessionId: 'child', form: 'notice', summary: 'Completed' }),
      event(4, 'session/end-seed', { inherited: true }),
      user(5, 'own', 'Own work'),
      user(6, 'unloaded', 'Progress', { kind: 'agent-message', senderSessionId: 'child', form: 'relay' }),
    ])
    const items = model().groups.flatMap(group => group.items)
    const at = (seq: number) => items.find(item => item.seq === seq)?.mechanism
    expect(at(2)?.links.map(link => link.seq)).toEqual([1])
    expect(at(3)?.links.map(link => link.seq)).toEqual([1])
    expect(at(2)?.title).not.toBe(at(3)?.title)
    expect(at(6)).toMatchObject({ missingOrigin: true, links: [] })
  })

  it.each([
    ['started subagent child', false, [2]],
    ['The agent says: started subagent child', false, []],
    ['started subagent child', true, []],
  ])('correlates only an exact successful delegation receipt: %s, error %s', (text, isError, linkedSeqs) => {
    const { model } = assembly([
      event(0, 'turn/start', { turn: 1 }), event(1, 'step/start', { turn: 1, step: 1 }),
      event(2, 'tool/call', { turn: 1, step: 1, callId: 'dispatch', name: 'subagent', arguments: '{}' }),
      event(3, 'subagent/catalog', { childId: 'child', mode: 'continuable', version: 1 }),
      event(4, 'tool/result', { turn: 1, step: 1, message: { id: 'receipt', role: 'user', source: { kind: 'tool', callId: 'dispatch' },
        content: [{ type: 'tool-result', toolCallId: 'dispatch', content: [{ type: 'text', text }], isError }] } }),
    ])
    const child = model().groups.flatMap(group => group.items).find(item => item.seq === 3)
    expect(child?.mechanism?.links.map(link => link.seq)).toEqual(linkedSeqs)
    expect(child?.mechanism?.title).toBe('Child registered')
  })

  it('aggregates a Workflow into member lifecycles and keeps a later run receipt chronological', () => {
    const { model } = assembly([
      user(0, 'request', 'Review'),
      event(1, 'tool-workflow/run-start', { runId: 'run', name: 'Review' }),
      event(2, 'tool-workflow/agent-start', { runId: 'run', seq: 1, childId: 'a', label: 'Read', phase: 'audit' }),
      event(3, 'tool-workflow/agent-start', { runId: 'run', seq: 2, childId: 'b', label: 'Check', phase: 'audit' }),
      event(4, 'tool-workflow/agent-end', { runId: 'run', seq: 2, outcome: 'completed' }),
      event(5, 'tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'failed' }),
      event(6, 'tool-workflow/agent-start', { runId: 'run', seq: 3, childId: 'c', label: 'Verify', phase: 'review' }),
      event(7, 'tool-workflow/agent-end', { runId: 'run', seq: 3, outcome: 'completed' }),
      event(8, 'turn/start', { turn: 1 }),
      event(9, 'tool-workflow/run-end', { runId: 'run', stopReason: 'completed' }),
    ])
    const projection = model().scheduling
    const block = [...projection.blocks.values()][0]!
    expect(projection.blocks.size).toBe(1)
    expect(block.members.map(row => [row.label, row.phase, row.start?.seq, row.end?.seq])).toEqual([
      ['Read', 'audit', 2, 5], ['Check', 'audit', 3, 4], ['Verify', 'review', 6, 7],
    ])
    expect(schedulingOverlap(block.members)).toBe('overlap')
    expect(schedulingOverlap([block.members[0]!, block.members[2]!])).toBe('sequential')
    expect(projection.receipts.get('fact:9')?.block).toBe(block)
    expect(block.members[0]?.end?.mechanism?.outcome).toBe('failed')
    expect(block.end?.mechanism?.outcome).toBe('completed')
  })

  it('keeps missing Workflow starts unknown and reconciles the same raw end after prepend', () => {
    const start = event(1, 'tool-workflow/agent-start', { runId: 'run', seq: 1, childId: 'a', label: 'Audit' })
    const end = event(2, 'tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'completed' })
    const { value, model } = assembly([end], true)
    const partial = [...model().scheduling.blocks.values()][0]!
    expect(partial.members[0]?.start).toBeUndefined()
    expect(schedulingOverlap(partial.members)).toBe('unknown')
    const id = partial.members[0]!.end!.id
    value.replaceWindow([start, end], false)
    value.flush()
    const full = [...model(false).scheduling.blocks.values()][0]!
    expect(full.members[0]?.start?.seq).toBe(1)
    expect(full.members[0]?.end?.id).toBe(id)
    expect(full.anchor.id).toBe('fact:1')
  })

  it('groups one dispatch batch, matches reverse registrations, and retains delayed receipts across requests', () => {
    const result = (seq: number, callId: string, child: string) => event(seq, 'tool/result', { turn: 1, step: 1,
      message: { id: `result-${callId}`, role: 'user', source: { kind: 'tool', callId },
        content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: `started subagent ${child}` }] }] } })
    const { model } = assembly([
      user(0, 'request', 'Review'), event(1, 'turn/start', { turn: 1 }), event(2, 'step/start', { turn: 1, step: 1 }),
      event(3, 'tool/call', { turn: 1, step: 1, callId: 'a', name: 'subagent', arguments: '{"description":"Read"}' }),
      event(4, 'tool/call', { turn: 1, step: 1, callId: 'b', name: 'subagent_fork', arguments: '{"description":"Check"}' }),
      event(5, 'subagent/catalog', { childId: 'child-b', mode: 'continuable', version: 1, label: 'Check' }),
      event(6, 'subagent/catalog', { childId: 'child-a', mode: 'continuable', version: 1, label: 'Read' }),
      result(7, 'a', 'child-a'), result(8, 'b', 'child-b'),
      event(9, 'step/end', { turn: 1, step: 1 }), event(10, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
      user(11, 'next', 'Explain'),
      user(12, 'message', 'Finding', { kind: 'agent-message', form: 'relay', senderSessionId: 'child-a' }),
      user(13, 'notice', 'Finished', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-a' }),
      user(14, 'notice-again', 'Finished again', { kind: 'subagent-settled', form: 'notice', senderSessionId: 'child-a' }),
    ])
    const value = model()
    const block = [...value.scheduling.blocks.values()][0]!
    expect(value.scheduling.blocks.size).toBe(1)
    expect(block.members.map(row => [row.label, row.start?.seq, row.child?.seq])).toEqual([['Read', 3, 6], ['Check', 4, 5]])
    expect(block.members[1]?.start?.mechanism?.fork).toBe(true)
    expect(block.members[0]?.notices.map(item => item.seq)).toEqual([13, 14])
    expect(value.scheduling.receipts.size).toBe(3)
    expect([...value.scheduling.receipts.values()].every(receipt => receipt.block === block)).toBe(true)
    expect(value.groups.at(-1)?.items.some(item => item.seq === 12)).toBe(true)
    expect(block.members[1]?.end).toBeUndefined()
  })
})
