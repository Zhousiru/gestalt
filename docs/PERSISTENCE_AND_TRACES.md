# Session Journal, Rollout Trace, And Live Inspection

## Decision

Gestalt persists runtime history through two independent append-only stores:

- The **session journal** records received conversation facts and lifecycle
  facts. It is the source for restoring recent chat messages after startup.
- The **rollout trace** records one complete active model loop, including its
  initial prompt, committed message deltas, generations, tools, steering,
  outbound actions, and terminal dreaming continuation.

Neither format has a sequence field, format-version row, checkpoint, sidecar
index, or migration path. File order is authoritative. Records relate through
stable ids and ordered `eventIds`/message ids. Old snapshot and aggregate trace
files must be cleared or archived before adopting this layout; the runtime does
not parse or rewrite them.

The two stores have different recovery semantics. Session startup restores only
recent messages. It never revives old timers, active loops, steering attempts,
or provider sessions. An unfinished rollout is retained as failure evidence and
is never resumed.

## GestaltHome Layout And Configuration

```text
GestaltHome/
  sessions/
    journal/
      YYYY-MM-DD/
        000001.jsonl
  traces/
    YYYY/
      MM/
        DD/
          rollout-<timestamp>-<active-loop-id>.jsonl
    blobs/
      sha256/
        <first-two-hash-characters>/
          <full-sha256>
```

The blob tree is created only when binary capture is explicitly enabled and a
blob is actually stored.

```toml
# Restore message history from this many hours before startup.
session_recent_history_hours = 24

# Binary trace capture is privacy-sensitive and disabled by default.
trace_binary_capture_enabled = false
```

`context_recent_message_count` remains the second context bound and may not
exceed 500. The recent-hours setting controls what startup can restore; the
message-count setting controls what a newly activated model session receives.

There is no automatic retention or blob garbage collection in this design.
Operators explicitly archive or delete files. A later cleanup design must be
reference-aware before deleting content-addressed blobs.

One GestaltHome may have only one runtime writer. Multiple processes must use
separate homes rather than coordinating through these files.

## Session Journal And Bounded Runtime State

The journal appends immutable records for messages, trigger attempts, message
windows, completed turns, and loop exits. A message event has a stable record id
and canonical message id. Windows and turns carry ordered `eventIds`; their
meaning never depends on array offsets or a global counter.

The writer batches small appends but applies bounded backpressure. Callers await
journal admission before accepting more input. A durable flush is used at
boundaries where the runtime must know that a fact reached disk.
Journal admission uses one bounded 256-item lane across conversations. A slow
on-demand rehydrate therefore cannot let a later event overtake it in the file;
overflow is explicit rather than an unbounded Promise chain.

The in-memory `SessionStore` is a bounded working set:

- At most 2,048 message events per conversation.
- At most 128 records of each lifecycle/diagnostic collection per conversation.
- At most 64 inactive conversations.
- Conversations with an active loop are reference-counted pinned and cannot be
  evicted; overlapping runtime leases cannot accidentally unpin one another.

On startup, the history reader makes two bounded streaming passes over journal
days that overlap `session_recent_history_hours`, which defaults to 24. The
first pass keeps only the 64 most recently touched conversation keys; the
second hydrates the complete recent prefix for those keys. This avoids a
late-occurring conversation being retained with only its tail while keeping
key memory bounded. Only recent message events hydrate the working set. Old
windows, trigger attempts, turns, loop exits, timers, steer state, active loops,
and model sessions are not restored. Duplicate message records are ignored by
canonical `event.id`; the separate record id continues to identify the original
journal row.

If startup hydration evicts a conversation from the 64-conversation working
set, the next incoming event for that conversation first streams up to 2,048
recent messages for the configured time range. That rehydration and append are
serialized through the global admission lane and temporarily pinned, so
restored records precede the new event without weakening the inactive-
conversation bound or cross-conversation receive order.
`handleEvent` retains a second ingestion lease through admission, command and
sticker handling, window creation, and active-loop dispatch. When a loop starts,
its own pin overlaps that lease before the ingestion lease is released.

The history API supports bounded recent-message reads, exact recent-message
lookup, and server-side text search with opaque cursors. Consumers must not load
all journal history to filter it in memory.

Any bounded session object exported to the harness or Live UI is a diagnostic
view, not a startup persistence format and not valid replay input.

The public storage seams are deliberately small:

```ts
interface SessionHistoryReader {
  recentMessages(conversation, since, limit): Promise<SessionEventRecord[]>;
  findRecentMessage(conversation, messageId, since): Promise<SessionEventRecord | undefined>;
  searchMessages(query, scope, timeRange, cursor, limit): Promise<HistoryPage>;
}

interface RolloutWriter {
  append(record): Promise<void>;
  flush(options?: { durable?: boolean }): Promise<void>;
  close(status): Promise<void>;
}

interface RolloutReader {
  list(query): Promise<CursorPage<RolloutSummary>>;
  read(id): Promise<RolloutDetail>;
  reconstructInput(id, generationId): Promise<ReconstructedInput>;
}
```

## Incremental Rollout Trace

One rollout file corresponds to one active loop, from its first model session
initialization through steering, tool work, visible actions, loop exit, and final
dreaming. Records are immutable and use this fixed type set:

```text
rollout_started
model_session_initialized
message_committed
generation_completed
tool_completed
outbound_action_started
outbound_action_finished
span_completed
rollout_finished
```

`model_session_initialized` stores the initial system/persona/memory messages
and the deterministic provider tool protocol once. Every later user, assistant,
tool, steer, and dreaming message is appended once as `message_committed`.
Generation records therefore do not repeat the accumulated request.

Each committed state has a canonical SHA-256 `stateHash`. The initial hash binds
the initial messages and tool protocol; each later hash binds the preceding hash
and the next sanitized committed message. Binary availability is deliberately
excluded from the logical hash, so enabling capture or suffering a blob-write
failure cannot change model-prefix identity.

`generation_completed` records only its input state hash and message count,
output message ids, provider/model parameters, finish reason, usage/cache usage,
latency, and provider request id. It does not persist the cumulative request,
raw provider body, or duplicate response history. The record is appended before
its new output messages are committed, allowing a reader to reconstruct the
exact logical input at that generation. A cancelled generation has no output
message ids, commits no assistant message, and does not advance `stateHash`.

Normal operation finishes by appending `rollout_finished` with compact counts.
If that record is absent, readers derive `failed: process_restarted`. The file is
preserved for diagnosis and is never resumed.

### Outbound Side Effects

Before calling a connector for a visible or otherwise external side effect, the
runtime appends `outbound_action_started` and performs a durable flush. It then
appends `outbound_action_finished` with the connector result.

If restart leaves only the started record, readers derive
`failed: result_unknown_after_restart`. The runtime must not retry that action:
the connector may already have completed it even though its result was not
recorded. Session journal records do not duplicate outbound intent/result data;
the rollout is the sole authority for this boundary.

The same rule applies when a connector confirms dispatch but loses the response:
the tool result is `result_unknown`, the started record remains unresolved with
`result_unknown_after_dispatch`, and the model loop stops instead of retrying.
Once a visible send is known to have succeeded, its transcript-safe self message
is durably appended to the target conversation immediately, including DMs,
images, stickers, and cross-conversation sends. It does not wait for the rest of
the provider turn to finish.

Ordinary spans are appended once, after completion. Scores or future evaluation
facts are also new immutable records rather than in-place changes.

## Binary Boundary

Raw binary is never valid JSON trace data. Before any rollout, Live event, trace
preview, or ordinary diagnostic log is serialized, Buffer, Uint8Array, other
ArrayBuffer views, ArrayBuffer, serialized Buffer objects, and base64 media are
replaced with a descriptor:

```json
{
  "type": "binary",
  "mediaType": "image/png",
  "byteLength": 123652,
  "sha256": "...",
  "availability": "not_captured"
}
```

With capture disabled, the runtime records MIME type, length, and hash only. It
does not retain bytes, base64, numeric byte properties, local paths, or temporary
URLs. Text and prompt structure remain reconstructable, but image pixels do not.

With capture enabled, the runtime stores at most 16 MiB per blob. It hashes a
stable copy, writes a same-directory temporary file, syncs and verifies it, then
publishes it by atomic rename. Identical content across messages, generations,
or rollouts resolves to the same hash and file. The rollout contains only the
descriptor, never a filesystem path.

Capture does not download URLs or open untrusted paths. Oversize input becomes
`size_limit_exceeded`; filesystem or integrity failures become `write_failed`
with a small safe error code. Those failures never fail the chat path. Harness
fixture capture is separate and may always externalize media into its own
artifact `blobs/` directory without enabling production capture.

## Rollout-First Live API And UI

The app server and Trace UI share Zod wire contracts. List endpoints default to
50 items, clamp at 200, and use opaque cursors:

```text
GET /api/live/overview
GET /api/live/conversations?cursor=&limit=&query=
GET /api/live/conversations/:key/timeline?cursor=&limit=
GET /api/live/rollouts?cursor=&limit=&query=&status=
GET /api/live/rollouts/:id
GET /api/live/rollouts/:id/model-input?generationId=&view=delta|full
GET /api/live/blobs/:sha256
GET /api/live/events
```

Conversation timeline initially returns its newest page and explicitly loads
older pages upward. A rollout detail reads one target file. Full model input is
reconstructed only when requested for one generation; the default model view
shows deltas, state hash, prefix reuse, usage, and cache evidence.

Rollout lists traverse newest date directories lazily and stop after the cursor
page; they do not first materialize the trace tree. Selecting an item reuses its
resolved locator and opens only that JSONL. Because there is deliberately no
index, overview exposes an exact count up to 200 and a capped marker beyond it
instead of rescanning all historical directories for every refresh.

SSE publishes only changed entity ids and small summaries. It never carries a
rollout, prompt, binary descriptor tree, or provider body. The event bus keeps at
most 500 events, 2 MiB total, and 64 KiB per event; old events are evicted first
and an oversize event is replaced by a compact diagnostic.
The active-run summary store is also bounded to 500 entries with a 24-hour stale
TTL, so a failed terminal notification cannot leak memory indefinitely.

OneBot WebSocket ingress uses eight dispatch workers and a bounded 256-event
queue. Runtime dispatch waits only for journal admission and active-loop routing;
the longer loop outcome is observed separately. This preserves prompt steering
without dropping handler rejections or accumulating an unbounded chain of loop
Promises. Queue overflow is surfaced as an explicit diagnostic.

The Trace UI uses three desktop regions: Chats/Rollouts/Signals navigation,
conversation timeline, and rollout inspector. The inspector has Overview,
Model, Flow, and Records tabs. Binary descriptors show MIME, size, hash, and
availability; stored content is fetched only after explicit user action.
Incomplete outbound actions state that the result is unknown and was not
retried. Records open one JSON value in a dialog rather than rendering an entire
file at once.

Tablet uses two regions plus an inspector panel. Mobile uses list → timeline →
detail navigation with an explicit return path. Search is debounced, obsolete
requests are aborted, failures retry locally, offline state retains the last good
data, and motion honors `prefers-reduced-motion`. Search debounce is 200 ms and
state transitions stay within 150–200 ms when reduced motion is not requested.
Loading uses stable skeletons, empty states explain the next useful action, and
errors remain local to the panel that failed.

The blob endpoint serves only a configured, captured SHA-256 object and applies
`X-Content-Type-Options: nosniff`, strict content type, restrictive CSP, and
`Cache-Control: no-store`.

## Harness Evidence Split

Production rollout files are compact long-lived evidence. They are not the
source for full provider request artifacts. Every model step fans out to two
independent sinks:

```text
Model step
  ├─ production rollout sink: incremental committed records
  └─ optional harness capture sink: complete fixture request/response
```

The model boundary exposes this test seam without importing harness code:

```ts
interface ModelExchangeSink {
  onStepStarted(exchange: ModelExchangeStartedSnapshot): void | Promise<void>;
  onStepCompleted(exchange: ModelExchangeSnapshot): void | Promise<void>;
}
```

The model boundary awaits `onStepStarted` before tool execution can begin. The
rollout sink commits the initial model session and that generation's new input
messages at this boundary. `onStepCompleted` later appends the immutable
generation result and any committed assistant/tool output. A stable
`exchangeId` joins the two callbacks. This keeps the authoritative stateful
model/tool records in lifecycle order even when a provider executes tools
inside a model step; readers never repair replay order by sorting timestamps.
Completed diagnostic spans may still be appended later with their own explicit
start/end times because they do not participate in state reconstruction.

`model-requests.json`, `model-exchanges.json`, eval inputs, prefix-cache checks,
and OneBot protocol evidence come from the harness capture sink. Replay and
OneBot runners must not reverse-engineer those artifacts from rollout records.

The harness separately replays rollout message deltas and asserts that each
generation reconstructs to the captured canonical request: message order, tool
protocol, state hash, and output-message relationship must agree. Trace
assertions inspect record hierarchy, status, usage/cache data, state hashes, and
outbound action facts; they do not require a complete prompt inside each
generation record.

Structured message content remains structured at the capture seam. Tool
protocol capture includes each actual tool description and JSON input schema,
not only names. Harness assertions independently recompute every state hash and
externalize any canonical-request media before writing artifacts. Per-run model
step diagnostics, active-loop result/turn summaries, writer duplicate guards,
and recorded-span guards use bounded recent windows; canonical provider messages
remain the one intentional prefix state owned by the active model session.

Required regression coverage includes long journals, 20+ generation rollouts,
cancelled attempts, restart-derived failures, binary-disabled and binary-enabled
media, content deduplication, cursor paging, event-bus byte budgets, lazy detail
and blob reads, and responsive/accessibility states in the Trace UI. Binary
coverage includes Buffer, typed-array views, ArrayBuffer, data-image URIs,
serialized Buffer objects, and nested media values. Browser QA uses 1440×900,
1024×768, and 390×844 viewports and checks keyboard/focus, contrast, loading,
empty, error, offline, and reduced-motion behavior.

The durability fixture writes 100,000 session events to prove bounded memory,
backpressure, and linear disk growth. The media fixture includes the current
123,652-byte image: capture-off produces no blob or byte array, while capture-on
produces one content-addressed blob even when the image is referenced repeatedly.
