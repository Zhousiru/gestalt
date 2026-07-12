import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { writeArtifactJson } from "./artifactBinary";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const appRoot = path.join(repoRoot, "packages", "app");
const fixturePath = path.join(
  repoRoot,
  "harness",
  "fixtures",
  "homes",
  "live-ui-build",
  "config.toml"
);
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "live-ui-build"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-build-smoke-"));
const port = await findAvailablePort();
const fixtureConfig = await readFile(fixturePath, "utf8");
await writeFile(
  path.join(tempHome, "config.toml"),
  fixtureConfig
    .replace("live_enabled = false", "live_enabled = true")
    .replace("live_port = 3000", `live_port = ${port}`),
  "utf8"
);

const child = spawn(
  process.execPath,
  [path.join(appRoot, "dist", "main.js"), "--home", tempHome],
  {
    cwd: appRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  }
);
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk: string) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk: string) => {
  stderr += chunk;
});

try {
  const origin = `http://127.0.0.1:${port}`;
  const health = await fetchWhenReady(`${origin}/api/live/health`, child);
  assert.equal(health.status, 200);
  assert.equal((await health.json() as { ok?: unknown }).ok, true);

  const page = await fetch(`${origin}/`);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(html, /<div id="root"><\/div>/);

  const assetPath = html.match(/(?:src|href)="(\/assets\/[^"]+)"/)?.[1];
  assert.ok(assetPath, "Built Live UI index must reference an asset.");
  const asset = await fetch(`${origin}${assetPath}`);
  assert.equal(asset.status, 200);
  const assetText = await asset.text();
  assert.match(assetText, /Stickers/);
  assert.match(assetText, /Sticker subsystem unavailable/);
  assert.match(assetText, /Previous sticker page/);
  assert.match(assetText, /Close sticker details/);

  const stickerSnapshotResponse = await fetch(
    `${origin}/api/live/stickers/snapshot`
  );
  assert.equal(stickerSnapshotResponse.status, 200);
  const stickerSnapshot = (await stickerSnapshotResponse.json()) as {
    available?: unknown;
    unavailableReason?: unknown;
    processing?: { ready?: unknown };
    catalog?: { offset?: unknown; limit?: unknown; total?: unknown };
    jobs?: unknown[];
    stickers?: unknown[];
  };
  assert.equal(stickerSnapshot.available, false);
  assert.equal(typeof stickerSnapshot.unavailableReason, "string");
  assert.equal(stickerSnapshot.processing?.ready, 0);
  assert.deepEqual(stickerSnapshot.catalog, {
    offset: 0,
    limit: 48,
    total: 0
  });
  assert.deepEqual(stickerSnapshot.jobs, []);
  assert.deepEqual(stickerSnapshot.stickers, []);

  const artifact = {
    ok: true,
    appEntry: path.join(appRoot, "dist", "main.js"),
    uiIndex: path.join(appRoot, "dist", "live-ui", "index.html"),
    liveUrl: origin,
    apiAndUiSharePort: true,
    healthStatus: health.status,
    pageStatus: page.status,
    uiAsset: assetPath,
    assetStatus: asset.status,
    stickerPageBundled: true,
    stickerSnapshotStatus: stickerSnapshotResponse.status
  };
  await rm(artifactDir, { recursive: true, force: true });
  await mkdir(artifactDir, { recursive: true });
  await writeArtifactJson(path.join(artifactDir, "result.json"), artifact);

  process.stdout.write(stdout);
  console.log(JSON.stringify({ ...artifact, artifactDir }, null, 2));
} finally {
  if (child.exitCode === null) {
    child.kill();
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }
  await rm(tempHome, { recursive: true, force: true });
}

if (stderr) {
  process.stderr.write(stderr);
}

async function findAvailablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function fetchWhenReady(
  url: string,
  processHandle: Pick<ChildProcess, "exitCode">
): Promise<Response> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(
        `Built app exited before Live UI became ready with status ${processHandle.exitCode}.`
      );
    }
    try {
      return await fetch(url);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${url}.`);
}
