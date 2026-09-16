# Agent Note: Request-grouped enhanced trajectory

Status: implemented

English | [中文](2026-09-16-enhanced-trajectory.zh.md)

## Problem

The Trajectory ledger exposes individual records but makes one user request difficult to follow. Execution turns do not identify requests: automatic continuations can open another turn, while answers and steering can arrive inside an existing turn. Tool names alone omit context injection, compaction, and durable mechanism state.

## Decision

Enhanced trajectory prioritizes understanding Agent mechanisms and preserves raw inspection. Its left list groups user requests, its center orders cards in user/context, model, and tool/mechanism lanes, and its right panel reuses the Trajectory inspector. Existing Chat and Trajectory tabs remain available. The [Trajectory package](../../../../packages/client/ui-trajectory/README.md) owns this projection through the shared [Conversation assembly](../../../../docs/subsystems/conversation.md).

### Request grouping

A direct user submission admitted while idle opens a request. Answers, in-flight steering, and automatic continuations remain in the current request. Classification uses recorded message sources, inbox admissions, and turn boundaries. Idle next-step admission can open a request even when its message is recorded after turn start; next-turn admission identifies separately queued work. Execution turns retain their own labels inside requests.

Manual compaction outside a turn and its checkpoint form a selectable interlude. An automatic continuation afterward still belongs to the preceding request. In-turn compaction remains inside its request. Unloaded prefixes are labeled incomplete; fully loaded context-only Sessions are labeled as Session context. Prepending history reconciles ownership using durable record identities.

### Cards and evidence

Vertical spacing expresses execution order, not elapsed time. Wide containers allocate user/context, model, and tools/mechanisms in a 1:1:3 ratio; tool columns change with the mechanism instead of reserving a lane for each capability. Narrow containers stack cards. The request heading defaults to two lines with an explicit full-text disclosure. User, context, model, and compaction retain distinct colors and labels. Known tools carry capability labels; unknown tools keep their recorded names and a generic category, and shell commands remain environment operations without guessed intent.

Plan, Todo, Goal, approval, Workflow, and child-registration events remain distinct from tool executions. Workflow runs and model-step delegation batches use local member rows instead of canvas-wide edges. A member’s recorded start and end share one row; raw events remain selectable inside a disclosure. Workflow rows align event order without implying duration, dependencies, or barriers. Complete member pairs can establish observed overlap; a phase label cannot establish a dependency. Agent rows distinguish dispatch, authored messages, and runtime settlement notices. Notice delivery times cannot establish execution intervals, and repeated notices do not identify separate activations without their boundaries. Current plugin configuration cannot establish historical execution.

Consecutive completed ordinary steps and large ordinary call batches fold into counted disclosures; errors and key scheduling members remain visible. Scheduling summaries reflect all loaded evidence. Later messages, notices, and controls retain compact chronological receipts with explicit navigation to the dispatch and back. Child histories expand below the complete summary, so expansion cannot stretch parent connectors across child records. Cards use deterministic excerpts without model requests. The inspector preserves original records, and missing timing stays unavailable. Rendering grows in bounded batches; earlier Session pages load on demand.

### In-place child histories

Recorded child references expand inside the parent request. Client `sessions.observeSubagent` retains a healthy discovered child binding, opens authenticated history, and returns an idempotent release operation. It neither changes selection nor resumes the Agent. Observations share the ordinary binding; an unlisted, unselected child is released after its last observer releases it. Selected and listed Sessions retain their ordinary lifetime.

The view owns child subscriptions outside React. Collapse and final view unsubscribe release observations without canceling work. Children have independent paging, loading, and failure states; failed expansion can retry. Descendants expand recursively, while an already visited Session remains a reference. Fork prefixes are marked inherited when the seed boundary is loaded. Workflow children retain recorded phase and label data. Selecting a nested card inspects the child’s records and authorized images.

## Alternatives considered

**Replace Trajectory.** A separate tab preserves compact ledger inspection while allowing a different reading density for mechanisms.

**Use execution turns as requests.** Automatic wakeups would appear as new user requests and fragment one task across groups.

**Use plugin scope as the primary taxonomy.** Session/global scope describes composition rather than the operation being understood; current configuration cannot reconstruct historical composition.

**Scale position by wall time or create a lane per capability.** Long waits create empty space and many lanes make cards too narrow. Ordered role lanes with recorded durations preserve readability.

**Navigate away for each child.** Navigation loses the parent context needed to understand delegation. In-place observations preserve that context at the cost of additional subscriptions and rendering.

## Consequences

The feature changes presentation and Client observation lifetime without changing Agent execution, model input, or durable Session formats. Historical Sessions use supported decoding and ordinary paging without rewriting user records. The view cannot establish unrecorded relationships or independently verify Agent conclusions. A partially loaded fork may lack its seed boundary, and arbitrary third-party tool semantics remain uncategorized. Expanded children increase memory and layout work; demand loading, collapse, and progressive rendering limit the initial cost.

Projection tests cover idle inbox admission, steering, continuations, compaction interludes, prefix reconciliation, inherited records, Workflow references, and unknown tools. Lifecycle tests cover shared retention, release, stale asynchronous discovery, and retries. The keyless subagent browser scenario covers expansion without Agent activation or parent navigation, raw inspection, keyboard access, collapse, and narrow layouts. The three supplied Sessions were inspected read-only; their private content is absent from committed fixtures.
