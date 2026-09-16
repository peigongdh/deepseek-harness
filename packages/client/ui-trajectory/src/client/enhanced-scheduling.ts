/** Local scheduling summaries and chronological receipts over loaded evidence. */
import type { EnhancedGroup, EnhancedItem } from './enhanced-model.ts'
import type { TrajectoryTranslate } from './locales.ts'

/** A Workflow member or a delegated child observed by the parent Session. */
export interface SchedulingMember {
  readonly id: string
  readonly label: string
  readonly phase: string | undefined
  readonly start: EnhancedItem | undefined
  readonly end: EnhancedItem | undefined
  readonly child: EnhancedItem | undefined
  readonly records: readonly EnhancedItem[]
  readonly notices: readonly EnhancedItem[]
}

/** A retrospective summary anchored at its earliest loaded scheduling record. */
export interface SchedulingBlock {
  readonly id: string
  readonly kind: 'workflow' | 'agents'
  readonly title: string
  readonly anchor: EnhancedItem
  readonly end: EnhancedItem | undefined
  readonly members: readonly SchedulingMember[]
  readonly records: readonly EnhancedItem[]
}

/** A parent-observed message or control at its original chronological position. */
export interface SchedulingReceipt {
  readonly item: EnhancedItem
  readonly title: string
  readonly block: SchedulingBlock | undefined
}

/** Raw records remain addressable even when their default presentation is aggregated. */
export interface SchedulingProjection {
  readonly blocks: ReadonlyMap<string, SchedulingBlock>
  readonly owners: ReadonlyMap<string, SchedulingBlock>
  readonly receipts: ReadonlyMap<string, SchedulingReceipt>
}

type Member = { -readonly [Key in keyof SchedulingMember]: Key extends 'records' | 'notices' ? EnhancedItem[] : SchedulingMember[Key] }
type Block = { -readonly [Key in keyof SchedulingBlock]: Key extends 'records' ? EnhancedItem[] : Key extends 'members' ? Member[] : SchedulingBlock[Key] }

function isDelegation(item: EnhancedItem): boolean {
  return item.cell.callId !== undefined && (item.cell.text === 'subagent' || item.cell.text === 'subagent_fork')
}

/**
 * Aggregate explicit run/member and child references; leave asynchronous arrivals in place.
 * @param groups - All loaded request groups in one Session.
 * @param t - Trajectory translator.
 * @returns Summary anchors, raw-record ownership, and arrival/control receipts.
 */
export function deriveScheduling(groups: readonly EnhancedGroup[], t: TrajectoryTranslate): SchedulingProjection {
  const items = groups.flatMap(group => group.items).sort((a, b) => a.seq - b.seq)
  const requests = new Map(groups.flatMap(group => group.items.map(item => [item.id, group.id] as const)))
  const blocks = new Map<string, Block>()
  const owners = new Map<string, Block>()
  const receipts = new Map<string, SchedulingReceipt>()
  const members = new Map<string, Member>()
  const children = new Map<string, { block: Block; member: Member }>()
  const childKey = (item: EnhancedItem, id: string) => `${item.inherited}:${id}`
  const own = (block: Block, item: EnhancedItem) => { block.records.push(item); owners.set(item.id, block) }
  const create = (id: string, kind: Block['kind'], title: string, anchor: EnhancedItem): Block => {
    const block: Block = { id, kind, title, anchor, end: undefined, members: [], records: [] }
    blocks.set(id, block)
    return block
  }
  const member = (block: Block, item: EnhancedItem, start: boolean): Member => {
    const result: Member = { id: item.id, label: item.mechanism?.participant ?? t('schedule.unnamedMember'),
      phase: item.mechanism?.phase, start: start ? item : undefined, end: start ? undefined : item,
      child: item.childId === undefined ? undefined : item, records: [item], notices: [] }
    block.members.push(result)
    members.set(item.id, result)
    return result
  }

  for (const item of items) {
    const node = item.mechanism
    if (node?.kind === 'workflow') {
      const id = `${item.inherited}:${node.flowId}`
      const block = blocks.get(id) ?? create(id, 'workflow', node.heading, item)
      own(block, item)
      if (item.cell.text === 'tool-workflow/agent-start') {
        const row = member(block, item, true)
        if (item.childId !== undefined) children.set(childKey(item, item.childId), { block, member: row })
      } else if (item.cell.text === 'tool-workflow/agent-end') {
        const origin = node.links[0]
        const row = origin === undefined ? undefined : members.get(origin.id)
        if (row === undefined) member(block, item, false)
        else { row.end = item; row.records.push(item) }
      } else if (item.cell.text === 'tool-workflow/run-end') {
        block.end = item
        if (item.turn !== block.anchor.turn || item.group !== block.anchor.group
          || requests.get(item.id) !== requests.get(block.anchor.id)) {
          receipts.set(item.id, { item, title: `${block.title} · ${t('mechanism.workflowEnd')}`, block })
        }
      }
    } else if (node?.kind === 'agents' && isDelegation(item)) {
      // A model step identifies a dispatch batch, not proof of concurrent child execution.
      const id = `${item.inherited}:dispatch:${requests.get(item.id)}:${item.turn}:${item.group}`
      const block = blocks.get(id) ?? create(id, 'agents', t('schedule.delegationBatch'), item)
      own(block, item)
      const row = member(block, item, true)
      if (node.agentId !== undefined) children.set(childKey(item, node.agentId), { block, member: row })
    } else if (node?.kind === 'agents' && item.cell.text === 'subagent/catalog' && node.agentId !== undefined) {
      const key = childKey(item, node.agentId)
      const prior = children.get(key)
      const block = prior?.block ?? create(`child:${key}`, 'agents', t('schedule.delegationBatch'), item)
      own(block, item)
      const row = prior?.member ?? member(block, item, true)
      if (prior !== undefined) row.records.push(item)
      row.child = item.childId === undefined ? undefined : item
      row.label = node.participant ?? row.label
      children.set(key, { block, member: row })
    } else if (node?.kind === 'agents' && node.agentId !== undefined) {
      const target = children.get(childKey(item, node.agentId))
      const title = `${target?.member.label ?? t('schedule.unnamedMember')} · ${node.title}`
      receipts.set(item.id, { item, title, block: target?.block })
      if (target !== undefined) {
        own(target.block, item)
        target.member.records.push(item)
        if (node.receiptKind === 'settled') {
          target.member.notices.push(item)
          // Parent notices have delivery times, not child execution end times.
          if (target.block.kind === 'agents') target.member.end = item
        }
      }
    }
  }
  return { blocks: new Map([...blocks.values()].map(block => [block.anchor.id, block])), owners, receipts }
}

/**
 * Describe only overlap established by complete Workflow member event pairs.
 * @param members - Members being compared.
 * @returns Observed overlap, complete non-overlap, or insufficient evidence.
 */
export function schedulingOverlap(members: readonly SchedulingMember[]): 'overlap' | 'sequential' | 'unknown' {
  const complete = members.filter((member): member is SchedulingMember & { start: EnhancedItem; end: EnhancedItem } =>
    member.start !== undefined && member.end !== undefined && member.start.seq < member.end.seq)
    .sort((a, b) => a.start.seq - b.start.seq)
  let end = -1
  for (const member of complete) {
    if (member.start.seq < end) return 'overlap'
    end = Math.max(end, member.end.seq)
  }
  return complete.length === members.length && complete.length > 1 ? 'sequential' : 'unknown'
}
