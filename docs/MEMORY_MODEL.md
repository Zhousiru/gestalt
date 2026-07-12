# Memory Model

## Document Status

This document records the current memory and dreaming design.

It expands the memory principles in `MASTERDOC.md`. It is intentionally architectural, but it also points to the current implementation seams in `packages/app`.

Current implementation entry points:

- `packages/app/src/memory/store.ts`: file-backed self and user index loading.
- `packages/app/src/memory/dreaming.ts`: AI SDK ToolLoopAgent dreaming runner that exposes a `bash` tool backed by `just-bash`.
- `packages/app/src/context/renderTranscript.ts`: stable group transcript rendering.
- `harness/fixtures/scenarios/memory-injection-dreaming.json`: self/user memory injection and write verification.
- `harness/fixtures/scenarios/memory-correction-dreaming.json`: wrong memory correction verification.
- `harness/fixtures/scenarios/memory-pruning-dreaming.json`: stale memory pruning verification.

## Scope

Memory is file-backed and rooted in GestaltHome.

The first implementation should focus on:

- A simple narrative memory layout.
- Readable Markdown files.
- Injecting high-signal index files into model context.
- Letting dreaming maintain memory through a constrained bash environment.
- Harness-visible before/after memory snapshots.

This design does not introduce vector search, database storage, numeric relationship scores, or a custom memory patch language.

## Memory Layout

Memory lives under:

```text
GestaltHome/
  memories/
    self/
      index.md
      some-subject.md
    users/
      <user-id>/
        index.md
        some-subject.md
```

### Self Memory

`memories/self/index.md` is the compact entry point for the agent's own continuity.

It should cover:

- Stable self-understanding.
- Current projects and open threads.
- Recent changes in direction or priorities.
- Important self-related memories.
- Links to subject files.

Subject files under `memories/self/` hold focused summaries for specific themes, projects, habits, preferences, or long-running internal threads.

### User Memory

`memories/users/<user-id>/index.md` is the compact entry point for one user.

It should stay short and high-signal. It should cover:

- A brief profile.
- The user's relationship to the agent.
- Recent context and current status.
- Important memories.
- Cautions or boundaries.
- Links to subject files.

Subject files under `memories/users/<user-id>/` hold focused summaries for one topic, recurring pattern, project, shared history, or open thread.

The index file should point to subject files instead of duplicating all detail.

## File Style

Memory files are narrative Markdown, not structured CRM records.

The runtime should not force a heavy memory template. Memory quality should be shaped through the dreaming prompt, persona taste, and replay fixtures rather than through rigid file schemas.

They should avoid:

- Numeric affection, intimacy, trust, loyalty, or mood scores.
- Giant append-only logs.
- Unlabeled speculation presented as fact.
- Storing everything forever.

They should prefer:

- Short paragraphs or bullets.
- Clear distinction between stable facts, recent state, open threads, and cautions.
- Links between index files and subject files.
- Corrections over contradictory layering.
- Deleting or rewriting stale material when it no longer helps.

## Context Injection

The runtime should inject only compact memory by default.

For a group turn, the context compiler should include:

- `memories/self/index.md`, if present.
- `memories/users/<participant-id>/index.md` for participants represented in the compiled group context, if present.

The runtime should not dump every subject file into the prompt.

Subject files are available for deeper inspection through the memory bash tool during dreaming, and later during agent turns if we decide to expose read/search memory tools there.

## Group Transcript Comes First

Before memory injection becomes useful, the group-chat window should be rendered into a stable model-readable transcript.

The transcript should include:

- Conversation id and display name.
- Window reason and seq range.
- Message seq.
- Timestamp.
- Sender display name and user id.
- Mention/reply metadata.
- Message text.

Memory then attaches to a clear present-tense conversation rather than compensating for vague current context.

## Dreaming

Dreaming runs after an agent turn.

It receives:

- The rendered turn transcript.
- The current participants.
- The agent's proposed and executed actions.
- Relevant injected memory index files.
- The memory filesystem layout.
- A bash tool with a virtual filesystem containing `/memories`.

Dreaming is responsible for maintaining useful long-term continuity:

- Create missing user or self memory directories.
- Update compact index files.
- Create or revise subject files.
- Link index files to subject files.
- Remove or rewrite stale memory.
- Keep recent context fresh without hoarding every message.

Memory has a high admission threshold: keep only information likely to change a
future judgment or interaction. Typical candidates are stable identity,
preferences or boundaries; relationship changes or shared milestones; recurring
patterns or group norms; durable commitments or open threads; and corrections.
Dreaming infers these naturally from conversation. It should retain enduring
meaning rather than quotes, detailed retellings, routine interaction behavior,
per-interaction records, or facts that matter only to the current exchange.
Most ordinary conversations should produce no memory write.

Dreaming may run asynchronously. The main chat response should not wait on a long memory-maintenance pass unless a future product decision requires it.

## Bash-Based Memory Editing

The selected design is to let the dreaming model maintain memory files directly through a `bash` tool.

We use `just-bash` for this tool. The shell sees a virtual filesystem with a `/memories` folder. That folder is mounted to `GestaltHome/memories` through `ReadWriteFs`; the rest of the shell filesystem is in-memory and does not expose the repository or the full GestaltHome.

Initial bash boundary:

```text
cwd: /
writable mount: /memories -> GestaltHome/memories
network: disabled
python: disabled
javascript: disabled
```

The model may use ordinary shell and text tools such as:

```text
ls, cat, mkdir, mv, rm, grep, rg, sed, awk, head, tail, wc, diff, sort, printf
```

This keeps memory editing simple:

```bash
mkdir -p /memories/users/alice
cat /memories/users/alice/index.md
rg "project" /memories/users/alice /memories/self
printf "\n- 2026-07-06: Alice is refining the memory design.\n" >> /memories/users/alice/index.md
```

For larger edits, the model should write a temporary file and move it into place:

```bash
awk '...' /memories/users/alice/index.md > /tmp/index.md && mv /tmp/index.md /memories/users/alice/index.md
```

The runtime should record:

- Each bash command.
- Exit code.
- stdout and stderr.
- Memory snapshot before dreaming.
- Memory snapshot after dreaming.
- Diff or changed file list.

## Safety Boundary

The bash tool is a memory-maintenance tool, not general system access.

It must not access:

- `.env` or `.env.local`.
- Config secrets.
- Repo source files.
- Connector state outside memories.
- Traces except through explicit harness artifacts.
- Network by default.

The important simplification is that we do not design a custom `MemoryPatch` DSL. Bash is the editing surface; the runtime boundary is the filesystem root plus traceability.

## Harness Implications

Harness fixtures should be able to provide:

- A complete GestaltHome fixture.
- A memory snapshot under `harness/fixtures/memories/`.
- Session events that involve known user ids.

Harness artifacts should show:

- Memory files before the run.
- Memory files after dreaming.
- Dreaming model request, real response, `bash` tool calls, and `finish_dreaming` completion call.
- Bash commands used by dreaming.
- Trace spans for memory injection and dreaming.
- Whether only allowed memory files changed.
- Whether corrected or stale claims were actually removed from the final memory files.

The current Phase 2 home snapshots already provide the foundation for this.

## Implementation Order

Implementation order:

1. Build the group transcript renderer. Done.
2. Load file-backed memory indexes for `self` and participants represented in compiled context. Done.
3. Inject those indexes into the compiled context. Done.
4. Add an AI SDK ToolLoopAgent dreaming runner that exposes a `bash` tool and executes tool calls through `just-bash` with `/memories` mounted to `GestaltHome/memories`. Done.
5. Add harness fixtures that verify real dreaming model output and memory before/after changes. Done.
6. Add correction and pruning fixtures that verify old wrong or stale wording does not remain after dreaming. Done.

This order keeps the system understandable: first make the model understand the current conversation, then give it relevant long-term memory, then let dreaming maintain that memory.

## Open Questions

- Should agent turns also get a read-only memory bash tool, or should bash be dreaming-only at first?
- How aggressive should dreaming be about deleting stale memory?
- Should subject files be selected only by dreaming, or can the main agent request them during a turn?
- How should private conversation memory be separated from group-safe memory?
- When should memory changes require human review?

## Reference

- `just-bash`: https://github.com/vercel-labs/just-bash
