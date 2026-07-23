# AGENTS.md

This file is the short entry point for coding agents working on Gestalt. Keep it concise; durable architecture and product decisions belong in `docs/`.

## Start Here

- Read [docs/MASTERDOC.md](docs/MASTERDOC.md) before architectural or behavioral changes.
- Use [docs/GROUP_CHAT_AGENT_LOOP.md](docs/GROUP_CHAT_AGENT_LOOP.md) for group-session lifecycle, triggering, timed steering, and exit behavior.
- Use [docs/MEMORY_MODEL.md](docs/MEMORY_MODEL.md) for file-based memory and dreaming.
- Use [docs/ONEBOT_CONNECTOR.md](docs/ONEBOT_CONNECTOR.md) for canonical events and OneBot protocol boundaries.
- Use [docs/STICKER_SYSTEM.md](docs/STICKER_SYSTEM.md) for sticker collection, analysis, retrieval, sending, and observability.
- Use [docs/AGENT_BROWSER.md](docs/AGENT_BROWSER.md) for phase-scoped bash, browser CLI, tracing, and Docker packaging.
- Follow [docs/HARNESS_WORKFLOW.md](docs/HARNESS_WORKFLOW.md) whenever runtime behavior changes.

## Verification

For every meaningful runtime change:

1. Add or update a durable harness fixture.
2. Run the narrowest relevant `verify:*` command.
3. Read the exported session, trace, model request/exchange, tool, and home snapshot artifacts yourself.
4. Run an `eval:*` scenario for qualitative, prompt-sensitive, or social behavior, preferably against the configured real model.
5. Run `pnpm run typecheck`; run `pnpm run build` when runtime code changes.

A green command alone is not evidence that behavior is correct. Assertions and human inspection must prove the intended input, output, state transition, and side effects from exported artifacts.

## Documentation

Update the relevant document when a product principle or architecture decision changes. If a behavior matters enough to discuss, debug, or preserve, turn it into a fixture, eval, tool contract, trace assertion, or focused document.
