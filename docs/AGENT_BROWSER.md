# Agent Browser Integration

## Decision

Gestalt exposes browser automation through the existing `bash` model tool. It
does not add a second provider-facing browser tool protocol.

The action prompt contains one discovery line:

```text
In chat, agent-browser is available through bash; before first use run: agent-browser skills get core.
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
native agent-browser CLI with `shell: false`. Gestalt does not filter commands,
add CLI flags, select a browser session, or inject `AGENT_BROWSER_*`
environment variables. just-bash exposes all of its registered commands; it
does not expose an unrestricted host shell.

The active-loop abort signal is forwarded through just-bash and terminates the
current native CLI process. The browser service that agent-browser manages
keeps its own normal lifecycle.

## Trace Contract

The model and rollout see one `bash` tool call and one `bash` tool result.
agent-browser commands are implementation details inside that call and do not
create nested Gestalt tools, spans, or Trace UI step types. stdout, stderr, and
exit code are returned as the bash result.

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
  command plus exact argv/stdin forwarding.
- `pnpm --filter @gestalt/harness run verify:browser` checks that the configured
  model discovers the command from the short prompt, loads the skill, continues
  the action loop, and records only the outer `bash` tool.
