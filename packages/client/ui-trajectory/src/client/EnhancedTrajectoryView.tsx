/** Request-oriented trajectory cards with a shared raw record inspector. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConvViewProps, MessageImageLoader, RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { EnhancedChildren } from './enhanced-children.ts'
import type { EnhancedFact } from './enhanced-facts.ts'
import { deriveEnhancedModel, type EnhancedGroup, type EnhancedItem, type EnhancedModel } from './enhanced-model.ts'
import type { TrajectorySnapshot } from './trajectory-contract.ts'
import type { TrajectoryTranslate } from './locales.ts'
import { TrajectoryTable } from './TrajectoryTable.tsx'
import { trajectoryRequestNumbers } from './request-numbers.ts'
import { formatElapsedSeconds } from './trajectory-record.ts'
import css from './EnhancedTrajectoryView.module.css'

/** Session-bound facts and read-only child controls supplied by the plugin. */
export interface EnhancedTrajectoryInjected {
  hooks: {
    enhancedFacts: ObservableSnapshot<readonly EnhancedFact[]>
    enhancedChildren: ObservableSnapshot<EnhancedChildren>
  }
  loadOlder: () => Promise<void>
  expandChild: (parentId: SessionId, childId: SessionId) => Promise<void>
  collapseChild: (childId: SessionId) => void
  loadOlderChild: (childId: SessionId) => Promise<void>
  loadImage: (sessionId: SessionId, attachment: ImageAttachmentRef) => ReturnType<MessageImageLoader>
  peekImage: (sessionId: SessionId, attachment: ImageAttachmentRef) => string | undefined
}

interface Selection { readonly sessionId: SessionId; readonly id: string }
interface ChildModel { readonly snapshot: TrajectorySnapshot; readonly model: EnhancedModel }
const EMPTY_TURNS: ReadonlySet<number> = new Set()
const EMPTY_RECORDS: ReadonlySet<string> = new Set()
const noop = () => {}
const VISIBLE_STEPS = 30

function itemTitle(item: EnhancedItem, t: TrajectoryTranslate): string {
  if (item.label !== undefined) return item.label
  if (item.lane === 'tool') return item.cell.text
  return t(`kind.${item.cell.kind}`)
}

function itemTag(item: EnhancedItem, t: TrajectoryTranslate): string {
  if (item.capability !== undefined) return t(`enhanced.category.${item.capability}`)
  const source = item.cell.messageSource as { kind?: string; plugin?: string } | undefined
  if (source?.kind === 'session-reference') return t('enhanced.reference')
  if (source?.kind === 'skill-invocation' || source?.kind === 'skill-catalog') return t('enhanced.category.skills')
  if (source?.kind === 'goal') return t('enhanced.goalContinuation')
  if (source?.kind === 'agent-message' || source?.kind === 'subagent-settled') return t('enhanced.category.agents')
  return itemTitle(item, t)
}

function itemPreview(item: EnhancedItem, t: TrajectoryTranslate): string {
  if (item.cell.kind === 'context' && !item.evidence) {
    const source = item.cell.messageSource as { kind?: string; plugin?: string } | undefined
    return source?.plugin ?? source?.kind ?? t('kind.context')
  }
  return (item.cell.previewMarkdown || item.cell.text || item.cell.thinkingDetail || t('enhanced.noPreview')).slice(0, 280)
}

interface CardsProps {
  readonly sessionId: SessionId
  readonly groups: readonly EnhancedGroup[]
  readonly children: EnhancedChildren
  readonly childModels: ReadonlyMap<SessionId, ChildModel>
  readonly ancestors: readonly SessionId[]
  readonly select: (selection: Selection) => void
  readonly selected: Selection | undefined
  readonly anchor: Selection | undefined
  readonly expand: EnhancedTrajectoryInjected['expandChild']
  readonly collapse: EnhancedTrajectoryInjected['collapseChild']
  readonly loadOlderChild: EnhancedTrajectoryInjected['loadOlderChild']
  readonly t: TrajectoryTranslate
}

function Cards(props: CardsProps) {
  const { groups, sessionId, children, childModels, ancestors, select, selected, expand, collapse, loadOlderChild, t } = props
  const [limit, setLimit] = useState(VISIBLE_STEPS)
  const blocks = useMemo(() => {
    const result: { id: string; turn: number | null; title: string; items: EnhancedItem[] }[] = []
    for (const group of groups) {
      for (const item of group.items) {
        const id = `${group.id}:${item.turn}:${item.group}`
        const last = result.at(-1)
        if (last?.id === id) last.items.push(item)
        else result.push({ id, turn: item.turn, title: item.group, items: [item] })
      }
    }
    return result
  }, [groups])
  const anchor = props.anchor?.sessionId === sessionId ? props.anchor : selected?.sessionId === sessionId ? selected : undefined
  const pinned = anchor === undefined ? -1 : blocks.findIndex(block => block.items.some(item => item.id === anchor.id))
  const visibleLimit = Math.max(limit, pinned + 1)
  useEffect(() => { if (pinned >= limit) setLimit(pinned + 1) }, [pinned, limit])
  const card = (item: EnhancedItem) => {
    const childId = item.childId
    const cell = item.cell
    const child = childId === undefined ? undefined : children.get(childId)
    const cycle = childId !== undefined && ancestors.includes(childId)
    return <div key={item.id} className={css.cardWrap}>
      <button type="button" className={css.card}
        data-enhanced-record={item.id}
        data-kind={cell.kind} data-category={item.capability}
        data-error={cell.isError || undefined}
        aria-pressed={selected?.sessionId === sessionId && selected.id === item.id}
        onClick={() => { select({ sessionId, id: item.id }) }}>
        <span className={css.cardMeta}><span>{itemTag(item, t)}</span><span>#{item.seq}</span></span>
        <strong>{itemTitle(item, t)}</strong>
        <span className={css.preview}>{itemPreview(item, t)}</span>
        {(cell.resultPreviewMarkdown || cell.result) && <span className={css.result}>{t('enhanced.result')} · {(cell.resultPreviewMarkdown || cell.result)?.slice(0, 160)}</span>}
        <span className={css.cardMeta}>
          <span>{item.evidence ? t('enhanced.state') : cell.isError ? t('status.failed')
            : cell.timeSeconds === null ? t('timing.notAvailable') : formatElapsedSeconds(cell.timeSeconds, t)}</span>
          {item.inherited && <span>{t('enhanced.inherited')}</span>}
        </span>
      </button>
      {childId !== undefined && <div className={css.childControl}>
        {cycle ? <span>{t('enhanced.childCycle')}</span> : <Button size="sm" variant="outline"
          aria-expanded={child !== undefined}
          onClick={() => { if (child === undefined) void expand(sessionId, childId); else collapse(childId) }}>
          {t(child === undefined ? 'enhanced.expandChild' : 'enhanced.collapseChild')}
        </Button>}
      </div>}
      {child !== undefined && <div className={css.childStatus}>
        {child.status === 'loading' && <span role="status">{t('enhanced.loadingChild')}</span>}
        {child.status === 'error' && <div role="alert"><p>{t('enhanced.childError')}</p><pre>{child.error}</pre>
          <Button size="sm" onClick={() => { collapse(child.childId); void expand(sessionId, child.childId) }}>{t('enhanced.retry')}</Button>
        </div>}
      </div>}

    </div>
  }
  const childHistory = (item: EnhancedItem) => {
    if (item.childId !== undefined && ancestors.includes(item.childId)) return null
    const child = item.childId === undefined ? undefined : children.get(item.childId)
    const nested = item.childId === undefined ? undefined : childModels.get(item.childId)
    return <div key={item.id}>
      {nested !== undefined && child?.status === 'ready' && <div className={css.childHistory}>
        <p className={css.childHeading}>{t('enhanced.childHistory')} · {child.childId}</p>
        {child.session?.hasMore && <Button size="sm" disabled={child.session.loadingOlder}
          onClick={() => { void loadOlderChild(child.childId) }}>{t('history.loadEarlier')}</Button>}
        <Cards {...props} sessionId={child.childId} groups={nested.model.groups} ancestors={[...ancestors, child.childId]} />
      </div>}
    </div>
  }
  const renderBlock = (block: (typeof blocks)[number], position: number) => <section key={`${block.id}:${block.items[0]?.id}`} className={css.step}>
    <header className={css.stepHeading}><span>{block.turn === null ? t('section.betweenTurns') : t('turn.label', { turn: block.turn })}</span><span>{block.title}</span></header>
    <div className={css.lanes}>
      {(['input', 'model', 'tool'] as const).map((lane) => {
        const items = block.items.filter(item => item.lane === lane)
        const ordinary = lane === 'tool' && items.length > 3 && items.every(item =>
          !item.evidence && item.childId === undefined && !item.cell.isError
            && (item.capability === 'files' || item.capability === 'search') && item.cell.timeSeconds !== null)
        return <div key={lane} className={css.lane} data-lane={lane}>
          {items.length > 0 && <span className={css.laneLabel}>{t(`enhanced.lane.${lane}`)}</span>}
          {lane === 'tool' && block.items.some(item => item.lane === 'model') && items.some(item => item.cell.callId !== undefined)
              && <span className={css.callArrow} aria-label={t('enhanced.calls')}>→</span>}
          {ordinary ? <details className={css.fold}><summary>{t('enhanced.operations', { count: items.length })}</summary>{items.map(card)}</details> : items.map(card)}
        </div>
      })}
    </div>
    {block.items.filter(item => item.childId !== undefined && children.has(item.childId)).map(childHistory)}
    {position < blocks.length - 1 && <span className={css.orderArrow} aria-hidden="true">↓</span>}
  </section>
  const segments: { blocks: typeof blocks; ordinary: boolean }[] = []
  for (const block of blocks.slice(0, visibleLimit)) {
    const calls = block.items.filter(item => item.cell.callId !== undefined)
    const ordinary = calls.length > 0 && block.items.every(item =>
      !item.evidence && !item.cell.isError && item.childId === undefined
      && item.cell.timeSeconds !== null && item.lane !== 'input'
      && (item.lane === 'model' || item.capability === 'files' || item.capability === 'search'))
    const last = segments.at(-1)
    if (ordinary && last?.ordinary && last.blocks.at(-1)?.turn === block.turn) last.blocks.push(block)
    else segments.push({ blocks: [block], ordinary })
  }
  return <div className={css.blocks}>
    {segments.map(segment => segment.ordinary && segment.blocks.length > 2
      ? <details key={segment.blocks[0]?.id} className={css.fold}>
        <summary>{t('enhanced.routineSteps', { count: segment.blocks.length })} · {[...new Set(segment.blocks.flatMap(block => block.items.filter(item => item.cell.callId !== undefined).map(item => item.cell.text)))].join(' / ')}</summary>
        {segment.blocks.map(renderBlock)}
      </details>
      : segment.blocks.map(renderBlock))}
    {blocks.length > visibleLimit && <Button size="sm" className={css.more} onClick={() => { setLimit(value => value + VISIBLE_STEPS) }}>{t('enhanced.moreSteps', { count: blocks.length - visibleLimit })}</Button>}
  </div>
}

/**
 * Render request navigation, role lanes, nested child histories, and raw inspection.
 * @param props - Framework Session hooks, localized copy, and read-only controls.
 * @returns Enhanced trajectory view.
 */
export function EnhancedTrajectoryView({
  sessionId, useSession, useTrajectory, useEnhancedFacts, useEnhancedChildren,
  loadOlder, expandChild, collapseChild, loadOlderChild, loadImage, peekImage, renderSlot, t,
}: ConvViewProps & InjectFace<EnhancedTrajectoryInjected>
  & PropsLocale<'trajectory'> & PropsRenderSlots<'conversation.enhanced-trajectory.images'>) {
  const snapshot = useTrajectory(value => value)
  const facts = useEnhancedFacts(value => value)
  const children = useEnhancedChildren(value => value)
  const hasMore = useSession(value => value.hasMore)
  const loadingOlder = useSession(value => value.loadingOlder)
  const openState = useSession(value => value.openState)
  const model = useMemo(() => deriveEnhancedModel(snapshot, facts, hasMore, t), [snapshot, facts, hasMore, t])
  const requestOrdinals = useMemo(() => new Map(model.groups.filter(group => group.kind === 'request')
    .map((group, index) => [group.id, index + 1])), [model.groups])
  const [groupId, setGroupId] = useState<string>()
  const [selected, setSelected] = useState<Selection>()
  const [pagingError, setPagingError] = useState<string>()
  const canvas = useRef<HTMLElement>(null)
  const groupAnchor = useRef<string>()
  const scrollAnchor = useRef<{ id: string; top: number }>()
  const childModels = useMemo(() => {
    const models = new Map<SessionId, ChildModel>()
    for (const [id, child] of children) {
      if (child.trajectory === undefined || child.facts === undefined) continue
      models.set(id, {
        snapshot: child.trajectory,
        model: deriveEnhancedModel(child.trajectory, child.facts, child.session?.hasMore ?? true, t),
      })
    }
    return models
  }, [children, t])
  const selectedModel = selected?.sessionId === undefined || selected.sessionId === sessionId
    ? { model, snapshot } : childModels.get(selected.sessionId)
  const selectedItem = selectedModel?.model.groups.flatMap(group => group.items).find(item => item.id === selected?.id)
  const recordSelection = useMemo(() => selectedItem === undefined ? null : { index: selectedItem.cell.index }, [selectedItem])
  const numbers = useMemo(() => selectedModel === undefined
    ? [] : trajectoryRequestNumbers(selectedModel.snapshot, t), [selectedModel?.snapshot, t])
  const inspectedSessionId = selected?.sessionId ?? sessionId
  const renderImages = useCallback<RenderMessageImages>(owner => renderSlot('conversation.enhanced-trajectory.images', {
    ...owner, loadImage: Object.assign((attachment: ImageAttachmentRef) => loadImage(inspectedSessionId, attachment),
      { peek: (attachment: ImageAttachmentRef) => peekImage(inspectedSessionId, attachment) }),
  }), [renderSlot, loadImage, peekImage, inspectedSessionId])
  // The request containing the selected record remains selected when older pages reconcile a partial group.
  const active = model.groups.find(group => group.id === groupId)
    ?? model.groups.find(group => group.items.some(item => item.id === groupAnchor.current))
    ?? (selected?.sessionId === sessionId ? model.groups.find(group => group.items.some(item => item.id === selected.id)) : undefined)
    ?? model.groups.at(-1)
  useEffect(() => {
    if (active === undefined) return
    if (active.id !== groupId) setGroupId(active.id)
    groupAnchor.current = active.items[0]?.id
  }, [active, groupId])
  useLayoutEffect(() => {
    const anchor = scrollAnchor.current
    if (anchor === undefined || canvas.current === null) return
    const element = [...canvas.current.querySelectorAll<HTMLElement>('[data-enhanced-record]')]
      .find(candidate => candidate.dataset['enhancedRecord'] === anchor.id)
    if (element === undefined) return
    canvas.current.scrollTop += element.getBoundingClientRect().top - anchor.top
    scrollAnchor.current = undefined
  }, [model])
  return <div className={css.root} data-enhanced-trajectory="" data-conversation-composer-overlay="">
    <nav className={css.requests} aria-label={t('enhanced.requests')}>
      <header><strong>{t('enhanced.requests')}</strong><span>{model.groups.filter(group => group.kind === 'request').length}</span></header>
      {hasMore && <p className={css.notice}>{t('enhanced.partialHistory')}</p>}
      {hasMore && <Button size="sm" className={css.more} disabled={loadingOlder} onClick={() => {
        setPagingError(undefined)
        const top = canvas.current?.getBoundingClientRect().top ?? 0
        const firstVisible = [...(canvas.current?.querySelectorAll<HTMLElement>('[data-enhanced-record]') ?? [])]
          .find(element => element.getBoundingClientRect().bottom > top)
        const id = firstVisible?.dataset['enhancedRecord']
        if (firstVisible !== undefined && id !== undefined) scrollAnchor.current = { id, top: firstVisible.getBoundingClientRect().top }
        void loadOlder().catch((error: unknown) => { setPagingError(String(error)) })
      }}>{t(loadingOlder ? 'history.loadingEarlierAria' : 'history.loadEarlier')}</Button>}
      {pagingError !== undefined && <p role="alert">{pagingError}</p>}
      {model.groups.map(group => <button key={group.id} type="button" className={css.request}
        aria-current={active?.id === group.id ? 'true' : undefined} onClick={() => {
          setGroupId(group.id); groupAnchor.current = group.items[0]?.id; setSelected(undefined)
          if (canvas.current !== null) canvas.current.scrollTop = 0
        }}>
        <span className={css.requestNumber}>{group.kind === 'request' ? t('enhanced.requestNumber', { number: requestOrdinals.get(group.id) ?? 0 }) : t(group.kind === 'interlude' ? 'enhanced.interlude' : group.kind === 'context' ? 'enhanced.sessionContext' : 'enhanced.incomplete')}</span>
        <span className={css.requestTitle}>{group.title}</span>
        <span className={css.requestMeta}>{t('enhanced.records', { count: group.items.length })}{group.items.some(item => item.cell.isError) ? ` · ${t('status.failed')}` : ''}</span>
      </button>)}
    </nav>
    <main ref={canvas} className={css.canvas}>
      <header className={css.canvasHeader}><strong>{active?.title || t('view.enhancedTrajectory')}</strong><span>{t('enhanced.orderedTime')}</span></header>
      <div className={css.laneHeadings}><span>{t('enhanced.lane.input')}</span><span>{t('enhanced.lane.model')}</span><span>{t('enhanced.lane.tool')}</span></div>
      {openState === 'loading' && <p role="status">{t('history.loadingTrajectory')}</p>}
      {active !== undefined && <Cards key={active.id} sessionId={sessionId} groups={[active]} children={children} childModels={childModels}
        anchor={scrollAnchor.current === undefined ? undefined : { sessionId, id: scrollAnchor.current.id }}
        ancestors={[sessionId]} selected={selected} select={setSelected} expand={expandChild}
        collapse={collapseChild} loadOlderChild={loadOlderChild} t={t} />}
    </main>
    {selectedItem !== undefined && selectedModel !== undefined && <aside className={css.inspector}>
      <TrajectoryTable key={inspectedSessionId} inspectorOnly t={t} renderImages={renderImages} turns={selectedModel.model.turns}
        requestNumbers={numbers} recordSelection={recordSelection} collapsedTurns={EMPTY_TURNS} onToggleTurn={noop}
        collapsedAssistants={EMPTY_RECORDS} onToggleAssistant={noop} onClearSelection={() => { setSelected(undefined) }} />
    </aside>}
  </div>
}
