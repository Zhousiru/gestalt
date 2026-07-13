# Sticker Collection And Use

## Scope

Gestalt collects QQ sticker messages outside the agent loop, describes them with
the configured sub model, embeds the description, and exposes two model tools:
`search_sticker` and `send_sticker`.

Search results expose a stable sticker id and one natural-language `desc`.
Incoming chat transcripts retain complete OneBot CQ markup so the model can
identify image `file` values and call `read_image` when it needs visual context.

## Collection Boundary

The OneBot connector preserves parsed message segments under
`message.sourceContent`. The OneBot sticker extractor accepts only:

- A direct `mface` segment.
- An `image` segment carrying marketplace fields such as `emoji_id`,
  `emoji_package_id`, `key`, or `file=marketface`.
- An `image` segment whose numeric `sub_type` is `1`.

Ordinary `image.sub_type=0` messages, untyped images, QQ `face` messages, and
self messages are not collected. Extraction happens for every allowed incoming
message before trigger scheduling, so collection does not depend on the model
being activated.

## Runtime Control

GestaltHome `config.toml` provides the startup default and operator allowlist:

```toml
sticker_scraping_enabled = true
operator_user_ids = ["123456"]
```

Authorized operators may send `/scrape-sticker on`, `/scrape-sticker off`, or
`/scrape-sticker` to toggle the current process. The command is consumed by the
runtime without a model request, message window, or steer.

The switch gates only new observations. Jobs already queued or processing
continue through media preparation, description, embedding, and indexing.
Existing stickers remain searchable and sendable while scraping is off. Runtime
overrides are intentionally process-local; restart restores the config default.

## Processing Pipeline

The background worker processes multiple jobs concurrently. The configured
limit is:

```toml
sticker_processing_concurrency = 6
```

Each job independently follows:

```text
queued
-> resolving_media
-> downloading
-> rendering
-> describing
-> embedding
-> indexing
-> ready
```

Every successfully persisted `queued` job immediately wakes the worker, even
when another segment from the same message fails to persist. A transient
top-level worker failure cannot strand nonterminal jobs: the worker probes the
durable queue and retries itself with exponential backoff capped at one second.
Once the queue is terminal it stops polling, so recovery does not become a busy
loop.

Media is content-addressed with SHA-256. The full digest remains on the asset;
the model-facing stable id is `stk_` plus the first 16 hexadecimal characters
(64 bits) of that digest. A collision is rejected rather than overwriting an
unrelated record. An exact duplicate reuses the existing asset, description,
and vector row while merging the latest native mface delivery metadata.

Each observation persists its original message-segment index. If media must be
re-fetched, the resolver first checks that index and cross-validates stable
identity fields (`emoji_id`, package/key, image file id or digest); it never
silently substitutes the first image in a multi-image message.

Incoming `path` and HTTP fields are untrusted. The resolver accepts bounded
inline base64, otherwise treats `file` only as an opaque token for the
connector's explicit `read_image` action. Only media references minted by an
explicit connector action may be downloaded or read. Connector-returned URLs
are trusted and fetched directly, with a 30-second timeout and streamed 16 MiB
limit. Connector-returned absolute local files are explicitly marked, must be
regular non-symlink files, and are also size-limited. That local-file option
assumes the configured connector/action caller is trusted; deployments that do
not share a host should prefer connector-returned HTTPS or base64 media.

Image headers are validated before frame decoding. A sticker may be at most
4096 pixels on either axis, 8,388,608 pixels per frame, 256 frames, and
67,108,864 decoded pixels across one animation
(`width * height * frameCount`). Sharp/libvips also opens input under a nearby
native pixel guard, and each frame render and contact sheet composition has a
native 10-second terminating timeout. The implementation does not use a
JavaScript-only timeout that would leave decoding active in the background.

Static stickers are sent to the sub model directly. GIF, APNG, and animated
WebP media are sampled at 16 evenly spaced timestamps over one playback loop.
The composited frames are arranged left-to-right and top-to-bottom in a 4x4,
1024x1024 PNG. Frame delays participate in sampling, so long-held animation
frames may correctly appear more than once. The animation prompt asks the sub
model to infer the most likely complete action from temporal changes and
describe one coherent motion instead of listing individual frames.

The sub model emits one English `desc`: a short sentence followed by an ASCII
period and 3–8 unlabeled English search keywords. See
[MODEL_CONFIGURATION.md](MODEL_CONFIGURATION.md) for `main_model_*`,
`sub_model_*`, and `embedding_model_*`.

## Storage And Retrieval

Runtime state lives under the selected GestaltHome:

```text
stickers/
  blobs/
  jobs/
  records/
  lancedb/
sticker-logs/
  YYYY-MM-DD.jsonl
```

JSON records and blobs are the replayable asset source of truth. There is one
record per content hash. Observation provenance remains in durable jobs and
`sticker-logs`; the catalog record does not duplicate an unbounded occurrence
list. Sticker records, jobs, and logs use the current strict schema directly and carry no
schema-version field.

LanceDB is a rebuildable vector projection of `desc` with exactly one row per
sticker id. Each row contains only `row_id`, `sticker_id`, `desc`, `vector`, and
`created_at`. All conversations search the same catalog. The explicit
`embedding_model_id` selects its table and is stored with each record as the
vector-space compatibility identity; provider and model remain operational log
and Live overview metadata. Startup audit removes ids outside the exact ready
catalog and rebuilds missing or stale rows.

The store loads job and record directories once per runtime and keeps a
write-through in-memory catalog thereafter. Live pagination therefore does not
re-read and parse every JSON file on each SSE refresh; restart remains the
authoritative cache rebuild boundary. This follows GestaltHome's existing
single-process ownership assumption.

`search_sticker({ query, limit? })` embeds the query, performs global vector
search, catalog-validates candidates, and continues through ranked result pages
until it fills the requested limit or exhausts the table. Invalid nearest rows
therefore cannot hide a valid ready sticker. It returns `{ sticker_id, desc }`
candidates. The same id can be returned and sent in any group or private chat.
`send_sticker` accepts only that stable id. It prefers saved native
mface delivery and falls back to the cached bytes as
`[CQ:image,file=base64://...,sub_type=1]`; custom image stickers use the same
portable path so Gestalt and OneBot do not need a shared filesystem.

Sticker frequency remains persona behavior rather than a runtime probability.
Put the desired rhythm, common situations, and taboo cases in a persona Markdown
fragment such as `persona/6-stickers.md`, for example:

```markdown
- Use a sticker roughly once every four to six suitable playful turns, never as a quota.
- After sending one, prefer text or silence on the next turn unless asked again.
- Never use stickers for urgent, serious, grieving, or precision-critical exchanges.
```

The normal transcript records a
successful send as `[表情包 <id>：<desc>]`, so the model can see its own recent
sticker use without a separate usage counter prompt.

## Observability

Every lifecycle transition is appended to `sticker-logs`. Logs contain job,
sticker, source-event, conversation, model, prompt hash, dimension, and status
metadata, but omit mface keys, signed URLs, base64 media, vectors, and API keys.
Agent-initiated searches and sends carry the turn trace id. Rejected ordinary
images and failed searches/sends have typed entries, so operators can answer
why an observation was not collected or an action did not complete.

Sticker logs and Live event publication are best-effort observation sinks, not
part of processing or connector transactions. Their failure cannot retry a job,
change a successful send into a failure, or cause the connector to send twice.
Connector delivery failures return only stable public errors; connector response
payloads remain behind the runtime boundary.

Canonical session records, model transcripts, and Live session views retain
complete OneBot CQ markup. `fetch_message` returns normalized text with complete
CQ, and `read_image` keeps the original `file` value while attaching connector-
returned image bytes to the next main-model step. Outgoing `send_sticker` actions are recorded in transcript history as
`[表情包 <sticker_id>：<desc>]`; the proposal's exact id is therefore the durable
association between the model action, the local record, the send log, and the
synthetic self-message. The self event also stores the allowlisted runtime
metadata `raw.generatedBy = "send_sticker"` and `raw.stickerId`, so replay never
has to parse the human-readable transcript text to recover the link. Ordinary
connector `raw` trees remain excluded from session memory and diagnostics.
The model-visible send result contains only `stickerId` and `desc`; native/image
delivery and fallback details remain internal lifecycle logs.

Structured diagnostic payloads remain a separate boundary. Live JSON, buffered
events, SSE, trace previews, and `sticker-logs` remove duplicated structured
transport objects, standalone local paths, binary bodies, vectors, and API
credentials, while canonical message `text`/`rawText` retains the original CQ
markup for inspection. The background media
resolver still consumes connector-owned structured segments and media
references directly.

The Live UI `Stickers` page reads `/api/live/stickers/snapshot` and subscribes
to `sticker.*` events. Catalog responses are server-filtered and paginated with
`offset`, `limit`, `query`, `status`, and `source` query parameters. The default
page size is 48 and the service clamps requests to 100; every response includes
`catalog.offset`, `catalog.limit`, and the filtered `catalog.total`. This keeps
large catalogs out of a single response and DOM render.

Snapshots explicitly report `available=false` when the runtime has no sticker
subsystem instead of presenting an empty configured catalog. If SSE disconnects,
the page keeps its last good snapshot and polls at a low 30-second cadence until
the browser reconnects. Queue DTOs keep the current `stage` separate from
`lastFailedStage`, so a retry is visibly queued rather than appearing stuck in
its previous failed stage.

The page shows the effective scrape switch, queue stages, ready/failed/
deduplicated counts, embedding/LanceDB state, descriptions, source types, and
errors.
Animated stickers use a static contact sheet in catalog and queue lists. Their
detail view starts paused and exposes explicit play/pause controls while honoring
the browser's reduced-motion preference. On small screens, selecting a row opens
an accessible bottom drawer; desktop keeps the sticky detail pane. The selected
record is cached independently from the current offset page, so a live insertion
at the front of the catalog does not silently replace an open detail view.

The Live debug server currently has no authentication layer. It may bind to
`0.0.0.0` for local-network testing, which exposes trace, session, sticker, and
media diagnostics to every client that can reach the port. Browser requests
that include `Origin` must match the request `Host`; non-browser clients may
connect without an Origin header. Internet exposure should add authentication
at a reverse proxy or future application transport.

## Verification

Run:

```bash
pnpm --filter @gestalt/harness run verify:stickers
pnpm --filter @gestalt/harness run verify:sticker-media
pnpm --filter @gestalt/harness run verify:stickers-ui
pnpm --filter @gestalt/harness run eval:stickers
```

The deterministic fixture exports records, jobs, sticker logs, connector calls,
LanceDB search results, model request summaries, runtime command evidence, and
the 4x4 contact sheet under `harness/artifacts/stickers/`. Assertions prove
protocol classification, scrape-off backlog semantics, exact deduplication,
animation sampling, worker wakeups, retry isolation, embedding-id rebuild,
exact orphan-row pruning, invalid-neighbor search exhaustion, bot-wide search
and send behavior, intermediate-stage restart recovery, config-default restoration,
partial observation persistence, logger/Live failure isolation,
bounded worker self-recovery, native/image/fallback sends, trace-correlated
logs, authorization, and the no-model command boundary.

The focused media fixture additionally proves segment-index/identity selection,
untrusted inbound reference rejection, direct connector-action URL fetching,
the streamed 16 MiB cap, dimension/frame/decoded-pixel rejection, and a valid
16-sample 4x4 animation path. Its artifact is under
`harness/artifacts/sticker-media-security/`.

The Live UI fixture exercises a populated catalog through the real HTTP server,
including queue/failed/ready states, catalog pagination/filtering and limit
clamping, current versus last-failed stages, protected media assets, an SSE
catalog update, Live-boundary privacy redaction, all-interface binding, and
cross-origin rejection. Its API evidence and responsive browser QA screenshots are exported
under `harness/artifacts/live-stickers-ui/`; screenshots are manual visual-QA
artifacts and should be refreshed when an in-app browser instance is available.

`eval:stickers` uses the configured real model plus an independent judge to
check the prompt-sensitive social layer: explicit playful use searches then
sends, an immediate follow-up does not spam another sticker, and a serious
incident receives clear text rather than a sticker. Evidence is written under
`harness/artifacts/stickers-social-eval/`.
