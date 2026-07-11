import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadEvalModelConfig,
  parseEvalCliArguments
} from "./evalModelConfig";

assert.deepEqual(parseEvalCliArguments([]), { fixturePaths: [] });
assert.deepEqual(
  parseEvalCliArguments([
    "scenario.json",
    "--eval-config",
    "harness/config/custom.toml"
  ]),
  {
    fixturePaths: ["scenario.json"],
    evalConfigPath: "harness/config/custom.toml"
  }
);
assert.deepEqual(parseEvalCliArguments(["--eval-config=custom.toml"]), {
  fixturePaths: [],
  evalConfigPath: "custom.toml"
});
assert.throws(
  () => parseEvalCliArguments(["--eval-config"]),
  /requires a file path/
);
assert.throws(
  () => parseEvalCliArguments(["--unknown"]),
  /Unknown eval option/
);

const tempDir = await mkdtemp(path.join(os.tmpdir(), "gestalt-eval-config-"));
const configPath = path.join(tempDir, "eval.toml");
process.env.TEST_EVAL_API_KEY = "test-key";

try {
  await writeFile(
    configPath,
    [
      'model_provider = "test-provider"',
      'model_base_url = "https://example.test/v1"',
      'model_name = "test/eval-model"',
      'model_api_key_env = "TEST_EVAL_API_KEY"',
      'model_thinking = "disabled"',
      "temperature = 0.2",
      "timeout_ms = 12345"
    ].join("\n"),
    "utf8"
  );

  const config = await loadEvalModelConfig(configPath);
  assert.equal(config.modelName, "test/eval-model");
  assert.equal(config.temperature, 0.2);
  assert.equal(config.timeoutMs, 12345);
  assert.equal(config.thinking, "disabled");
  assert.equal(config.configPath, configPath);
  assert.match(config.configVersion, /^[a-f0-9]{16}$/);
} finally {
  delete process.env.TEST_EVAL_API_KEY;
  await rm(tempDir, { recursive: true, force: true });
}

console.log(JSON.stringify({ ok: true }, null, 2));
