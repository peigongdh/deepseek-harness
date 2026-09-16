/** Recorded mechanism identities and relationships for the enhanced timeline. */
import type { EnhancedFact } from './enhanced-facts.ts'
import type { EnhancedItem } from './enhanced-model.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Mechanisms use their own column labels within the shared three-column area. */
export type MechanismKind = 'agents' | 'workflow' | 'goal' | 'plan' | 'todo'

/** A relationship to loaded evidence, not an inferred dependency between adjacent events. */
export interface MechanismLink {
  readonly id: string
  readonly seq: number
  readonly label: string
}

/** One chronological mechanism node; raw inspection remains owned by its original record. */
export interface MechanismNode {
  readonly kind: MechanismKind
  readonly flowId: string
  readonly heading: string
  readonly stage: 0 | 1 | 2
  readonly title: string
  readonly summary?: string | undefined
  readonly links: readonly MechanismLink[]
  readonly missingOrigin?: boolean
  readonly wide?: boolean
  readonly participant?: string | undefined
  readonly phase?: string | undefined
  readonly outcome?: string | undefined
  readonly agentId?: SessionId | undefined
  readonly executionMode?: 'background' | 'foreground' | undefined
  readonly fork?: boolean
  readonly receiptKind?: 'message' | 'settled'
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>> : {}
}
function string(value: unknown): string | undefined { return typeof value === 'string' ? value : undefined }
function args(item: EnhancedItem): Readonly<Record<string, unknown>> {
  let value: unknown
  try { value = JSON.parse(item.cell.inputDetail ?? '{}') }
  catch { return {} } // Model tool arguments can be incomplete while streaming.
  return object(value)
}
function link(item: EnhancedItem | undefined, label: string): MechanismLink[] {
  return item === undefined ? [] : [{ id: item.id, seq: item.seq, label }]
}

/**
 * Correlate loaded evidence by recorded child, run/member, and goal/revision identities.
 * @param items - Chronologically ordered raw records.
 * @param facts - Durable mechanism payloads.
 * @param t - Trajectory translator.
 * @returns Node presentation keyed by raw record identity.
 */
export function deriveMechanisms(
  items: readonly EnhancedItem[], facts: readonly EnhancedFact[], t: TrajectoryTranslate,
): ReadonlyMap<string, MechanismNode> {
  const payloads = new Map(facts.map(fact => [fact.event.seq, fact.event]))
  const nodes = new Map<string, MechanismNode>()
  const runs = new Map<string, { name: string; start?: EnhancedItem; members: Map<number, EnhancedItem>; ends: EnhancedItem[] }>()
  const children = new Map<string, EnhancedItem>()
  const dispatches = new Map<string, EnhancedItem>()
  const dispatchedIds = new Map<string, string>()
  const goals = new Map<string, EnhancedItem>()
  const revisions = new Map<string, EnhancedItem>()
  let plan: EnhancedItem | undefined
  let todo: { item: EnhancedItem; summary: string } | undefined
  let wasInherited = items[0]?.inherited
  // A continuable delegation's renderer records the child id in this exact result.
  for (const item of items) {
    if (item.cell.text !== 'subagent' && item.cell.text !== 'subagent_fork') continue
    const child = /^started subagent (\S+)$/.exec(item.cell.outputDetail?.trim() ?? '')?.[1]
    if (child !== undefined && !item.cell.isError) { dispatches.set(child, item); dispatchedIds.set(item.id, child) }
  }
  for (const item of items) {
    if (wasInherited && !item.inherited) {
      runs.clear(); children.clear(); goals.clear(); revisions.clear(); plan = undefined; todo = undefined
    }
    wasInherited = item.inherited
    const event = item.evidence ? payloads.get(item.seq) : undefined
    const type: string | undefined = event?.type
    const data = object(event?.data)
    const source = object(item.cell.messageSource)
    let node: MechanismNode | undefined
    if (type?.startsWith('tool-workflow/')) {
      const runId = string(data['runId'])
      if (runId !== undefined) {
        const member = typeof data['seq'] === 'number' ? data['seq'] : undefined
        if (type === 'tool-workflow/run-start') {
          runs.set(runId, { name: string(data['name']) ?? runId, start: item, members: new Map(), ends: [] })
        }
        if (!runs.has(runId)) runs.set(runId, { name: runId, members: new Map(), ends: [] })
        const run = runs.get(runId)
        const origin = type === 'tool-workflow/agent-end' && member !== undefined ? run?.members.get(member) : run?.start
        const stage = type === 'tool-workflow/run-start' ? 0 : type === 'tool-workflow/agent-start' ? 1 : 2
        const summary = [type === 'tool-workflow/agent-end' ? nodes.get(origin?.id ?? '')?.summary : undefined,
          string(data['phase']), string(data['label']), string(data['outcome']), string(data['stopReason'])].filter(Boolean).join(' · ')
        node = {
          kind: 'workflow', flowId: `workflow:${runId}`, heading: run?.name ?? runId, stage,
          title: t(type === 'tool-workflow/run-start' ? 'mechanism.workflowStart'
            : type === 'tool-workflow/agent-start' ? 'mechanism.memberStart'
              : type === 'tool-workflow/agent-end' ? 'mechanism.memberEnd' : 'mechanism.workflowEnd'),
          summary,
          participant: string(data['label']), phase: string(data['phase']),
          outcome: string(data['outcome'] ?? data['stopReason']),
          links: stage === 0 ? [] : type === 'tool-workflow/run-end' && run !== undefined && run.ends.length > 0
            ? run.ends.flatMap(end => link(end, t('mechanism.memberResult')))
            : link(origin, t(type === 'tool-workflow/agent-end' ? 'mechanism.memberOrigin' : 'mechanism.sameRun')),
          missingOrigin: stage !== 0 && origin === undefined,
        }
        if (type === 'tool-workflow/agent-start' && member !== undefined) {
          run?.members.set(member, item)
          const childId = string(data['childId'])
          if (childId !== undefined) children.set(childId, item)
        }
        if (type === 'tool-workflow/agent-end') run?.ends.push(item)
      }
    } else if (type === 'subagent/catalog') {
      const childId = string(data['childId'])
      if (childId !== undefined) {
        const dispatch = dispatches.get(childId)
        node = {
          kind: 'agents', flowId: `agent:${childId}`, heading: string(data['label']) ?? childId, stage: 1,
          title: t('enhanced.childRegistered'), summary: string(data['mode']),
          participant: string(data['label']), agentId: childId as SessionId,
          links: link(dispatch?.inherited === item.inherited ? dispatch : undefined, t('mechanism.delegation')),
        }
        children.set(childId, item)
      }
    } else if (source['kind'] === 'agent-message' || source['kind'] === 'subagent-settled') {
      const childId = string(source['senderSessionId'])
      if (childId !== undefined) {
        const origin = children.get(childId)
        node = {
          kind: 'agents', flowId: `agent:${childId}`, heading: nodes.get(origin?.id ?? '')?.heading ?? childId, stage: 2,
          title: t(source['kind'] === 'agent-message' ? 'mechanism.agentMessage' : 'mechanism.agentSettled'),
          agentId: childId as SessionId,
          receiptKind: source['kind'] === 'subagent-settled' ? 'settled' : 'message',
          summary: string(source['summary']) ?? item.cell.previewMarkdown,
          links: link(origin, t('mechanism.sameAgent')), missingOrigin: origin === undefined,
        }
      }
    } else if (type === 'goal/change') {
      const goal = object(data['goal'] ?? data['cleared'])
      const id = string(goal['id'])
      if (id !== undefined) {
        const operation = string(data['operation']) ?? ''
        const previous = goals.get(id)
        const goalTitles: Readonly<Record<string, TrajectoryKey>> = { create: 'mechanism.goalCreate', edit: 'mechanism.goalEdit', resume: 'mechanism.goalResume',
          pause: 'mechanism.goalPause', block: 'mechanism.goalBlock', complete: 'mechanism.goalComplete', clear: 'mechanism.goalClear' }
        const titleKey = goalTitles[operation]
        node = {
          kind: 'goal', flowId: `goal:${id}`, heading: string(goal['objective']) ?? nodes.get(previous?.id ?? '')?.heading ?? id,
          stage: operation === 'create' ? 0 : operation === 'edit' || operation === 'resume' ? 1 : 2,
          title: titleKey === undefined ? t('enhanced.goal') : t(titleKey),
          summary: [string(goal['phase']), string(object(goal['blockedReason'])['message'])].filter(Boolean).join(' · '),
          links: link(previous, t('mechanism.previousState')), missingOrigin: operation !== 'create' && previous === undefined,
        }
        goals.set(id, item)
        if (typeof goal['revision'] === 'number') revisions.set(`${id}:${goal['revision']}`, item)
      }
    } else if (source['kind'] === 'goal') {
      const id = string(source['goalId'])
      if (id !== undefined) {
        const origin = revisions.get(`${id}:${String(source['revision'])}`)
        node = {
          kind: 'goal', flowId: `goal:${id}`, heading: nodes.get(origin?.id ?? '')?.heading ?? id, stage: 1,
          title: t('enhanced.goalContinuation'), summary: typeof source['round'] === 'number' ? t('mechanism.goalRound', { round: source['round'] }) : undefined,
          links: link(origin, t('mechanism.goalRevision')), missingOrigin: origin === undefined,
        }
      }
    } else if (type === 'plan/mode') {
      const active = data['active'] === true
      node = {
        kind: 'plan', flowId: active ? `plan:${item.id}` : `plan:${plan?.id ?? item.id}`,
        heading: t('mechanism.plan'), stage: active ? 0 : 2,
        title: t(active ? 'enhanced.planOn' : 'enhanced.planOff'),
        links: active ? [] : link(plan, t('mechanism.previousState')), missingOrigin: !active && plan === undefined,
      }
      plan = active ? item : undefined
    } else if (type === 'todo/write' && Array.isArray(data['todos'])) {
      const entries = data['todos'].map(object)
      const summary = t('mechanism.todoCounts', {
        pending: entries.filter(entry => entry['status'] === 'pending').length,
        active: entries.filter(entry => entry['status'] === 'in_progress').length,
        complete: entries.filter(entry => entry['status'] === 'completed').length,
      })
      node = { kind: 'todo', flowId: 'todo', heading: t('enhanced.todo'), stage: 1, wide: true,
        title: t('mechanism.todoSnapshot'), summary: todo === undefined ? summary : `${todo.summary} → ${summary}`,
        links: link(todo?.item, t('mechanism.previousState')) }
      todo = { item, summary }
    } else if (item.cell.callId !== undefined) {
      const values = args(item)
      const target = string(values['agent_id'])
      const child = dispatchedIds.get(item.id)
      if (item.capability === 'agents') {
        node = { kind: 'agents', flowId: `agent:${target ?? child ?? item.id}`, heading: string(values['description']) ?? target ?? child ?? t('enhanced.category.agents'),
          participant: string(values['description']), agentId: (target ?? child) as SessionId | undefined,
          executionMode: child !== undefined || values['run_in_background'] === true ? 'background'
            : values['run_in_background'] === false ? 'foreground' : undefined,
          fork: item.cell.text === 'subagent_fork',
          stage: 0, title: item.cell.text, links: link(target === undefined ? undefined : children.get(target), t('mechanism.sameAgent')) }
      } else if (item.cell.text === 'exit_plan_mode' && plan !== undefined) {
        node = { kind: 'plan', flowId: `plan:${plan.id}`, heading: t('mechanism.plan'), stage: 1,
          title: t('mechanism.planReview'), links: link(plan, t('mechanism.planContext')) }
      }
    }
    if (node !== undefined) nodes.set(item.id, node)
  }
  return nodes
}
