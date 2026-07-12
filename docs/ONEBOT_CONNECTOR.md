# OneBot Connector

## Scope

This document records the current OneBot v11 integration shape.

The connector is an I/O protocol boundary. It must not own social behavior, trigger decisions, memory behavior, or agent-loop lifecycle. Those remain in the runtime.

Current implementation entry points:

- `packages/app/src/connectors/onebot/schemas.ts`: OneBot v11 raw event and action response schemas.
- `packages/app/src/connectors/onebot/message.ts`: OneBot CQ-code and message segment codec.
- `packages/app/src/connectors/onebot/connector.ts`: raw event normalization and OneBot action mapping for message, image, sticker, read-message, read-image, reaction, poke, and recall tools.
- `packages/app/src/connectors/onebot/transport.ts`: forward and reverse WebSocket transports with echo-correlated API calls.
- `harness/src/onebotProtocolRunner.ts`: fake OneBot WebSocket protocol harness.

## Runtime Boundary

OneBot events enter the system as raw protocol objects.

```text
OneBot raw event
-> OneBot schema validation
-> canonical MessageReceived event
-> bounded ingress queue
-> runtime.dispatchEvent()
-> existing trigger / active-loop / agent-turn path
```

The dispatch receipt waits for journal admission and active-loop routing, not
for the whole idle/dreaming lifetime of that loop. The longer outcome is
observed separately so eight ingress workers cannot be occupied by eight idle
loops and block later steering messages.

Tool execution leaves the runtime through the connector:

```text
action proposal
-> connector tool method
-> OneBot API action
-> OneBot API response
-> tool result trace
```

## Canonical Message Shape

The canonical message model uses one ordered text field as the model-visible message body.

For OneBot, that text is normalized into CQ-like markup:

```text
[CQ:reply,id=111][CQ:at,qq=10001,name=小格] 小格看看这张图 [CQ:image,file=cat.png,url=https://example.test/cat.png,summary=一张测试图片] [CQ:face,id=14,name=微笑]
```

This keeps the model's input and output simple: it can read, copy, or omit the same inline markup instead of producing nested message segment JSON.

The runtime still keeps important derived signals on the message:

```text
mentionsBot
replyToMessageId
```

The raw OneBot event is still preserved on the canonical event as `raw`.

## Event Mapping

Current supported OneBot events:

- `post_type=message`, `message_type=group`
- `post_type=message`, `message_type=private`

Group message mapping:

```text
self_id -> source.accountId
message_id -> message.id and source.rawEventId
group_id -> conversation.id
user_id -> sender.id
sender.card || sender.nickname -> sender.displayName
message/raw_message -> CQ-like message.text and rawText
at segment targeting self_id -> message.mentionsBot
reply segment -> message.replyToMessageId
```

Private message mapping:

```text
user_id -> conversation.id and sender.id
message_type=private -> conversation.kind=private
```

## Send Mapping

The output tools remain text-first:

```text
send_group_message({ groupId, text })
send_dm({ userId, text })
fetch_message({ messageId })
read_image({ file })
send_image({ conversation, file, caption?, summary?, replyToMessageId? })
send_sticker({ conversation, sticker, replyToMessageId? })
react_to_message({ messageId, emojiId, remove? })
poke_user({ userId, conversation? })
recall_own_message({ messageId })
```

Message text may contain normal text or CQ-like markup. The OneBot connector sends CQ string messages with `auto_escape=false` so OneBot-compatible implementations parse the CQ markup.

```json
{
  "action": "send_group_msg",
  "params": {
    "group_id": 123456,
    "message": "[CQ:reply,id=321]...",
    "auto_escape": false
  },
  "echo": "..."
}
```

If the model wants to reply to a specific message, it should put `[CQ:reply,id=...]` at the start of `text`.

The connector also preserves parsed OneBot segments in canonical
`message.sourceContent`. The background sticker extractor uses these structured
segments rather than reparsing CQ text. It accepts NapCat custom image stickers
with `image.sub_type=1`, direct `mface`, and marketplace stickers reported as
images with mface fields. See [STICKER_SYSTEM.md](STICKER_SYSTEM.md).

The model-facing sticker boundary is `search_sticker` followed by
`send_sticker({ sticker_id })`. Incoming direct `mface`, `image.sub_type=1`,
and marketplace-compatible `image` segments remain complete CQ markup in the
agent-facing transcript. This lets the model use the exact image `file` value
with `read_image`. For collected-sticker output, the model should still use the
stable-id tools rather than handcrafting a transport payload. The runtime sends native
mface when available and otherwise sends the cached asset as
`[CQ:image,...,sub_type=1]`.

`react_to_message` currently maps to NapCat's `set_msg_emoji_like` extension.

`fetch_message` maps to OneBot `get_msg`. It is a read-only helper for cases
where a reply's quoted original cannot be expanded beneath that message in the
compiled chat log. The connector retains structured fetched segments for the
media resolver, while the tool implementation returns normalized message
metadata and complete CQ text to the model. `read_image` likewise retains the
connector-provided image file and metadata in its tool result.

`read_image` maps to OneBot `get_image`. It fetches platform-cached image data by image `file` id. Connector-owned base64, HTTPS, or local-cache media is resolved by the runtime and appended immediately after the tool result as a multimodal user message, so the main model reads the actual pixels on its next step. OpenAI-compatible tool messages themselves are text-only, which is why the adjacent image message is required. Metadata alone is reported as unavailable rather than being mistaken for visual understanding.

For background sticker ingestion, successful `get_msg`/`get_image` actions also
produce connector-owned media references outside the model-visible segment
contract. This explicit action boundary is what authorizes HTTPS/base64 or a
trusted local cache path; raw incoming `path` and URL fields are never opened
directly by the sticker worker.

`poke_user` maps to NapCat's `send_poke` extension. In group conversations the connector includes `group_id`; otherwise it sends a private/friend poke.

`recall_own_message` maps to OneBot `delete_msg`. The tool name intentionally narrows the model-facing contract to bot-owned messages, even though the underlying OneBot action is the generic message recall API.

Current reading boundary:

- Image and sticker CQ metadata remains visible. The main model calls `read_image` with the exact `file` value, after which its next step receives the image itself as multimodal input.
- Platform emoji input is visible as tags such as `[CQ:face,id=14,name=微笑]`.
- Mentions are visible as `[CQ:at,qq=...,name=...]`, and `mentionsBot` remains the authoritative bot-addressed signal.
- Replies are visible as `[CQ:reply,id=...]` and `replyToMessageId`; the quoted original content is only visible if it is already in the session transcript.

## Transport

Two transport modes exist:

- `forward_ws`: Gestalt connects to a OneBot WebSocket server.
- `reverse_ws`: Gestalt opens a WebSocket server and waits for the OneBot implementation to connect.

Both modes use OneBot's `echo` field to correlate API calls with responses.
Inbound handling is bounded to eight active dispatches and 256 queued events;
overflow and handler failures are explicit diagnostics. Once an outbound frame
has been queued, a disconnect, malformed response, disposal, or asynchronous
send failure means the remote result is unknown. The runtime records that state
and does not retry the side effect automatically.

Configure the transport in GestaltHome `config.toml`:

```toml
connector = "onebot-forward-ws"
onebot_ws_url = "ws://127.0.0.1:3001"
onebot_access_token_env = "ONEBOT_ACCESS_TOKEN"
```

```toml
connector = "onebot-reverse-ws"
onebot_host = "0.0.0.0"
onebot_port = 16700
onebot_path = "/onebot/v11/ws"
onebot_access_token_env = "ONEBOT_ACCESS_TOKEN"
```

The access token itself stays in the named environment variable rather than in
the config file or process arguments. Start the configured app with only its
GestaltHome location:

```bash
pnpm --filter @gestalt/app dev -- --home .gestalt
```

For live OneBot mode, the runtime uses the model configured in GestaltHome.

The same host config controls the optional Live inspection server:

```toml
live_enabled = true
live_host = "127.0.0.1"
live_port = 3000
```

`live_enabled` defaults to `false`, and `live_port` defaults to `3000`. When
enabled, the Gestalt app owns the single public port: it serves `/api/live/*`,
SSE, and the bundled Live UI from the same HTTP server and origin.

The Trace UI reads cursor-paged conversation and rollout endpoints and loads a
selected rollout/blob on demand; it does not request one aggregate workspace
payload. See [PERSISTENCE_AND_TRACES.md](PERSISTENCE_AND_TRACES.md) for the API,
SSE budgets, and binary-serving boundary.

The Live debug server has no authentication. It may bind to `0.0.0.0` for
trusted local-network inspection, which exposes conversation, rollout, blob,
and sticker diagnostics to every client that can reach the port. Browser
requests with an `Origin` header must match the request `Host`; non-browser
clients may connect without an Origin. Internet exposure requires
authentication at a reverse proxy or a future application transport.

Connector, OneBot transport, and live host/port settings are no longer accepted
as CLI arguments. `--home` remains the bootstrap override, and
`--live-ui-dir` remains an optional static-asset override.

## Harness Verification

The protocol harness starts a fake OneBot WebSocket server, then runs the app connector against it.

It verifies:

- Raw OneBot group message event arrives over WebSocket.
- Reply, mention, text, image, and platform emoji information survives as CQ-like message text.
- The model request transcript includes readable, copyable CQ markup.
- Complete sticker CQ payloads remain present in canonical artifacts and model request transcripts so image reads are possible.
- The runtime stays on the normal trigger and agent-loop path.
- Optional read-only helper tool execution can call `get_msg` or `get_image` before a visible send action.
- A `fetch_message` result preserves complete mface and custom-sticker CQ text, and `read_image` preserves metadata while attaching connector-returned image bytes to the next main-model step.
- Complete provider image input remains in harness-only model exchange capture.
  Production rollout JSON contains only its binary descriptor, and production
  blob capture remains disabled unless the fixture explicitly tests that option.
- Tool execution sends a `send_group_msg` OneBot API call over WebSocket with CQ string message text.
- The API response is matched by `echo`.
- `model-exchanges.json` is written directly from the capture sink, including
  structured canonical messages and complete tool protocol definitions.

Commands:

```bash
pnpm --filter @gestalt/harness run verify:onebot
pnpm --filter @gestalt/harness run eval:onebot
pnpm --filter @gestalt/harness run verify:tools
pnpm --filter @gestalt/harness run eval:tools
```

Artifacts are written to:

```text
harness/artifacts/onebot-protocol-e2e/
```

Important artifacts:

- `canonical-event.json`
- `model-requests.json`
- `onebot-api-calls.json`
- `session.json`
- `eval-results.json`
- `eval-report.md`

## Current Non-Scope

The first implementation intentionally does not yet include:

- Automatic vision interpretation without an explicit `read_image` call. Sticker media has its own background analysis pipeline.
- Audio or video download/cache handling.
- Group administration actions.
- Friend or group request handling.
- Group member profile cache.
- OneBot implementation-specific extensions beyond documented sticker handling, `set_msg_emoji_like`, and NapCat `send_poke`.

These should be added as explicit tools or connector capabilities when the agent behavior needs them.
