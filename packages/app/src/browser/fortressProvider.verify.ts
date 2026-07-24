import assert from "node:assert/strict";
import {
  access,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  handleFortressPluginRequest,
  parseFortressProviderOptions
} from "./fortressProvider";

const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "gestalt-fortress-provider-")
);
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.."
);

try {
  const fakeBrowserPath = path.join(temporaryRoot, "fake-browser.mjs");
  await writeFile(
    fakeBrowserPath,
    [
      'import http from "node:http";',
      "const portArg = process.argv.find((arg) => arg.startsWith('--remote-debugging-port='));",
      "const port = Number(portArg?.split('=')[1]);",
      "if (!Number.isSafeInteger(port)) process.exit(2);",
      "const server = http.createServer((request, response) => {",
      "  if (request.url !== '/json/version') { response.writeHead(404).end(); return; }",
      "  response.setHeader('content-type', 'application/json');",
      "  response.end(JSON.stringify({webSocketDebuggerUrl:`ws://127.0.0.1:${port}/devtools/browser/fake`}));",
      "});",
      "server.listen(port, '127.0.0.1');",
      "const close = () => server.close(() => process.exit(0));",
      "process.on('SIGTERM', close);",
      "process.on('SIGINT', close);",
      "setInterval(() => undefined, 1000);"
    ].join("\n"),
    "utf8"
  );

  const stateRoot = path.join(temporaryRoot, "state");
  const options = parseFortressProviderOptions([
    "--executable",
    process.execPath,
    `--executable-arg=${fakeBrowserPath}`,
    "--state-root",
    stateRoot,
    "--launch-timeout-ms",
    "5000",
    "--close-timeout-ms",
    "2000"
  ]);

  const manifest = await handleFortressPluginRequest(
    {
      protocol: "agent-browser.plugin.v1",
      type: "plugin.manifest",
      capability: "plugin.manifest",
      request: {}
    },
    options
  );
  assert.equal(manifest.success, true);
  assert.equal(manifest.manifest?.name, "fortress");
  assert.deepEqual(manifest.manifest?.capabilities, [
    "browser.provider"
  ]);

  const launched = await handleFortressPluginRequest(
    {
      protocol: "agent-browser.plugin.v1",
      type: "browser.launch",
      capability: "browser.provider",
      request: {
        session: "gestalt-loop-test",
        launchOptions: {
          headed: false
        }
      }
    },
    options
  );
  assert.equal(launched.success, true);
  assert.match(
    launched.browser?.cdpUrl ?? "",
    /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/fake$/
  );
  assert.equal(launched.browser?.directPage, false);
  assert.equal(
    launched.browser?.metadata.session,
    "gestalt-loop-test"
  );
  const runId = launched.browser?.cleanup.runId;
  assert.ok(runId);
  const state = JSON.parse(
    await readFile(path.join(stateRoot, runId, "state.json"), "utf8")
  ) as {
    cdpUrl?: string;
  };
  assert.equal(state.cdpUrl, launched.browser?.cdpUrl);

  const closed = await handleFortressPluginRequest(
    {
      protocol: "agent-browser.plugin.v1",
      type: "browser.close",
      capability: "browser.provider",
      request: { runId }
    },
    options
  );
  assert.equal(closed.success, true);
  assert.equal(closed.data?.closed, true);
  await assert.rejects(
    access(path.join(stateRoot, runId, "state.json"))
  );

  const closedAgain = await handleFortressPluginRequest(
    {
      protocol: "agent-browser.plugin.v1",
      type: "browser.close",
      capability: "browser.provider",
      request: { runId }
    },
    options
  );
  assert.equal(closedAgain.success, true);
  assert.equal(closedAgain.data?.closed, false);

  const pluginConfig = JSON.parse(
    await readFile(
      path.join(
        projectRoot,
        "packages/app/config/agent-browser.json"
      ),
      "utf8"
    )
  ) as {
    plugins?: Array<{
      name?: string;
      capabilities?: string[];
      args?: string[];
    }>;
  };
  assert.equal(pluginConfig.plugins?.[0]?.name, "fortress");
  assert.deepEqual(pluginConfig.plugins?.[0]?.capabilities, [
    "browser.provider"
  ]);
  assert.ok(
    pluginConfig.plugins?.[0]?.args?.includes(
      "/opt/fortress/tilion"
    )
  );

  const dockerfile = await readFile(
    path.join(projectRoot, "Dockerfile"),
    "utf8"
  );
  assert.match(dockerfile, /FORTRESS_VERSION=149\.0\.7827\.232/);
  assert.match(
    dockerfile,
    /6553b8faf2a1274173f633f924d8131b5de20371cf2aa08a016da4b50a088a51/
  );
  assert.match(
    dockerfile,
    /COPY --from=fortress --chown=node:node \/opt\/fortress \/opt\/fortress/
  );
  assert.doesNotMatch(dockerfile, /EXPOSE 9222/);

  console.log(
    JSON.stringify(
      {
        ok: true,
        manifest: manifest.manifest,
        isolatedSession: "gestalt-loop-test",
        cdpReady: true,
        cdpPersistedForCleanup: true,
        cleanupReturned: true,
        cleanupIdempotent: true,
        pinnedDockerBundle: "149.0.7827.232",
        cdpExposed: false
      },
      null,
      2
    )
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
