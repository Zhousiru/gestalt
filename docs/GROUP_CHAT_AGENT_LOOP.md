# Group Chat Agent Loop

## Document Status

This document records the current design choice for the group chat scenario.

It expands the runtime loop described in `MASTERDOC.md` for one specific case: a live group conversation where messages may arrive while the model is already thinking, using tools, or preparing an action.

This document is intentionally architectural. It does not define concrete code, connector behavior, or platform-specific implementation details.

## Scope

The first target scenario is group chat.

Group chat must not be treated as a simple request-response channel. It is a continuous message stream where the agent may observe, stay silent, react, reply, defer, or revise its thought process after new context arrives.

The design goal is:

- Keep the bot socially aware of a moving conversation.
- Reduce obvious lag by steering with batched new context.
- Avoid letting connector code own social behavior.
- Preserve replayability and traceability.
- Keep the post-trigger agent loop reusable for private chat and future connectors.

## Core Split

The group chat runtime is split into two chains.

### 1. Pre-Trigger Chain

The pre-trigger chain decides whether a group message window should become an agent turn.

It owns:

- Message ingestion into group session state.
- Stable event identity and append order in the session journal.
- Attention and scheduling.
- Deciding whether to start, delay, merge, or suppress an agent turn.

It does not decide the final social action. It only decides whether the model should be given a chance to inspect the current group context.

The implementation exposes this as a pluggable trigger chain in the runtime. A trigger observes the canonical event, exported session state, and flat Gestalt config, then may return one message window candidate. The first matching candidate then passes through a deterministic probability admission gate before it may create a window. A rejected candidate does not fall through to lower-priority triggers for the same event.

The default group triggers are:

- Mention trigger: fires when the normalized message has `mentionsBot=true`.
- Keyword trigger: fires when configured names or a configured regex match the message text.
- Activity trigger: fires when messages in the configured time range cross the configured activity threshold.
- Icebreaker trigger: fires when a group has been quiet for the configured duration and then receives a new message.

Each default trigger kind has an independent probability in the inclusive range
`0.0` to `1.0`, defaulting to `1.0`. Admission uses a deterministic SHA-256-
derived sample over the conversation, stable message identity, and trigger
reason. The same canonical message therefore receives the same result during
replay. Matched candidates, including probability rejections, are persisted as
session trigger attempts; rejected candidates do not create message windows or
model turns.

When a conversation is idle, a trigger-created window starts the post-trigger agent loop.

When that conversation already has an active agent loop, the trigger chain is paused for that conversation. New messages are appended to session state and enter the active-loop aggregation buffer instead of being evaluated as fresh triggers.

The active-loop aggregation buffer flushes on a configurable timer and injects the batched messages into the running loop as a `steer` window.

The active agent loop exits through pluggable exit triggers. The default exit triggers are:

- Consecutive silence: exit after the model chooses `say_nothing` for the configured number of consecutive turns.
- Idle timeout: exit when no new messages arrive for the configured active-loop idle duration.
- Leave tool: exit when the model selects the `leave` tool.

Current flat config keys:

- `allowedgroups`
- `trigger_enabled`
- `trigger_mention_enabled`
- `trigger_mention_probability`
- `trigger_keyword_names`
- `trigger_keyword_regex`
- `trigger_keyword_probability`
- `trigger_activity_enabled`
- `trigger_activity_probability`
- `trigger_activity_window_ms`
- `trigger_activity_min_messages`
- `trigger_icebreaker_enabled`
- `trigger_icebreaker_probability`
- `trigger_icebreaker_quiet_ms`
- `agent_loop_aggregation_delay_ms`
- `agent_loop_aggregation_max_delay_ms`
- `agent_loop_aggregation_backoff_multiplier`
- `context_recent_message_count`
- `session_recent_history_hours`
- `trace_binary_capture_enabled`
- `main_model_prompt_cache_enabled`
- `main_model_prompt_cache_ttl`
- `bot_user_id`
- `bot_display_name`
- `agent_loop_exit_say_nothing_enabled`
- `agent_loop_exit_say_nothing_count`
- `agent_loop_exit_idle_enabled`
- `agent_loop_exit_idle_ms`

### 2. Post-Trigger Agent Loop

The post-trigger chain is the main agent loop.

It owns:

- Context compilation.
- Model action choice.
- Tool proposal handling.
- Side-effect execution.
- Trace recording.

This chain should remain mostly shared between group chat and private chat. The group-specific pieces should be supplied through session state, message windows, and platform constraints rather than hard-coded inside the model loop.

## Selected Design: One Active Loop With Timed In-Loop Aggregation

The chosen design is one active agent loop per conversation.

When the conversation is idle, the pre-trigger chain may create a trigger window and start the post-trigger agent loop.

When the conversation is busy, the pre-trigger chain pauses for that conversation. New messages do not run triggers. They enter an active-loop aggregation buffer and are delivered to the running loop at timer boundaries.

The runtime should not steer the model on every single incoming message. It should batch new messages for a short time, then deliver that batch as updated context.

This preserves real-time awareness without making the model chase every small group-chat event.

## Message Windows

Incoming group messages are appended to the group session log immediately.

The runtime currently uses two window roles:

- Trigger windows start an agent loop when the conversation is idle.
- Steer windows inject timed batches into an already running loop.

A trigger window can close because:

- The conversation has been quiet long enough.
- A maximum window age has been reached.
- The bot was directly mentioned.
- Someone replied to the bot.
- A currently active thread needs attention.

The model should receive a message window, not just a single last message. The window should preserve:

- Conversation identity.
- Stable window id and ordered event ids.
- Window reason.
- Messages in order.
- Whether the bot was directly addressed.
- Whether this continues a recent bot thread.

The active-loop aggregation timer improves naturalness by giving users a short chance to complete their thought before the bot revises its pending response.

## Idle And Busy Behavior

The runtime behaves differently depending on whether the group has an active turn.

### Agent Idle

If there is no active turn, a pre-trigger decision may start a new agent turn.

The active loop creates one persistent model session. Its first turn compiles persona, memory, tools, platform constraints, recent history, and the trigger window into the stable session prefix.

The compiled transcript can include:

- The current message window.
- A configurable number of previous messages from the same conversation.
- Reply target contents expanded directly beneath the replying message, even when the target is older than the recent-history window.
- Prior bot messages marked naturally as `you`.

The model-facing transcript is intentionally a compact chat log rather than a
runtime event dump. It shows the conversation identity once, date boundaries,
minute-level send times, display names, user and message ids, raw CQ-bearing
message text, and `mentioned you` only for direct mentions of the bot. Window
reasons, event linkage, context labels, steering metadata, and duplicated
“decision target” summaries remain in rollout/session records instead of the
prompt.

`context_recent_message_count` controls how many previous messages seed a newly activated model session. Once the active loop starts, completed assistant tool calls and tool results remain in the model message chain directly; later windows do not reconstruct that history as another transcript.

### Agent Busy

If there is already an active turn, the pre-trigger chain pauses for that conversation. New messages still enter session state, but they are batched by the active-loop aggregation timer rather than evaluated as fresh triggers.

When the aggregation timer closes the batch, the runtime steers the active turn with the batched new context.

The steer window is rendered as a new user message and appended to the active model session. If a provider request is in flight, the runtime cancels that request, discards only its incomplete assistant output, and restarts from the same committed message prefix plus the appended steer message. Completed assistant/tool steps are retained.

If the turn is already committing a visible side effect, the batch is deferred.
The non-cancellable boundary begins after durable outbound intent and remains in
force through connector completion, target-session journaling, and durable model
step commit. Only then is the pending window appended and steered into the same
model session; the committed tool call/result remains in its prefix.

The key choice is that steering happens at aggregation boundaries, not on every single message arrival.

## Cancellable And Non-Cancellable Phases

Steering is allowed before irreversible side effects.

Cancellable phases include:

- Context compilation.
- Model thinking or reply generation.
- Read-only tool use.
- Read-only tool execution and result handling. A steer may discard an uncommitted read result and retry it from the appended context.

Non-cancellable phases include:

- A group message that has already been dispatched.
- A private message that has already been dispatched.
- A reaction or sticker that has already been dispatched.
- A committed memory write.

After a side effect has been dispatched, the runtime never rewinds that step.
New messages may start the next model attempt as soon as the completed tool
call/result is durable, but cannot cancel or repeat the external action.

## What Should Steer A Turn

The steer layer should be conservative.

Good reasons to close a steer window quickly or steer the active turn include:

- A user directly mentions the bot.
- A user replies to the bot.
- The person being answered adds important context.
- Someone says the issue is solved or the bot no longer needs to answer.
- Someone corrects a key fact.
- The topic shifts enough that the pending action may need revision.
- A new message introduces privacy or safety risk.
- The pending action may now be socially awkward, repetitive, or misleading.

Weak or unrelated messages should not constantly steer the model. They can remain in the timed window and be delivered at the next boundary.

## Steer Limits

The runtime must prevent infinite steering loops in fast group chats.

The design should support:

- A minimum interval between steer attempts.
- A maximum steer count for one attempted turn.
- A maximum age for one active turn.
- A fallback behavior when the group is too active.

When the runtime cannot get a stable enough window, silence or deferral is usually more natural than repeatedly chasing the conversation.

## Exit Triggers

Exit triggers decide when an active agent loop should release the conversation back to the pre-trigger chain.

They do not decide whether the bot should reply. They only decide whether the current active loop should keep listening for timed aggregation batches or stop and wait for future trigger activation.

The initial default exit triggers are:

- `consecutive_say_nothing`: exits after the configured number of consecutive turns whose model action is `say_nothing`.
- `idle_timeout`: exits after the configured active-loop idle duration with no new messages.
- `leave_tool`: exits when the model chooses the `leave` tool.

The `leave` tool has no connector side effect. It is an intentional disengagement action: finishing a reply or having nothing visible to add is not sufficient reason to call it. In those ordinary cases the model uses `say_nothing`, which ends the current model tool run while keeping the active loop available for later messages. `leave` records an explicit exit request and lets the runtime close the active loop.

Loop exits are exported in session state as `loopExits`, with the exit reason and the turn ids covered by that loop.

## Execution Boundary

The active-loop aggregation buffer is the mechanism for updating an active turn.
Before a visible tool executes, the runtime durably records intent and crosses a
non-cancellable commit boundary. Newly arriving messages are buffered until the
connector result and provider step are committed, then steer the next attempt
from the same model prefix.

This keeps the first implementation simple:

- The model can be steered before side effects.
- Approved tool actions execute directly once the turn reaches execution.
- New messages that arrive during execution cannot erase the committed action;
  they are delivered immediately after its durable step boundary.

## One Active Turn Per Group

For the initial design, each group conversation should have at most one active turn at a time.

This avoids:

- Duplicate replies.
- Competing model runs.
- Two actions based on incompatible committed prefixes.
- Connector-level behavior conflicts.

Timed aggregation batches can steer the active turn or wait behind it, but they should not start independent concurrent turns for the same group.

## Message Processing Flow

The selected group chat flow is:

1. A connector observes a platform event.
2. The event is normalized into a canonical event.
3. If `allowedgroups` is configured and the group id is not listed, the runtime ignores the event before session ingestion.
4. The event is durably appended to the group session journal with stable ids.
5. If the group is idle, the pre-trigger chain evaluates configured triggers.
6. If a trigger fires, the runtime creates a trigger window and starts an agent turn.
7. The active loop initializes one model session from the window, session state, persona, memory, tools, and platform constraints.
8. The model proposes actions.
9. While the turn runs, new messages for the same conversation bypass the trigger chain.
10. Those messages enter an active-loop aggregation buffer.
11. When the aggregation buffer closes during an active turn, its transcript is appended as a new user message; the in-flight provider request is restarted from the preserved prefix, or the append is deferred across a side-effect commit boundary.
12. Tool actions execute through tools and connectors.
13. Messages that arrive during non-cancellable execution are left for the next window.
14. Exit triggers run after each turn and during active-loop idle waits.
15. When an exit trigger fires, the conversation can again be activated through the pre-trigger chain.
16. The complete path is recorded in the active-loop rollout and session journal.

## Required Runtime Concepts

The current runtime skeleton is directionally correct, but group chat needs several explicit concepts.

### Group Session Store

Stores a bounded working set of recent group messages, active threads, recent
bot actions, and lightweight conversation state. Stable ids and ordered
`eventIds` relate records; journal file order is the receive order.

This is factual session state, not social behavior logic.

Startup streams only recent message records from the configured
`session_recent_history_hours` (default 24). It does not restore old windows,
turns, timers, active loops, steering, or model sessions. Active conversations
are pinned while inactive conversations and lifecycle diagnostics remain
bounded. The complete persistence contract is in
[PERSISTENCE_AND_TRACES.md](PERSISTENCE_AND_TRACES.md).

### Attention Scheduler

Owns the pre-trigger chain.

It manages trigger evaluation for idle conversations and the decision of whether a closed window should start an agent turn.

### Turn Manager

Owns active turn lifecycle.

It handles one-active-turn-per-conversation, active-loop aggregation, steering, cancellation, steer limits, and handoff back to the pre-trigger chain after the loop exits.

It also owns one model session per active loop. That session keeps an append-only
committed message chain, a stable provider session id, and the current
cancellable provider request. After the loop exits, dreaming receives an
immutable continuation of that same session and appends a terminal memory-
maintenance message instead of rebuilding persona, memory, transcript, and tool
history.

The provider-facing tool protocol stays stable for the whole session because
tool schemas are part of the cacheable prompt. Action tools, including `bash`,
and the terminal `finish_dreaming` tool are declared in one deterministic order
from the first request. `bash` is phase-scoped rather than phase-gated: active
loops get a private in-memory VFS with the `agent-browser` custom command, while
dreaming binds the same provider schema to its writable `/memories` VFS. Chat
side-effect tools remain unavailable during dreaming, and `finish_dreaming`
remains unavailable during chat actions.

The active-loop tool scope also owns its browser lifecycle. Every
agent-browser command is forced into namespace `gestalt` and session
`gestalt-<active-loop-id>`, overriding model-supplied routing flags. The scope
closes that exact session when a browser-using active loop settles; cleanup is
host lifecycle work and does not add a model tool step to the rollout.

The action policy is a single fixed prompt and `leave` is always part of the action protocol and exit chain. Dreaming has no standalone prompt path: it requires the immutable continuation from the completed action session and appends one centrally managed dreaming task message.

### Exit Trigger Chain

Owns active-loop release decisions.

It evaluates lifecycle conditions such as consecutive `say_nothing`, idle timeout, and the model-selected `leave` tool.

### Rollout Records

The active-loop rollout should record:

- Active-loop aggregation boundaries.
- Trigger reason.
- Exit trigger reason.
- Ordered window/event ids and the current canonical state hash.
- Steer attempts and steer count.
- Late messages seen during a turn.
- Execution phase transitions.
- Messages deferred to a later window because the active turn was already non-cancellable.

Without this, group chat behavior will be difficult to replay and debug.

## Relationship To Current Architecture

The current architecture can support this design without being rewritten.

The reusable post-trigger loop already has the right broad shape:

- Canonical events.
- Context compiler.
- Model action proposal.
- Tool execution.
- Trace recording.

The missing pieces are mostly before and around the loop:

- Group session state.
- Active-loop timed aggregation.
- Attention scheduling.
- Active turn lifecycle management.
- Execution boundary handling for non-cancellable phases.

These should be added as runtime orchestration layers, not connector features.

## Connector Boundary

Connectors must not own group chat social behavior.

A connector may:

- Observe platform events.
- Normalize raw events.
- Execute requested side effects.
- Return platform results and errors.

A connector should not decide:

- Whether the bot should speak.
- Whether a message is socially important.
- Whether a turn should be steered with new context.
- Whether a pending action should be revised.
- Whether memory should be written.

Those decisions belong in the runtime, scheduler, model, and harness layers.

## Harness Implications

The harness should be able to replay group chat scenarios with:

- Message timing.
- Stable event ids and journal order.
- Trigger windows.
- Active-loop aggregation windows.
- Batched steer messages.
- Turn cancellations.
- Non-cancellable execution boundaries.
- Messages deferred into the next window.
- Loop exit records.

Important eval cases include:

- Mention followed by extra context.
- Mention followed by “never mind.”
- Someone else answers before the bot replies.
- The topic changes while the bot is generating.
- High-speed group chatter where silence is preferable.
- A pending reply that would leak private context after a new message arrives.

## Current Decision

For group chat, the project will use:

- One active agent loop per group conversation.
- Trigger windows start a turn when the conversation is idle.
- The pre-trigger chain pauses for a conversation while its agent loop is active.
- New messages during an active loop are batched by a configurable timer and injected as `steer` windows.
- Each active loop owns one append-only model session; persona and memory appear only in its initial stable prefix.
- Each browser-using active loop owns one agent-browser session under the
  `gestalt` namespace and closes it when the loop settles.
- Each active loop owns one incremental rollout file; the initial prompt/tool
  protocol appears once and later committed messages advance `stateHash`.
- OpenRouter requests use a stable `session_id` plus prompt caching, and
  generation records retain provider cache-read usage.
- Dreaming is the terminal continuation of that session: it appends one user-side dreaming instruction, preserves the exact earlier message prefix, and reuses the same provider session id.
- Provider tool schemas remain stable across the action/dreaming boundary; execution capability changes through runtime phase gates so the first dreaming request can reuse the action prefix cache.
- Exit triggers release the conversation back to the pre-trigger chain.
- A post-trigger shared agent loop.
- Conservative batched steer behavior before side effects.
- One active turn per group conversation in the initial design.
- Outbound side effects durably record intent before connector dispatch; an
  unknown result after restart is surfaced and never retried.

This gives the bot a practical form of real-time awareness without turning the system into a rigid dialogue state machine.
