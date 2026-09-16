/** Durable mechanism evidence retained independently from the raw trajectory ledger. */
import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationNodeDefinition, ConversationViewBuilder,
  ConversationViewNode, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'

/** One recorded mechanism event, with its resolved execution location. */
export interface EnhancedFact {
  readonly event: SessionEventLike
  readonly location: ConversationLocation
}

interface FactNode extends ConversationViewNode {
  readonly data: EnhancedFact
}

/** Stable empty snapshot before the target is active. */
export const EMPTY_ENHANCED_FACTS: readonly EnhancedFact[] = []

const FACT_TYPES = new Set([
  'tool/call', 'subagent/catalog', 'session/end-seed', 'plan/mode', 'goal/change',
  'todo/write', 'tool-workflow/run-start', 'tool-workflow/agent-start',
  'tool-workflow/agent-end', 'tool-workflow/run-end', 'approval/asked', 'approval/decided',
  'turn/start', 'turn/end', 'agent/inbox/spliced', 'user/message',
])

/** Current-event matching keeps mechanism collection independent of history length. */
export const enhancedFactDefinition: ConversationNodeDefinition<SessionEventLike> = {
  kind: 'enhanced-fact',
  target: 'enhanced-trajectory',
  match: event => FACT_TYPES.has(event.type)
    && (event.type !== 'user/message' || event.data.source.kind === 'user')
    ? { id: String(event.seq), role: 'start' } : null,
  start: (_context, match) => match.event,
  update: context => context.state,
  buildViewNode: context => context.state === undefined ? null : {
    key: context.key, kind: context.kind, id: context.id, target: 'enhanced-trajectory',
    data: { event: context.state, location: context.start?.location ?? { kind: 'unresolved' } },
  } satisfies FactNode,
}

/** Keyed mechanism projection; prepending history replaces the same durable identities. */
export class EnhancedFactsBuilder implements ConversationViewBuilder<FactNode, readonly EnhancedFact[]> {
  readonly empty = EMPTY_ENHANCED_FACTS
  private readonly nodes = new Map<string, EnhancedFact>()

  replace(input: { readonly nodes: readonly FactNode[] }): readonly EnhancedFact[] {
    this.nodes.clear()
    return this.apply({ upserts: input.nodes })
  }

  apply(input: { readonly upserts: readonly FactNode[] }): readonly EnhancedFact[] {
    for (const node of input.upserts) this.nodes.set(node.key, node.data)
    return [...this.nodes.values()].sort((a, b) => a.event.seq - b.event.seq)
  }
}

/**
 * Register the enhanced view's mechanism evidence target.
 * @param ctx - Trajectory plugin context.
 */
export function registerEnhancedFacts(ctx: Context): void {
  ctx.uiConversation.events.register(enhancedFactDefinition)
  const view: ConversationViewDefinition<FactNode, readonly EnhancedFact[]> = {
    target: 'enhanced-trajectory', create: () => new EnhancedFactsBuilder(),
  }
  ctx.uiConversation.views.register(view)
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationViewSnapshotMap {
    /** Recorded mechanism facts for the request-oriented trajectory. */
    'enhanced-trajectory': readonly EnhancedFact[]
  }
}
