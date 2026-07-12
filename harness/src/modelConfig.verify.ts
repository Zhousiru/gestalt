import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createEmbeddingClientFromConfig,
  createLanguageModelFromConfig,
  resolveEmbeddingModelConfig,
  resolveMainModelConfig,
  resolveSubModelConfig,
  type GestaltConfig
} from "@gestalt/app";

const roleConfig = createConfig({
  main_model_provider: "openrouter",
  main_model_base_url: "https://models.example.test/v1/",
  main_model_name: "fixture/main",
  main_model_api_key_env: "FIXTURE_MAIN_API_KEY",
  main_model_temperature: 0.8,
  main_model_max_steps: 42,
  main_model_routing_order: "first, second",
  main_model_routing_allow_fallbacks: false,
  main_model_thinking: "disabled",
  main_model_tool_choice: "auto",
  main_model_prompt_cache_enabled: false,
  main_model_prompt_cache_ttl: "1h",
  sub_model_name: "fixture/sub",
  sub_model_temperature: 0.2,
  embedding_model_provider: "fixtureembedding",
  embedding_model_base_url: "https://embeddings.example.test/v1/",
  embedding_model_name: "fixture/embedding",
  embedding_model_id: "fixture-embedding-space",
  embedding_model_api_key_env: "FIXTURE_EMBEDDING_API_KEY",
  embedding_model_dimensions: 3,
  embedding_model_routing_order: "siliconflow",
  embedding_model_routing_allow_fallbacks: false,
  // A modern main field wins over the legacy migration fallback.
  model_name: "legacy/ignored"
});
const mainModel = resolveMainModelConfig(roleConfig);
const subModel = resolveSubModelConfig(roleConfig);
const embeddingModel = resolveEmbeddingModelConfig(roleConfig);

assert.deepEqual(
  selectLanguageConfig(mainModel),
  {
    role: "main",
    providerName: "openrouter",
    baseUrl: "https://models.example.test/v1",
    modelName: "fixture/main",
    apiKeyEnv: "FIXTURE_MAIN_API_KEY",
    temperature: 0.8,
    maxSteps: 42,
    toolChoice: "auto",
    promptCacheEnabled: false,
    promptCacheTtl: "1h"
  }
);
assert.deepEqual(mainModel.providerOptions, {
  openrouter: {
    provider: {
      order: ["first", "second"],
      allow_fallbacks: false
    },
    thinking: { type: "disabled" }
  }
});

assert.equal(subModel.role, "sub");
assert.equal(subModel.modelName, "fixture/sub");
assert.equal(subModel.temperature, 0.2);
assert.equal(subModel.providerName, mainModel.providerName);
assert.equal(subModel.baseUrl, mainModel.baseUrl);
assert.equal(subModel.apiKeyEnv, mainModel.apiKeyEnv);
assert.equal(subModel.maxSteps, mainModel.maxSteps);
assert.equal(subModel.toolChoice, mainModel.toolChoice);
assert.equal(subModel.promptCacheEnabled, mainModel.promptCacheEnabled);
assert.equal(subModel.promptCacheTtl, mainModel.promptCacheTtl);
assert.deepEqual(subModel.providerOptions, mainModel.providerOptions);

const inheritedSub = resolveSubModelConfig(
  createConfig({
    main_model_base_url: "https://models.example.test/v1",
    main_model_name: "fixture/main"
  })
);
assert.equal(inheritedSub.modelName, "fixture/main");
assert.equal(inheritedSub.providerName, "openai-compatible");
assert.equal(inheritedSub.apiKeyEnv, "MODEL_API_KEY");
assert.equal(inheritedSub.temperature, 1);

const legacyMain = resolveMainModelConfig(
  createConfig({
    model_provider: "legacy-provider",
    model_base_url: "https://legacy.example.test/v1",
    model_name: "legacy/main",
    model_temperature: 0.5
  })
);
assert.equal(legacyMain.modelName, "legacy/main");
assert.equal(legacyMain.temperature, 0.5);

assert.deepEqual(embeddingModel, {
  id: "fixture-embedding-space",
  providerName: "fixtureembedding",
  baseUrl: "https://embeddings.example.test/v1",
  modelName: "fixture/embedding",
  apiKeyEnv: "FIXTURE_EMBEDDING_API_KEY",
  dimensions: 3,
  routing: {
    order: ["siliconflow"],
    allow_fallbacks: false
  }
});
assert.throws(
  () =>
    resolveEmbeddingModelConfig(
      createConfig({
        embedding_model_base_url: "https://embeddings.example.test/v1",
        embedding_model_name: "fixture/embedding"
      })
    ),
  /embedding_model_id/
);
assert.throws(
  () =>
    resolveEmbeddingModelConfig(
      createConfig({
        embedding_model_id: "fixture-embedding-space",
        main_model_base_url: "https://models.example.test/v1",
        main_model_name: "fixture/main"
      })
    ),
  /embedding_model_base_url/
);
assert.throws(
  () =>
    resolveEmbeddingModelConfig(
      createConfig({
        embedding_model_id: "fixture-embedding-space",
        embedding_model_base_url: "https://embeddings.example.test/v1",
        embedding_model_name: "fixture/embedding",
        embedding_model_dimensions: 0
      })
    ),
  /embedding_model_dimensions must be a positive integer/
);

const embeddingRequests: unknown[] = [];
const previousMainKey = process.env.FIXTURE_MAIN_API_KEY;
const previousEmbeddingKey = process.env.FIXTURE_EMBEDDING_API_KEY;
process.env.FIXTURE_MAIN_API_KEY = "fixture-main-key";
process.env.FIXTURE_EMBEDDING_API_KEY = "fixture-embedding-key";

try {
  const subLanguageModel = createLanguageModelFromConfig(roleConfig, {
    role: "sub"
  });
  assert.equal(subLanguageModel.role, "sub");
  assert.equal(subLanguageModel.modelName, "fixture/sub");
  assert.equal(subLanguageModel.apiKeyEnv, "FIXTURE_MAIN_API_KEY");

  const embeddingClient = createEmbeddingClientFromConfig(roleConfig, {
    maxRetries: 0,
    fetch: createEmbeddingFetch(embeddingRequests, [0.1, 0.2, 0.3])
  });
  assert.deepEqual(await embeddingClient.embed("表情检索"), [0.1, 0.2, 0.3]);
  assert.deepEqual(embeddingRequests, [
    {
      model: "fixture/embedding",
      input: ["表情检索"],
      encoding_format: "float",
      dimensions: 3,
      provider: {
        order: ["siliconflow"],
        allow_fallbacks: false
      }
    }
  ]);

  const wrongDimensionsClient = createEmbeddingClientFromConfig(
    createConfig({
      embedding_model_provider: "fixtureembedding",
      embedding_model_base_url: "https://embeddings.example.test/v1",
      embedding_model_name: "fixture/embedding",
      embedding_model_id: "fixture-embedding-space",
      embedding_model_api_key_env: "FIXTURE_EMBEDDING_API_KEY",
      embedding_model_dimensions: 4
    }),
    {
      maxRetries: 0,
      fetch: createEmbeddingFetch([], [0.1, 0.2, 0.3])
    }
  );
  await assert.rejects(
    () => wrongDimensionsClient.embed("dimension check"),
    /returned 3 dimensions; expected 4/
  );
} finally {
  restoreEnvironmentVariable("FIXTURE_MAIN_API_KEY", previousMainKey);
  restoreEnvironmentVariable(
    "FIXTURE_EMBEDDING_API_KEY",
    previousEmbeddingKey
  );
}

const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactDir = path.join(repoRoot, "harness", "artifacts", "model-config");
await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });
const artifact = {
  main: selectLanguageConfig(mainModel),
  sub: selectLanguageConfig(subModel),
  embedding: embeddingModel,
  embeddingRequest: embeddingRequests[0],
  legacyMain: selectLanguageConfig(legacyMain)
};
await writeFile(
  path.join(artifactDir, "resolved-model-config.json"),
  `${JSON.stringify(artifact, null, 2)}\n`,
  "utf8"
);
await writeFile(
  path.join(artifactDir, "report.md"),
  [
    "# Runtime Model Config Verification",
    "",
    `- Main: ${mainModel.providerName}/${mainModel.modelName}`,
    `- Sub: ${subModel.providerName}/${subModel.modelName}`,
    `- Embedding: ${embeddingModel.providerName}/${embeddingModel.modelName}`,
    `- Dimensions: ${embeddingModel.dimensions}`,
    "- Sub inheritance: verified field-by-field",
    "- Legacy main fallback: verified",
    "- Embedding independence and dimension validation: verified",
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

function selectLanguageConfig(
  config: ReturnType<typeof resolveMainModelConfig>
): Record<string, unknown> {
  return {
    role: config.role,
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    modelName: config.modelName,
    apiKeyEnv: config.apiKeyEnv,
    ...(config.temperature !== undefined
      ? { temperature: config.temperature }
      : {}),
    maxSteps: config.maxSteps,
    ...(config.toolChoice ? { toolChoice: config.toolChoice } : {}),
    promptCacheEnabled: config.promptCacheEnabled,
    ...(config.promptCacheTtl
      ? { promptCacheTtl: config.promptCacheTtl }
      : {})
  };
}

function createEmbeddingFetch(
  requests: unknown[],
  vector: number[]
): typeof fetch {
  return async (_input, init) => {
    requests.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response(
      JSON.stringify({
        data: [{ embedding: vector }],
        usage: { prompt_tokens: 2 }
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" }
      }
    );
  };
}

function restoreEnvironmentVariable(
  name: string,
  previousValue: string | undefined
): void {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}
