# Prompt Management

## Scope And Ownership

Model-visible fixed text has two owners:

- Runtime prompts live under `packages/app/src/prompts/`.
- Eval-only judge prompts and rubrics live under `harness/src/prompts/`.

Persona files, injected memory, conversation transcripts, participant lists, timestamps, and replay evidence are runtime data. They are rendered through typed functions but are not platform prompt policy.

## Runtime API

Runtime callers use explicit renderers such as:

```ts
const prompt = renderActionSystemPrompt({ persona, memories });
```

Every renderer returns a `RenderedPrompt` with a stable semantic `id`, normalized `content`, and an automatically derived `contentHash`. There is no manually maintained prompt revision. The request artifacts retain the full model messages, while request and trace metadata record the prompt id, content hash, and tool prompt hash.

Tool descriptions and parameter descriptions live in `packages/app/src/prompts/tools.ts`. Tool schemas and execution remain in their owning runtime modules. The default tool registry is derived from the same catalog so model-visible tool copy has one source.

## No Conditional Policy Prompts

Fixed policy must not branch on runtime configuration or available tools. In particular:

- `leave` is always part of the action protocol and exit chain.
- The action system prompt has one fixed policy path.
- Dreaming has one terminal continuation task prompt and requires a completed action model session continuation.
- Initial windows and steered windows use the same transcript renderer.

Dynamic data rendering is allowed. Empty persona, memory, participants, or queries use deterministic placeholders rather than selecting another policy prompt. Each action window carries a minute-level current-time block and renders message timestamps in the GestaltHome `timezone`; this dynamic clock belongs in the appended user window rather than the stable system prompt. The runtime resolves an explicit IANA timezone first, then the machine timezone, then UTC, and traces the resolved value and source so replay remains inspectable.

## Change Workflow

When runtime prompt or tool copy changes:

1. Update the owning prompt module.
2. Update or add a durable scenario fixture if behavior changes.
3. Run `verify:prompts` and the narrow runtime verification.
4. Inspect `model-requests.json`, `model-exchanges.json`, `traces.json`, and cache evidence.
5. Run the relevant real-model eval.
6. Run typecheck and build.

Eval rubric changes follow the same evidence workflow but remain isolated inside the harness prompt directory.
