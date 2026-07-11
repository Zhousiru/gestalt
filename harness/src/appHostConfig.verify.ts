import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import {
  loadConfig,
  resolveAppHostConfig,
  resolveGestaltHome,
  type GestaltConfig
} from "@gestalt/app";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtureHome = await resolveGestaltHome({
  homePath: path.join(
    repoRoot,
    "harness",
    "fixtures",
    "homes",
    "app-host-config"
  ),
  create: false
});
const config = await loadConfig(fixtureHome);
const resolved = resolveAppHostConfig(config, {
  GESTALT_TEST_ONEBOT_TOKEN: "fixture-secret"
});

assert.equal(resolved.connector, "onebot-forward-ws");
assert.equal(resolved.onebot.wsUrl, "ws://127.0.0.1:3001");
assert.equal(resolved.onebot.accessToken, "fixture-secret");
assert.equal(
  resolved.onebot.accessTokenEnv,
  "GESTALT_TEST_ONEBOT_TOKEN"
);
assert.deepEqual(resolved.live, {
  enabled: true,
  host: "0.0.0.0",
  port: 6175
});
const defaultLiveConfig = resolveAppHostConfig(createConfig({})).live;
assert.deepEqual(defaultLiveConfig, {
  enabled: false,
  host: "127.0.0.1",
  port: 3000
});

assert.throws(
  () =>
    resolveAppHostConfig(
      createConfig({ connector: "onebot-forward-ws" }),
      {}
    ),
  /onebot_ws_url is required/
);
assert.throws(
  () =>
    resolveAppHostConfig(
      createConfig({
        connector: "onebot-reverse-ws",
        onebot_port: 0
      }),
      {}
    ),
  /onebot_port must be a positive integer/
);
assert.throws(
  () =>
    resolveAppHostConfig(
      createConfig({
        connector: "onebot-forward-ws",
        onebot_ws_url: "ws://127.0.0.1:3001",
        onebot_access_token_env: "MISSING_ONEBOT_TOKEN"
      }),
      {}
    ),
  /MISSING_ONEBOT_TOKEN.*is not set/
);

const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "app-host-config"
);
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const artifact = {
  configPath: config.path,
  connector: resolved.connector,
  onebot: {
    wsUrl: resolved.onebot.wsUrl,
    accessTokenEnv: resolved.onebot.accessTokenEnv,
    accessTokenConfigured: resolved.onebot.accessToken !== undefined
  },
  live: resolved.live,
  defaults: {
    live: defaultLiveConfig
  }
};
await writeFile(
  path.join(artifactDir, "resolved-host-config.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8"
);
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# App Host Config Verification",
    "",
    `- Connector: ${artifact.connector}`,
    `- OneBot URL: ${artifact.onebot.wsUrl}`,
    `- Token source: ${artifact.onebot.accessTokenEnv}`,
    `- Token configured: ${artifact.onebot.accessTokenConfigured}`,
    `- Live endpoint: http://${artifact.live.host}:${artifact.live.port}`,
    `- Default Live enabled: ${artifact.defaults.live.enabled}`,
    `- Default Live port: ${artifact.defaults.live.port}`,
    ""
  ].join("\n"),
  "utf8"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      artifactDir
    },
    null,
    2
  )
);

function createConfig(
  flatValues: GestaltConfig["flatValues"]
): GestaltConfig {
  return {
    path: "fixture/config.toml",
    raw: "",
    flatValues
  };
}
