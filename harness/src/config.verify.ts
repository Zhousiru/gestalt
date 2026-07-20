import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  loadConfig,
  resolveGestaltHome,
  resolveSubModelConfig,
  type GestaltConfig
} from "@gestalt/app";
import { writeArtifactJson } from "./artifactBinary";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtureHome = await resolveGestaltHome({
  homePath: path.join(
    repoRoot,
    "harness",
    "fixtures",
    "homes",
    "config-validation"
  ),
  create: false
});
const config = await loadConfig(fixtureHome);
const subModel = resolveSubModelConfig(config);

assert.deepEqual(config.flatValues.allowedgroups, ["10001", "10002"]);
assert.equal(config.flatValues.bot_display_name, '露米 "Lumi"');
assert.equal(config.flatValues.sub_model_routing_order, "");
assert.deepEqual(subModel.providerOptions, {
  openrouter: {
    provider: {
      allow_fallbacks: true
    },
    thinking: {
      type: "disabled"
    }
  }
});

assert.throws(
  () =>
    resolveSubModelConfig(
      createConfig({
        main_model_base_url: "https://models.example.test/v1",
        main_model_name: "fixture/main",
        sub_model_routing_allow_fallbacks: "false"
      })
    ),
  /sub_model_routing_allow_fallbacks must be a boolean/
);

const invalidCases = {
  legacyModelKeys: await loadInvalidConfig(
    await readFile(
      path.join(
        repoRoot,
        "harness",
        "fixtures",
        "configs",
        "legacy-runtime-model-keys.toml"
      ),
      "utf8"
    ),
    /unknown keys?:.*model_/
  ),
  unknownKey: await loadInvalidConfig(
    'main_model_naem = "typo"\n',
    /unknown key: main_model_naem/
  ),
  wrongType: await loadInvalidConfig(
    'main_model_routing_allow_fallbacks = "false"\n',
    /main_model_routing_allow_fallbacks/
  ),
  malformedToml: await loadInvalidConfig(
    'main_model_name = "unterminated\n',
    /Invalid TOML/
  ),
  tableSyntax: await loadInvalidConfig(
    "[main_model]\nname = \"nested\"\n",
    /unknown key: main_model/
  ),
  conflictingEmbeddingApiKeys: await loadInvalidConfig(
    [
      'embedding_model_api_key = "inline-key"',
      'embedding_model_api_key_env = "EMBEDDING_MODEL_API_KEY"',
      ""
    ].join("\n"),
    /cannot be used together/
  ),
  conflictingMainApiKeys: await loadInvalidConfig(
    [
      'main_model_api_key = "inline-key"',
      'main_model_api_key_env = "MAIN_MODEL_API_KEY"',
      ""
    ].join("\n"),
    /cannot be used together/
  ),
  invalidAggregationRange: await loadInvalidConfig(
    [
      "agent_loop_aggregation_delay_ms = 5000",
      "agent_loop_aggregation_max_delay_ms = 1000",
      ""
    ].join("\n"),
    /must be greater than or equal/
  )
};

const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "config-validation"
);
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
await writeArtifactJson(path.join(artifactDir, "resolved-config.json"), {
  configPath: config.path,
  flatValues: config.flatValues,
  resolvedSubModel: {
    modelName: subModel.modelName,
    providerOptions: subModel.providerOptions
  },
  rejected: invalidCases
});
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# Gestalt Config Verification",
    "",
    "- TOML multiline arrays, escapes, and inline comments: verified",
    "- Unknown keys and invalid value types: rejected",
    "- Legacy runtime model_* keys: rejected",
    "- Nested TOML tables: rejected by the flat config schema",
    "- Invalid aggregation delay ranges: rejected",
    "- Direct and environment API keys are mutually exclusive for every model role",
    "- Empty sub routing order clears inheritance: verified",
    ""
  ].join("\n"),
  "utf8"
);

console.log(JSON.stringify({ ok: true, artifactDir }, null, 2));

function createConfig(
  flatValues: GestaltConfig["flatValues"]
): GestaltConfig {
  return {
    path: "fixture/config.toml",
    raw: "",
    flatValues
  };
}

async function loadInvalidConfig(
  raw: string,
  expected: RegExp
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "gestalt-config-invalid-"));
  try {
    await writeFile(path.join(root, "config.toml"), raw, "utf8");
    const home = await resolveGestaltHome({ homePath: root, create: false });
    let message = "";
    await assert.rejects(
      async () => {
        await loadConfig(home);
      },
      (error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
        return expected.test(message);
      }
    );
    return message;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
