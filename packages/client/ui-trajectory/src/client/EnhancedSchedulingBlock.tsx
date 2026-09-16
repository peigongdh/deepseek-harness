/** Bounded member rows with local lifecycle marks and folded raw evidence. */
import type { ReactNode } from 'react'
import { IconAgentPresetOutline16, IconBranchOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnhancedItem } from './enhanced-model.ts'
import { schedulingOverlap, type SchedulingBlock, type SchedulingMember } from './enhanced-scheduling.ts'
import type { TrajectoryKey, TrajectoryTranslate } from './locales.ts'
import css from './EnhancedTrajectoryView.module.css'

const OUTCOMES: Readonly<Record<string, TrajectoryKey>> = {
  completed: 'schedule.completed', failed: 'schedule.failed', error: 'schedule.failed', cancelled: 'schedule.cancelled',
}

/**
 * Summarize loaded scheduling evidence without drawing edges across the parent canvas.
 * @param props - Summary, raw inspector selection, and local disclosure renderers.
 * @returns Member lifecycles and raw evidence inside one scheduling block.
 */
export function EnhancedSchedulingBlock({ block, selectedId, select, renderRaw, renderChildControl, t }: {
  block: SchedulingBlock
  selectedId: string | undefined
  select: (item: EnhancedItem) => void
  renderRaw: (item: EnhancedItem) => ReactNode
  renderChildControl: (item: EnhancedItem) => ReactNode
  t: TrajectoryTranslate
}) {
  const workflow = block.kind === 'workflow'
  const Icon = workflow ? IconBranchOutline16 : IconAgentPresetOutline16
  const phases: { name: string; rows: SchedulingMember[] }[] = []
  for (const row of block.members) {
    const name = row.phase ?? t('schedule.members')
    const last = phases.at(-1)
    if (last?.name === name) last.rows.push(row)
    else phases.push({ name, rows: [row] })
  }
  const points = [...new Set(block.members.flatMap(row => [row.start?.seq, row.end?.seq])
    .filter((seq): seq is number => seq !== undefined))].sort((a, b) => a - b)
  const positions = new Map(points.map((seq, index) => [seq, 100 * index / Math.max(1, points.length - 1)]))
  const outcome = (item: EnhancedItem | undefined) => {
    const key = OUTCOMES[item?.mechanism?.outcome ?? '']
    return key === undefined ? t('schedule.endUnknown') : t(key)
  }
  const endpoint = (item: EnhancedItem | undefined, label: string) => item === undefined
    ? <span>{label}</span>
    : <button type="button" data-enhanced-record={item.id} aria-pressed={selectedId === item.id}
      onClick={() => { select(item) }}>{label} · #{item.seq}</button>
  return <section className={css.scheduleBlock} data-scheduling-block={block.kind}>
    <header className={css.scheduleHeader}>
      <strong><Icon aria-hidden="true" />{block.title}</strong>
      <span>{workflow ? outcome(block.end) : t('schedule.memberCount', { count: block.members.length })}</span>
    </header>
    <p className={css.scheduleCaption}>{t('schedule.retrospective')}</p>
    {workflow ? <div className={css.scheduleEndpoints}>
      {endpoint(block.anchor.cell.text === 'tool-workflow/run-start' ? block.anchor : undefined, t('schedule.runStart'))}
      {endpoint(block.end, t(block.end === undefined ? 'schedule.endUnknown' : 'schedule.runEnd'))}
    </div> : <p className={css.scheduleCaption}>{t('schedule.parentObservation')}</p>}
    {workflow && <p className={css.scheduleCaption}>{t('schedule.ordinalAxis')}</p>}
    {phases.map((phase, index) => {
      const overlap = workflow ? schedulingOverlap(phase.rows) : 'unknown'
      const prior = phases.slice(0, index).flatMap(value => value.rows)
      const earliest = Math.min(...phase.rows.map(row => row.start?.seq ?? -1))
      const later = earliest >= 0 && prior.length > 0 && prior.every(row => row.end !== undefined && row.end.seq < earliest)
      return <section key={`${index}:${phase.name}`} className={css.schedulePhase}>
        <header><strong>{phase.name}</strong><span data-scheduling-observation={overlap}>
          {workflow && overlap !== 'unknown' ? t(`schedule.${overlap}`)
            : later && workflow ? t('schedule.later') : t(workflow ? 'schedule.dependencyUnknown' : 'schedule.concurrencyUnknown')}
        </span></header>
        {phase.rows.map((row) => {
          const start = row.start
          const end = row.end
          const left = positions.get(start?.seq ?? -1) ?? 0
          const right = positions.get(end?.seq ?? -1) ?? 100
          const complete = start !== undefined && end !== undefined && start.seq < end.seq
          const dispatch = start?.cell.callId !== undefined
          const foregroundReturned = start?.mechanism?.executionMode === 'foreground' && start.cell.timeSeconds !== null
          return <div key={row.id} className={css.scheduleMember} data-scheduling-member={row.id}
            data-outcome={end?.mechanism?.outcome}>
            <div className={css.memberHeading}><strong>{row.label}</strong>
              <span>{workflow ? outcome(end) : row.notices.length > 0
                ? t('schedule.noticeCount', { count: row.notices.length })
                : foregroundReturned ? t(start.cell.isError ? 'status.failed' : 'schedule.callReturned') : t('schedule.noNotice')}</span>
            </div>
            {!workflow && dispatch && <div className={css.memberTags}>
              <span>{t(start.mechanism?.fork ? 'schedule.fork' : 'schedule.fresh')}</span>
              {start.mechanism?.executionMode !== undefined && <span>{t(`schedule.${start.mechanism.executionMode}`)}</span>}
            </div>}
            <div className={css.scheduleEndpoints}>
              {endpoint(start, t(start === undefined ? 'schedule.startUnknown' : workflow ? 'schedule.started'
                : dispatch ? 'schedule.dispatched' : 'enhanced.childRegistered'))}
              {endpoint(end ?? (foregroundReturned ? start : undefined), t(end === undefined
                ? foregroundReturned ? 'schedule.callReturned' : 'schedule.endUnknown'
                : workflow ? 'schedule.ended' : 'schedule.noticeReceived'))}
            </div>
            {workflow && <div className={css.memberTrack} aria-hidden="true" data-complete={complete}>
              <span style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }} />
            </div>}
            {!workflow && <p className={css.scheduleCaption}>{t('schedule.interactions', { count: row.records.filter(item => item.mechanism?.stage === 2 || item.cell.text === 'send_message' || item.cell.text === 'interrupt_agent').length })}</p>}
            {row.child !== undefined && renderChildControl(row.child)}
          </div>
        })}
      </section>
    })}
    <details className={css.scheduleRaw} data-scheduling-raw="">
      <summary>{t('schedule.rawRecords', { count: block.records.length })}</summary>
      {block.records.map(renderRaw)}
    </details>
  </section>
}
