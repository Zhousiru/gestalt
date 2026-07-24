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
--config <packaged-config> --namespace gestalt --session gestalt-<active-loop-id> --provider fortress
```

Any `--config`, `--namespace`, `--session`, or `--provider` supplied by the
model is removed before these runtime-owned values are added. Gestalt does not
inject `AGENT_BROWSER_*` environment variables or otherwise filter
agent-browser commands. just-bash exposes all of its registered commands; it
does not expose an unrestricted host shell.

## Fortress Provider

The packaged `fortress` plugin implements agent-browser's
`agent-browser.plugin.v1` `browser.provider` capability:

1. `browser.launch` starts one Tilion Fortress process for the active-loop
   session with a private profile and random loopback-only CDP port.
2. The plugin waits for `/json/version` and returns the CDP WebSocket URL plus
   an opaque cleanup token.
3. agent-browser owns navigation and browser automation over that CDP
   connection.
4. After CDP is ready, the plugin resolves and persists the real browser PID
   rather than assuming the initial launcher PID remains the browser process.
5. `browser.close` sends CDP `Browser.close`, terminates the persisted browser
   process as a fallback, and removes its temporary profile. Profile deletion
   retries transient Windows database locks while retaining cleanup state until
   the profile is gone. Cleanup is idempotent.

Fortress's CDP endpoint is never exposed as a container port. The plugin does
not forward agent-browser user-agent overrides into Fortress, so the engine's
coherent built-in persona remains intact.

The active-loop abort signal is forwarded through just-bash and terminates the
current native CLI process. If agent-browser was invoked, the tool scope runs
`agent-browser --provider fortress --namespace gestalt --session
gestalt-<active-loop-id> close` when the active loop settles. That close flows
through the provider's cleanup callback. Loops that never invoke agent-browser
do not start a cleanup process. Cleanup is idempotent, has a bounded timeout,
and cannot change an already completed loop result. Each browser-using loop
therefore owns and reclaims exactly one Fortress process and browser session.

## Trace Contract

The model and rollout see one `bash` tool call and one `bash` tool result.
agent-browser commands are implementation details inside that call and do not
create nested Gestalt tools, spans, or Trace UI step types. stdout, stderr, and
exit code are returned as the bash result. Runtime-owned session cleanup is a
host lifecycle action and is not recorded as a model tool step.

## Packaging

`agent-browser` remains a pinned application dependency. The image downloads
the Fortress `149.0.7827.232` stable Linux x64 bundle from its release, verifies
the pinned SHA-256 before extraction, and normalizes the release bundle's
`tillion` launcher name to the stable packaged path `/opt/fortress/tilion`.
It retains the license and third-party notice and installs the exact Debian
runtime libraries used by the upstream Fortress image.

The final image:

- supports `linux/amd64` explicitly because the pinned stable Fortress bundle
  is x64-only;
- contains the compiled provider plugin and packaged agent-browser config;
- runs both Gestalt and Fortress as the unprivileged `node` user;
- exposes only Gestalt port 3000, never CDP;
- uses `tini` as PID 1 so detached browser children are reaped;
- stores browser profiles under temporary per-run directories, not
  `GestaltHome`.

## Verification

- `pnpm --filter @gestalt/app run verify:bash` checks the real core-skill
  command, exact argv/stdin forwarding, runtime-owned
  config/namespace/session/provider override, Fortress plugin manifest,
  process/CDP readiness, scoped cleanup, cancellation, and per-loop VFS
  isolation.
- `pnpm --filter @gestalt/harness run verify:browser` checks that the configured
  model discovers the command from the short prompt, loads the skill, continues
  the action loop, and records only the outer `bash` tool.
- `pnpm run verify:browser-live` is an explicit network-dependent smoke test
  for a real Fortress executable. It first traverses the production path
  `just-bash -> agent-browser -> fortress browser.provider`, then uses that
  same browser's loopback CDP endpoint to open Google and Bing search results
  plus Sannysoft, BrowserScan, and the official CreepJS deployment. It
  hard-checks navigation, rendered page execution,
  `navigator.webdriver === false`, a non-headless user agent, plugins,
  languages, and complete provider cleanup. Search challenges and third-party
  detector verdicts are recorded as diagnostics because they also depend on IP
  reputation, geography, and changing remote code.

Set `FORTRESS_EXECUTABLE` to an extracted Fortress launcher when it is not at
the packaged Linux path `/opt/fortress/tilion`:

```bash
FORTRESS_EXECUTABLE=/path/to/fortress/tilion pnpm run verify:browser-live
```

For the official Windows archive, point it at the extracted `chrome.exe`
rather than the `tilion.cmd` convenience wrapper.

The report is written to
`harness/artifacts/fortress-browser-live/summary.json`. Set
`FORTRESS_LIVE_STRICT=1` to additionally require real result rows from both
search engines and zero Sannysoft failed rows. The live check is deliberately
not part of `verify:bash`: remote pages and egress reputation must not make the
deterministic offline suite flaky.
