# Harness Workflow

## Document Status

This document records the current development workflow for the replay harness.

It is intentionally practical. `MASTERDOC.md` defines why the harness exists; this file defines how to use and extend it during ordinary development.

## Purpose

The harness turns runtime behavior into replayable evidence.

Every meaningful runtime behavior should eventually be represented by a scenario fixture that can be replayed, inspected, and asserted without relying on a live connector.

The harness should answer:

- What input events were sent?
- Which GestaltHome, persona, and config were used?
- What did the model see?
- What actions did the model propose?
- Which tools executed?
- What session and trace records were exported?
- Did the behavior match expectations?

## Current Shape

The harness is fixture-driven.

```text
harness/
  fixtures/
    homes/
    memories/
    personas/
    scenarios/
    sessions/
  src/
    fixtureSchema.ts
    replayRunner.ts
    assertions.ts
    groupChatLoop.verify.ts
    groupContext.verify.ts
    groupTriggers.verify.ts
    groupLoopLifecycle.verify.ts
    modelE2E.verify.ts
    multiStepAgent.verify.ts
    memory.verify.ts
    liveUiBuild.verify.ts
    onebotProtocol.verify.ts
    toolContract.verify.ts
    eval.ts
    evalRunner.ts
    onebotProtocol.eval.ts
    toolContract.eval.ts
  artifacts/
```

Important files:

- `fixtureSchema.ts`: Zod schema for scenario fixture JSON.
- `replayRunner.ts`: reads a fixture, creates a temporary GestaltHome, sends events with delays, runs the runtime, and exports artifacts.
- `assertions.ts`: checks session, trace, model input, action, tools, and connector side effects.
- `groupContext.verify.ts`: verifies recent group history, reply-target expansion, self-message tagging, and participant memory injection.
- `evalRunner.ts`: reruns scenarios, builds compact artifact evidence, calls an LLM judge, and writes eval artifacts.
- `eval.ts`: CLI entry for LLM-judged scenario evals.
- `toolContractRunner.ts`: executes fixed action proposals through mock tools and OneBot connector mappings.
- `multiStepAgent.verify.ts`: verifies the main agent can run a coding-agent-like multi-step tool loop in one turn.
- `liveUiBuild.verify.ts`: starts the built App with a temporary GestaltHome and verifies that the Live API, HTML, and UI assets share one origin.
- `fixtures/scenarios/*.json`: durable behavior fixtures.
- `fixtures/homes/*`: complete or partial GestaltHome fixtures.
- `fixtures/memories/*`: memory snapshots copied into temporary GestaltHome runs.
- `fixtures/sessions/*`: exported session snapshots used as initial replay state.
- `artifacts/<scenario-id>/`: generated run evidence. This directory is ignored by git.

## Scenario Fixture Format

A scenario fixture describes:

- `id`: stable scenario id.
- `description`: human-readable purpose.
- `homeFixture`: optional complete or partial GestaltHome directory.
- `configFixture`: optional config file copied to `config.toml`.
- `personaFixture`: optional persona directory under the repo.
- `memoriesFixture`: optional memory snapshot directory copied to `memories/`.
- `sessionSnapshotFixture`: optional exported session snapshot imported before events run.
- `eventHandling`: `manual_windows` for direct post-trigger windows, or `runtime_triggers` for pre-trigger verification.
- `model`: configured AI SDK model for durable harness verification.
- `events`: ordered mock message events, each with optional `delayMs`.
- `expectations`: assertions for session, action, tools, model input, and trace.

Current baseline fixtures use:

```json
{ "kind": "configured_ai_sdk" }
```

The harness may keep mock model support for narrow local experiments, but the committed verification baseline should use real configured model input and output. The connector and tools remain mocked so harness runs do not send live platform messages.

## Model Routing

Configured model scenarios read model settings from the fixture home `config.toml`.

The current real-model baseline uses an AI SDK OpenAI-compatible model. Provider-specific request options stay in config, not in harness scripts:

- `model_provider`: AI SDK provider name.
- `model_base_url`: OpenAI-compatible API base URL.
- `model_name`: model id.
- `model_api_key_env`: environment variable containing the API key.
- `model_temperature`: optional runtime model temperature used by the main action model, inspect agent, and dreaming agent.
- `model_routing_order`: comma-separated provider routing preference.
- `model_routing_allow_fallbacks`: whether the upstream router may use providers outside the routing order.
- `model_thinking`: optional provider thinking mode value, such as `disabled`.
- `model_tool_choice`: optional AI SDK tool-choice mode, `required`, `auto`, or `none`. When omitted, the runtime does not set a tool-choice value and leaves the default to AI SDK/provider behavior.
- `model_max_steps`: maximum AI SDK tool-loop steps for one action turn.
- `model_prompt_cache_enabled`: enables provider prompt caching for the active model session.
- `model_prompt_cache_ttl`: OpenRouter cache TTL (`5m` or `1h`).
- `context_recent_message_count`: how many previous messages from the same conversation are carried into compiled group context.
- `bot_user_id` and `bot_display_name`: identity used when recording successful bot group-message tool calls back into session history.
- `allowedgroups`: optional group id allowlist. When present, runtime-triggered group events outside the array are ignored before session ingestion.

Some OpenAI-compatible providers reject forced tool choice. In that case use `model_tool_choice = "auto"` and let the model decide whether to call tools. Harness assertions must still verify that the real model actually called the expected tool.

### Eval Judge Configuration

The LLM judge is harness infrastructure, not part of the persona runtime. It reads `harness/config/eval.toml` and never inherits model settings from the production GestaltHome or a scenario fixture home. The committed config records provider, model, routing, thinking mode, temperature, and timeout while the API key remains in its named environment variable.

Override the judge config with either:

```text
--eval-config path/to/eval.toml
GESTALT_EVAL_CONFIG=path/to/eval.toml
```

Precedence is command-line override, environment override, then `harness/config/eval.toml`. Eval artifacts record the judge model plus the resolved config path and a content hash so results remain attributable. Judge protocol and output schema stay in code; provider, model, thinking, routing, temperature, and timeout stay in the harness config.

## Replay Flow

The replay runner does this:

1. Load `.env` and `.env.local`.
2. Read and validate the scenario fixture.
3. Create a temporary GestaltHome.
4. Copy fixture home/config/persona/memories into that home.
5. Import an optional session snapshot.
6. Snapshot GestaltHome before events run.
7. Create a mock connector and mock tools.
8. Create a configured AI SDK model and capture every ToolLoopAgent request/response step.
9. Send fixture events in order, respecting `delayMs`.
10. Let the runtime handle each message window, or let runtime triggers decide whether to open a window when `eventHandling` is `runtime_triggers`.
11. Snapshot GestaltHome after the run.
12. Export session, traces, model requests, model exchanges, summary, home snapshots, and report.
13. Run fixture expectations through `assertions.ts`.

This keeps live platform connectors out of harness tests.

## Generated Artifacts

Each replay writes:

```text
harness/artifacts/<scenario-id>/
  session.json
  traces.json
  model-requests.json
  model-exchanges.json
  eval-inputs.json
  eval-results.json
  eval-report.md
  home-before.json
  home-after.json
  summary.json
  report.md
```

Use these files when debugging:

- `session.json`: conversation state, events, windows, turns, actions, and tool results.
- `traces.json`: trace spans for runtime operations.
- `model-requests.json`: captured AI SDK model request messages for configured model scenarios.
- `model-exchanges.json`: captured AI SDK step requests, real responses, and tool calls, grouped by purpose such as `agent_action` or `dreaming`.
- `eval-inputs.json`: rubric, criteria, and compact evidence sent to the LLM judge.
- `eval-results.json`: structured LLM judgment results with label, score, reasoning, concerns, and evidence.
- `eval-report.md`: human-readable eval report.
- `home-before.json`: temporary GestaltHome file snapshot before fixture events.
- `home-after.json`: temporary GestaltHome file snapshot after the run.
- `summary.json`: compact run summary.
- `report.md`: human-readable run report for quick review.

Artifacts are evidence, not source. They are ignored by git.

## Commands

Run TypeScript checks:

```bash
pnpm run typecheck
```

Run the real-model group-chat steering fixture:

```bash
pnpm --filter @gestalt/harness run verify
```

Run the focused OpenRouter prefix-cache verification:

```bash
pnpm --filter @gestalt/harness run verify:cache
```

Run the focused action-to-dreaming prefix-cache verification:

```bash
pnpm --filter @gestalt/harness run verify:dream-cache
```

Run the group context history fixture:

```bash
pnpm --filter @gestalt/harness run verify:context
```

Run the runtime trigger pre-chain fixtures:

```bash
pnpm --filter @gestalt/harness run verify:triggers
```

Run the active-loop lifecycle and exit-trigger fixtures:

```bash
pnpm --filter @gestalt/harness run verify:loop
```

Run the configured model e2e fixture:

```bash
pnpm --filter @gestalt/harness run verify:model
```

Run the multi-step main agent fixture:

```bash
pnpm --filter @gestalt/harness run verify:agent
```

Run the memory injection, correction, pruning, and dreaming fixtures:

```bash
pnpm --filter @gestalt/harness run verify:memory
```

Run the OneBot protocol e2e fixture:

```bash
pnpm --filter @gestalt/harness run verify:onebot
```

Run the tool contract e2e fixture:

```bash
pnpm --filter @gestalt/harness run verify:tools
```

Run the centralized prompt catalog and hash checks:

```bash
pnpm --filter @gestalt/harness run verify:prompts
```

Run all current LLM-judged evals:

```bash
pnpm --filter @gestalt/harness run eval
```

Run one LLM-judged eval:

```bash
pnpm --filter @gestalt/harness run eval:group
pnpm --filter @gestalt/harness run eval:context
pnpm --filter @gestalt/harness run eval:model
pnpm --filter @gestalt/harness run eval:agent
pnpm --filter @gestalt/harness run eval:memory
pnpm --filter @gestalt/harness run eval:onebot
pnpm --filter @gestalt/harness run eval:tools
```

Run the production bundle check:

```bash
pnpm run build
```

The app build keeps npm dependencies external and runs them from the existing
`node_modules`. Verify that the generated ESM entry can load dotenv, config, and
the runtime from the committed smoke-test GestaltHome, not only that compilation
succeeded:

```bash
pnpm run verify:build
```

The workspace dependency graph builds `@gestalt/trace` before `@gestalt/app`.
The App build copies the completed Trace UI into `packages/app/dist/live-ui/`;
it does not invoke Vite or reach into the Trace package's dependencies. The
build verification then starts the generated app on a temporary port and proves
that the health API, HTML shell, and a built UI asset are all served from that
one origin.

Clean generated build output before finishing work if `packages/app/dist/` was created.

## Adding A New Runtime Feature

When adding a runtime feature, follow this loop:

1. State the behavior in artifact terms before coding: what should appear in `session.json`, `model-requests.json`, `model-exchanges.json`, `traces.json`, tool calls, home snapshots, or eval output?
2. Implement the smallest runtime change that expresses the behavior.
3. Add or update a scenario fixture under `harness/fixtures/scenarios/`.
4. Add fixture home, persona, memory, config, or session data only if the behavior requires it.
5. Extend `fixtureSchema.ts` only when the fixture needs a new kind of input or expectation.
6. Extend `assertions.ts` so the expected behavior is checked from exported artifacts.
7. Run the relevant `verify:*` command.
8. Inspect `session.json`, `traces.json`, `model-requests.json`, `model-exchanges.json`, `home-before.json`, `home-after.json`, `summary.json`, and `report.md`.
9. If the behavior is qualitative, add or select an LLM eval rubric and run the relevant `eval:*` command.
10. Inspect `eval-inputs.json`, `eval-results.json`, and `eval-report.md`.
11. Keep the fixture if it captures a product principle, bug fix, or important behavior.
12. Run the broader affected verification set before finishing. At minimum, run `pnpm run typecheck`; run `pnpm run build` when runtime code changed, then remove generated `packages/app/dist/` before leaving the worktree.

Do not encode one-off behavior only inside a verify script. The durable source of behavior should be the fixture.

## Working From Artifacts

The harness workflow is intentionally evidence-first.

Do not treat a green command alone as proof that a feature behaves correctly. A command proves only the assertions it actually covers. For behavior changes, inspect the exported artifacts and make sure they prove the product claim.

Use this practical loop:

1. Run the narrowest `verify:*` command for the changed behavior.
2. Open the generated artifacts for that scenario.
3. Check whether the exported evidence proves the intended behavior.
4. If the artifact contradicts the intended behavior, fix runtime, prompt, fixture, or assertion code.
5. If the model behavior is different but better aligned with the product decision, update the fixture expectations and document the new decision.
6. If the behavior is social, qualitative, or prompt-sensitive, run an `eval:*` command and read the judge reasoning.
7. Run adjacent verification suites to catch regressions caused by shared runtime or prompt changes.

Useful artifact questions:

- Did the model actually see the needed context, or did the reply happen by luck?
- Did the tool call happen inside AI SDK tool calling, not as JSON or prose?
- Did a multi-step agent call one tool, observe the result, and then continue?
- Did the session export include the event/window/turn/loop-exit records needed for replay?
- Did a bot-visible side effect also appear as a self message when future context depends on it?
- Did trace spans make the same behavior inspectable without reading model prose?
- Did memory changes appear in `home-after.json`, and were stale or wrong claims removed rather than contradicted?

When an eval returns `warn` or `fail`, treat it as a behavioral finding. The fix may be a runtime bug, a prompt issue, missing artifact evidence, weak fixture wording, or a rubric that no longer matches the product decision.

## Real Model Baseline

Committed harness verification should prefer the configured real model path whenever the behavior depends on prompt following, tool calling, social judgment, memory writing, or protocol markup.

The common test shape is:

- Real configured AI SDK model.
- Mock connector.
- Mock tool implementations unless the scenario specifically verifies connector protocol mapping.
- Temporary GestaltHome copied from fixtures.
- Exported artifacts read by deterministic assertions and, when useful, by an LLM judge.

Mock models are still useful for narrow lifecycle mechanics such as idle timeouts, consecutive `say_nothing`, or explicit exit triggers. They should not be used as the only proof for model-facing behavior.

## Assertion Style

Prefer assertions that prove behavior from exported evidence:

- For prompt/context work, assert `modelInput.contains` and `modelInput.doesNotContain`.
- For multi-step tools, assert the full `action.toolNames`, `tools.toolNames`, trace `toolNames`, and `modelExchange.maxToolCallsPerResponse`.
- For lifecycle behavior, assert `loopExits` and `loopExitReasons`.
- For self-message behavior, assert `selfMessages` and inspect session events when debugging.
- For memory behavior, assert injected memory paths, concrete memory text, changed files, and removed stale text.
- For protocol behavior, assert canonical event shape and connector API payloads, not just high-level action names.

Avoid assertions that only prove the command ran. The fixture should make the intended behavior difficult to accidentally satisfy.

## Verify Versus Eval

The harness has two layers:

- `verify:*` commands are deterministic artifact assertions.
- `eval:*` commands are LLM judgments over replay artifacts.

Most social behavior does not have one exact answer. The eval layer therefore judges whether behavior is appropriate, coherent, well-supported by trace evidence, and aligned with the rubric.

An eval result contains:

- `label`: `pass`, `warn`, or `fail`.
- `score`: numeric score from `0` to `1`.
- `summary`: concise judgment.
- `reasoning`: explanation grounded in artifacts.
- `strengths`, `concerns`, and `evidence`.

Eval failures should be treated as behavioral findings. They may point to a prompt issue, runtime issue, tool boundary problem, memory quality issue, or fixture weakness.

## What To Verify

For session behavior, verify:

- Conversation count and ids.
- Event sequence numbers.
- Self-message count when bot output should be recorded as group history.
- Window count, reason, and seq range.
- Turn count and status.
- Loop exit count and reason.
- Turn phases.
- Steer count.
- Proposed action shape.
- Tool result status.

For model behavior, verify:

- The model request contains the relevant persona.
- The model request contains the relevant message window.
- The model request contains configured recent history when `context_recent_message_count` is set.
- The model request expands reply target contents beneath the replying message, including targets outside the recent-history range.
- Prior bot messages are marked naturally as `you`.
- Chat logs use minute-level time, stable user/message ids, and raw CQ-bearing message text without runtime window narration.
- The model request exposes the expected tools.
- The exported model exchange records the expected purpose and real response.
- Action selection is represented by model tool calls, not JSON text returned in assistant content.
- Multi-step agent behavior is represented by multiple model exchanges, with at most one action tool call per response when the fixture requires serial tool use.
- `leave` is a model-visible lifecycle tool and should appear in actions, tool results, session loop exits, and trace tool calls when the model actively exits the loop.
- `/leave` is a user control command that force-ends the current active loop as `slash_leave`; it should be recorded as an event, should not create a new model window, and should not require the model to call the `leave` tool.
- Dreaming exchanges expose the expected `bash` and `finish_dreaming` tool calls when memory is being maintained.
- The proposed action has the expected tool name and arguments.
- The action tool-call arguments stay inside basic shape constraints.

For tool behavior, verify:

- Mock tools were called as expected.
- Real connector side effects did not happen during harness runs.

For trace behavior, verify:

- At least one trace exists when a turn runs.
- Expected spans exist, such as `memory.inject`, `context.compile`, `model.decide`, and `tool.execute`.

For GestaltHome behavior, verify:

- The declared fixture home/config/persona/memory files appear in `home-before.json`.
- Runtime-created files, such as trace JSONL files, appear in `home-after.json`.
- Secret-like files such as `.env.local` are not captured in home snapshots.

## Current Fixtures

`group-chat-loop-steer.json` verifies:

- A mention starts a turn.
- A delayed second message steers the active turn.
- The steer is appended as a new user message while the original system/persona prefix remains byte-for-byte unchanged.
- All requests use one OpenRouter `session_id` and top-level `cache_control`.
- At least one completed response reports positive provider `cached_tokens`; structural prefix checks alone are not sufficient.
- An imported session snapshot is preserved and new events continue from the next seq.
- The final turn covers event seqs `[2, 3]`.
- The configured model receives the steered window and returns a real `send_group_message -> leave` tool sequence.
- Mock tools record both the visible reply and lifecycle exit.
- Successful `send_group_message` calls are appended to the exported session as self messages for future context.
- Eval rubric: `group_steer_quality`, judging whether the final action reflects the steered context as one coherent group reply.

`model-e2e.json` verifies:

- The configured model runs from a fixture GestaltHome with test persona and memory snapshot.
- The model request receives the test persona and group message.
- The model proposes `send_group_message -> leave`.
- The action is executed by mock tools.
- No connector side effect occurs.
- Eval rubric: `direct_reply_quality`, judging whether a direct mention produces an appropriate visible action and compact reply.

`group-trigger-keyword.json`, `group-trigger-activity.json`, and `group-trigger-icebreaker.json` verify:

- The harness can run events through the runtime pre-trigger chain instead of manually opening windows.
- Keyword trigger creates a `keyword` window from a configured alias.
- Activity trigger creates one `activity` window when a configured time range crosses the configured message threshold.
- Icebreaker trigger creates an `icebreaker` window when imported session history shows the group was quiet long enough.
- Exported `session.json` records the expected event sequence, window reason, and turn.
- `model-requests.json` records that the real configured model saw the trigger-created window transcript.
- Keyword windows currently verify `send_group_message -> leave` because the message naturally addresses the persona by name.
- Activity and icebreaker windows currently verify direct `leave` with no visible side effect when the chat itself does not invite the persona to join; the hidden trigger reason is not used to force a visible response.

`group-context-history.json` verifies:

- The action window exposes minute-level current local time, English weekday, and the resolved IANA timezone without seconds.
- Current messages and expanded reply targets render in the same configured timezone.
- The `context.compile` span records the resolved timezone, its source, and local compilation time.
- `context_recent_message_count` carries the configured number of previous messages.
- A `reply_to` target older than the recent-history range is still included.
- Prior bot messages are rendered with `you`.
- Messages outside the configured recent-history range stay out of the prompt.
- All participant `index.md` memories represented in the carried context are injected, without the old fixed fragment cap.
- Successful bot replies are exported as self messages in `session.json`.
- Eval rubric: `group_context_history_quality`, judging whether the compiled prompt and artifacts prove these context rules.

`group-active-loop-aggregation.json` verifies:

- A trigger-created `mention` window starts one agent loop.
- A later message in the same group does not run the pre-trigger chain while that loop is active.
- The later message is batched by the active-loop aggregation timer.
- The batched message enters the same turn as a `steer` window.
- The exported session records two windows but only one completed turn with `steerCount: 1`.
- The real configured model sees two natural chat-log messages appended to one model session, without initial/steer window narration.
- The resulting turn verifies `send_group_message -> leave`.

`multi-step-agent-tools.json` verifies:

- The main AI SDK agent behaves like a coding agent, not a single JSON action selector.
- The model calls `react_to_message`, observes the tool result, then calls `send_group_message`, observes that result, then calls `leave`.
- Each model response contains at most one action tool call.
- Session export preserves every proposed action and tool result.
- Trace export records the same tool sequence under `tool.execute`.
- Eval rubric: `multi_step_agent_tool_quality`, judging whether the serial tool sequence is coherent and inspectable.

`group-exit-idle-timeout.json`, `group-exit-say-nothing.json`, `group-exit-leave-tool.json`, and `group-exit-slash-leave.json` verify:

- Active loops export `loopExits` in `session.json`.
- Idle timeout releases an active loop when no new messages arrive.
- Three consecutive `say_nothing` turns release an active loop.
- The model-visible `leave` tool releases an active loop without connector side effects.
- The user control command `/leave` force-releases the active loop as `slash_leave` without a model request, model action, tool call, or connector side effect.
- Multi-turn loop fixtures can assert every turn's event sequence and steer count.

`memory-injection-dreaming.json`, `memory-correction-dreaming.json`, and `memory-pruning-dreaming.json` verify:

- `self/index.md` and `users/alice/index.md` are injected from file-backed memory.
- The `memory.inject` span records injected memory paths and previews.
- The configured action model sees injected memory and proposes a group reply.
- The configured dreaming model calls the `bash` tool and finishes with `finish_dreaming`.
- Dreaming continues the completed action model session with the same `session_id`, stable system message, exact prior message prefix, and deterministic provider tool protocol.
- The dreaming instructions are one appended user message; injected memory, the full transcript, and action/tool history are not serialized again.
- The first dreaming response, not only later dreaming steps, must report positive OpenRouter `cached_tokens` in the focused cache fixture.
- Bash runs in a VFS with `/memories` mounted to the constrained memory root.
- Bash dreaming writes both self memory and user memory through that mount.
- Wrong user memory can be corrected without leaving the old claim in the final file.
- Stale recent memory can be rewritten so it no longer reads as current truth.
- The generated artifacts show memory before/after changes.
- Eval rubric: `memory_dreaming_quality`, judging whether dreaming writes concrete useful memory to the correct files through safe bash tool calls.

`onebot-protocol-e2e` verifies:

- A fake OneBot v11 WebSocket server can push a raw group message event into the app.
- The OneBot connector normalizes reply, mention, text, image, and platform emoji information into CQ-like canonical message text.
- The rendered transcript exposes image and platform emoji context to the configured model as readable, copyable CQ markup.
- The configured model may call read-only helpers such as `read_image`, which map to OneBot APIs and return inspectable tool results before visible side effects.
- The runtime uses the normal trigger and agent-loop path.
- `send_group_message` executes as a OneBot `send_group_msg` API call with CQ string message text and `auto_escape=false`.
- WebSocket API responses are correlated through OneBot `echo`.
- Eval rubric: `onebot_protocol_e2e_quality`, judging the protocol evidence from `canonical-event.json`, `model-requests.json`, and `onebot-api-calls.json`.

`tool-contract-e2e` verifies:

- The runtime tool layer supports `say_nothing`, `fetch_message`, `read_image`, `send_group_message`, `send_dm`, `send_image`, `send_sticker`, `react_to_message`, `poke_user`, `recall_own_message`, and `leave`.
- Mock tools record every tool call without live connector side effects.
- OneBot connector mappings use `get_msg`, `get_image`, `send_group_msg`, `send_private_msg`, `send_msg`, `set_msg_emoji_like`, NapCat `send_poke`, and `delete_msg`.
- Read-only helper tools expose fetched message or image data in tool results without visible chat side effects.
- Image and sticker sends preserve CQ string messages with `auto_escape=false`.
- QQ marketplace sticker data can be preserved as `[CQ:mface,...]` markup.
- Eval rubric: `tool_contract_quality`, judging the exported proposal, mock tool, connector result, and OneBot API call artifacts.

## Development Rule

When a behavior matters enough to discuss, debug, or preserve, make it a fixture.

When a fixture fails, inspect the exported artifacts before changing the expected result. The artifact trail is there to keep the project honest.
