# Agent Browser Integration

## Decision

Gestalt exposes browser automation through the existing `bash` model tool. It
does not add a second provider-facing browser tool protocol.

The action prompt contains two short browser lines:

```text
In chat, agent-browser is available through bash; before first use run: agent-browser skills get core.
For web search, run agent-browser open "https://www.google.com/search?q=<keywords>", then inspect the results.
```

The skill text is loaded into model history as the ordinary result of that
`bash` call. Browser commands after that use the same multi-step tool loop.

## Phase-Scoped Bash

`bash` has one stable name, description, and input schema across the action and
dreaming phases. Each phase constructs a separate just-bash instance:

| Phase | VFS | Custom commands |
| --- | --- | --- |
| Active loop | private in-memory VFS per active loop | `agent-browser` |
| Dreaming | in-memory base plus writable `/memories` | none |
| Inspect | in-memory base plus read-only `/sessions` and `/traces` | none |

The active-loop command forwards the parsed argv and stdin directly to the
native agent-browser CLI with `shell: false`. Gestalt reserves the browser
routing fields and invokes every command with:

```text
--namespace gestalt --session gestalt-<active-loop-id>
```

Any `--namespace` or `--session` supplied by the model is removed before these
runtime-owned values are added. Gestalt does not inject `AGENT_BROWSER_*`
environment variables or otherwise filter agent-browser commands. just-bash
exposes all of its registered commands; it does not expose an unrestricted
host shell.

The active-loop abort signal is forwarded through just-bash and terminates the
current native CLI process. If agent-browser was invoked, the tool scope runs
`agent-browser --namespace gestalt --session gestalt-<active-loop-id> close`
when the active loop settles. Loops that never invoke agent-browser do not
start a cleanup process. Cleanup is idempotent, has a bounded timeout, and
cannot change an already completed loop result. Each browser-using loop
therefore owns and reclaims exactly one browser session.

## Trace Contract

The model and rollout see one `bash` tool call and one `bash` tool result.
agent-browser commands are implementation details inside that call and do not
create nested Gestalt tools, spans, or Trace UI step types. stdout, stderr, and
exit code are returned as the bash result. Runtime-owned session cleanup is a
host lifecycle action and is not recorded as a model tool step.

## Packaging

`agent-browser` is a pinned application dependency, so its native binaries are
installed and copied by the existing pnpm deploy flow. The runtime image adds:

- Debian Chromium
- CJK and emoji fonts
- CA certificates
- `tini` for process reaping

The container continues to run as the unprivileged `node` user. Chromium is
found through the normal executable discovery performed by agent-browser; the
image does not set a global executable-path override.

## Verification

- `pnpm --filter @gestalt/app run verify:bash` checks the real core-skill
  command, exact argv/stdin forwarding, runtime-owned namespace/session
  override, scoped close, cancellation, and per-loop VFS isolation.
- `pnpm --filter @gestalt/harness run verify:browser` checks that the configured
  model discovers the command from the short prompt, loads the skill, continues
  the action loop, and records only the outer `bash` tool.
