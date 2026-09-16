/** Request grouping and capability presentation derived from loaded evidence. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { deriveTrajectoryLayout, type TrajectoryTurnModel } from './layout.ts'
import type { EnhancedFact } from './enhanced-facts.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import { trajectoryRecordId, type TrajectoryCellProps } from './trajectory-record.ts'
import type { TrajectoryTranslate } from './locales.ts'

/** Stable capability palette; status is independent from category. */
export type EnhancedCapability = 'files' | 'search' | 'skills' | 'planning' | 'agents' | 'workflow' | 'human' | 'artifacts' | 'other'

const TOOL_CAPABILITIES: Readonly<Record<string, EnhancedCapability>> = {
  read: 'files', read_image: 'files', write: 'files', edit: 'files', bash: 'files', pwsh: 'files',
  str_replace_editor: 'files', terminal_open: 'files', terminal_send: 'files', terminal_read: 'files',
  terminal_signal: 'files', terminal_close: 'files', terminal_list: 'files',
  job_wait: 'files', job_list: 'files', job_kill: 'files', job_output: 'files', run_code: 'files',
  glob: 'search', grep: 'search', web_search: 'search', web_fetch: 'search',
  skill: 'skills', todo_write: 'planning', create_goal: 'planning', get_goal: 'planning',
  update_goal: 'planning', exit_plan_mode: 'human', ask_user_question: 'human',
  subagent: 'agents', subagent_fork: 'agents', list_agents: 'agents',
  send_message: 'agents', interrupt_agent: 'agents', wait_agent: 'agents', list_subagent_models: 'agents',
  workflow: 'workflow', present: 'artifacts',
}

/**
 * Classify an exact known tool identity without interpreting its arguments.
 * @param name - Recorded tool name.
 * @returns Capability, or the generic tool category.
 */
export function enhancedCapability(name: string): EnhancedCapability {
  return TOOL_CAPABILITIES[name] ?? 'other'
}

/** One selectable evidence card. */
export interface EnhancedItem {
  readonly id: string
  readonly seq: number
  readonly turn: number | null
  readonly group: string
  readonly cell: TrajectoryCellProps
  readonly lane: 'input' | 'model' | 'tool'
  readonly capability?: EnhancedCapability
  readonly label?: string
  readonly childId?: SessionId
  readonly inherited: boolean
  readonly evidence: boolean
}

/** User request or manual compaction interlude, identified by durable sequence. */
export interface EnhancedGroup {
  readonly id: string
  readonly title: string
  readonly kind: 'request' | 'interlude' | 'incomplete' | 'context'
  readonly items: readonly EnhancedItem[]
}

/** Complete loaded presentation, including the existing inspector's input. */
export interface EnhancedModel {
  readonly groups: readonly EnhancedGroup[]
  readonly turns: readonly TrajectoryTurnModel[]
}

function eventData(fact: EnhancedFact): Readonly<Record<string, unknown>> {
  // Mechanism events are merge-extensible and some producers expose only Host
  // declarations. The browser reads a small optional presentation vocabulary.
  return fact.event.data as Readonly<Record<string, unknown>>
}

function stringField(data: Readonly<Record<string, unknown>>, key: string): string | undefined {
  return typeof data[key] === 'string' ? data[key] : undefined
}

function mechanismCapability(type: string): EnhancedCapability {
  if (type.startsWith('tool-workflow/')) return 'workflow'
  if (type === 'subagent/catalog') return 'agents'
  if (type.startsWith('approval/')) return 'human'
  return 'planning'
}

/**
 * Project requests, state evidence, and raw inspector records from loaded history.
 * @param snapshot - Existing trajectory projection, including live records.
 * @param facts - Mechanism events with execution locations.
 * @param hasMore - Whether the request list has an unloaded prefix.
 * @param t - Trajectory translator.
 * @returns Stable request groups and inspection records.
 */
export function deriveEnhancedModel(
  snapshot: TrajectorySnapshot,
  facts: readonly EnhancedFact[],
  hasMore: boolean,
  t: TrajectoryTranslate,
): EnhancedModel {
  const layout = deriveTrajectoryLayout({
    nodes: snapshot.eventNodes, eventLocations: snapshot.eventLocations,
    partial: snapshot.partial, runningCalls: snapshot.runningCalls,
    requests: snapshot.requests, callSchemas: snapshot.callSchemas,
    ...(snapshot.systemPrompts === undefined ? {} : { systemPrompts: snapshot.systemPrompts }),
  }, t)
  const callSeqs = new Map<string, number>()
  let inheritedThrough = -1
  const workflowChildren = new Set<string>()
  const newRequestIds = new Set<string>()
  const newRequestSeqs = new Set<number>()
  let activeTurn: boolean | undefined = hasMore ? undefined : false
  for (const fact of facts) {
    const type: string = fact.event.type
    const data = eventData(fact)
    if (type === 'turn/start') activeTurn = true
    if (type === 'turn/end') activeTurn = false
    if (fact.event.type === 'agent/inbox/spliced') {
      for (const inserted of fact.event.data.inserted) {
        if (activeTurn === false || fact.event.data.target === 'next-turn') newRequestIds.add(inserted.id)
        else newRequestIds.delete(inserted.id)
      }
    }
    if (fact.event.type === 'user/message' && newRequestIds.has(fact.event.data.id)) newRequestSeqs.add(fact.event.seq)
    if (fact.event.type === 'tool/call') {
      const callId = stringField(data, 'callId')
      if (callId !== undefined) callSeqs.set(callId, fact.event.seq)
    }
    if (fact.event.type === 'session/end-seed' && data['inherited'] === true) inheritedThrough = fact.event.seq
    if (type === 'tool-workflow/agent-start') {
      const childId = stringField(data, 'childId')
      if (childId !== undefined) workflowChildren.add(childId)
    }
  }
  const items: EnhancedItem[] = []
  let previousSeq = 0
  for (const turn of layout) {
    for (const group of turn.groups) {
      for (const original of group.cells) {
        const cell = original.kind === 'user' && original.sourceSeq !== undefined && newRequestSeqs.has(original.sourceSeq)
          ? { ...original, opensTurn: true } : original
        const seq = cell.sourceSeq ?? (cell.callId === undefined ? undefined : callSeqs.get(cell.callId)) ?? previousSeq
        previousSeq = seq
        const tool = cell.kind === 'tool' || cell.kind === 'subtool'
        items.push({
          id: trajectoryRecordId(cell), seq, turn: turn.turn, group: group.title, cell,
          lane: tool ? 'tool' : cell.kind === 'message' || cell.kind === 'compacted' ? 'model' : 'input',
          ...(tool ? { capability: enhancedCapability(cell.text) } : {}),
          inherited: seq < inheritedThrough, evidence: false,
        })
      }
    }
  }
  for (const fact of facts) {
    const type: string = fact.event.type
    if (type === 'tool/call' || type === 'session/end-seed' || type === 'turn/start' || type === 'turn/end'
      || type === 'agent/inbox/spliced' || type === 'user/message') continue
    const data = eventData(fact)
    const childId = stringField(data, 'childId')
    if (type === 'subagent/catalog' && childId !== undefined && workflowChildren.has(childId)) continue
    const turn = fact.location.kind === 'step' || fact.location.kind === 'turn' ? fact.location.turn.turn : null
    const group = fact.location.kind === 'step' ? t('group.step', { step: fact.location.step.step }) : t('enhanced.state')
    const label = type.startsWith('approval/') ? t('enhanced.approval')
      : type === 'subagent/catalog' ? t('enhanced.childRegistered')
        : type === 'plan/mode' ? t(data['active'] === true ? 'enhanced.planOn' : 'enhanced.planOff')
          : type === 'todo/write' ? t('enhanced.todo')
            : type === 'goal/change' ? t('enhanced.goal')
              : t('enhanced.workflowEvent')
    const raw = JSON.stringify(fact.event.data, null, 2)
    const preview = [stringField(data, 'phase'), stringField(data, 'label'), stringField(data, 'name'),
      stringField(data, 'operation'), stringField(data, 'outcome'), stringField(data, 'stopReason')]
      .filter(value => value !== undefined).join(' · ')
    items.push({
      id: `fact:${fact.event.seq}`, seq: fact.event.seq, turn, group,
      cell: {
        index: 0, recordId: `fact:${fact.event.seq}`, sourceSeq: fact.event.seq,
        kind: 'context', text: type, previewMarkdown: preview || raw,
        inputDetail: raw, messageSource: { type }, timeSeconds: 0, startedAt: fact.event.time,
      },
      lane: 'tool', capability: mechanismCapability(type), label,
      ...(childId === undefined || fact.event.seq < inheritedThrough ? {} : { childId: childId as SessionId }),
      inherited: fact.event.seq < inheritedThrough, evidence: true,
    })
  }
  items.sort((a, b) => a.seq - b.seq || a.cell.index - b.cell.index)
  const numbered = items.map((item, index) => ({ ...item, cell: { ...item.cell, index: index + 1 } }))
  const starts = numbered.filter(item => item.cell.kind === 'user' && item.cell.opensTurn === true)
  const groups: { id: string; title: string; kind: EnhancedGroup['kind']; items: EnhancedItem[] }[] = []
  const first = starts[0]
  let current = {
    id: 'context', title: t(hasMore ? 'enhanced.incomplete' : 'enhanced.sessionContext'),
    kind: (hasMore ? 'incomplete' : 'context') as EnhancedGroup['kind'], items: [] as EnhancedItem[],
  }
  if (!hasMore && first !== undefined) {
    current = { id: first.id, title: first.cell.previewMarkdown || first.cell.text || t('enhanced.request'), kind: 'request', items: [] }
  }
  groups.push(current)
  const manual = new Set(snapshot.requests.filter(request => request.purpose === 'compaction' && request.turn === null).map(request => request.startSeq))
  const checkpoints = new Set(snapshot.requests.filter(request => request.purpose === 'compaction' && request.turn === null)
    .map(request => request.purpose === 'compaction' ? request.replacementSeq : undefined))
  let interlude: typeof current | undefined
  for (const item of numbered) {
    if (interlude !== undefined && item.cell.kind !== 'compacted' && !checkpoints.has(item.seq)) interlude = undefined
    if (item.cell.kind === 'user' && item.cell.opensTurn === true) {
      interlude = undefined
      if (current.id !== item.id) {
        current = { id: item.id, title: item.cell.previewMarkdown || item.cell.text || t('enhanced.request'), kind: 'request', items: [] }
        groups.push(current)
      }
    }
    if (item.cell.kind === 'compacted' && manual.has(item.seq)) {
      interlude = { id: item.id, title: t('enhanced.manualCompaction'), kind: 'interlude', items: [] }
      groups.push(interlude)
    }
    ;(interlude ?? current).items.push(item)
  }
  // Inspector groups retain the original step label so request metadata remains addressable.
  const turns: TrajectoryTurnModel[] = numbered.map(item => ({ turn: item.turn, groups: [{ title: item.group, cells: [item.cell] }] }))
  return { groups: groups.filter(group => group.items.length > 0), turns }
}
