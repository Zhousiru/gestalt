import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeArtifactJson } from "./artifactBinary";

const artifactDir = await mkdtemp(
  path.join(os.tmpdir(), "gestalt-harness-binary-")
);
try {
  const bytes = Buffer.alloc(123_652, 0x5a);
  const shared = { label: "shared sibling" };
  const circular: { label: string; self?: unknown } = { label: "cycle" };
  circular.self = circular;
  const filePath = path.join(artifactDir, "model-exchanges.json");
  await writeArtifactJson(
    filePath,
    {
      buffer: bytes,
      typed: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      arrayBuffer: bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ),
      sharedTwice: [shared, shared],
      circular,
      nested: {
        dataUri: `data:image/png;base64,${bytes.toString("base64")}`,
        providerMedia: {
          type: "image",
          mediaType: "image/png",
          data: bytes.toString("base64")
        },
        alternateProviderMedia: {
          type: "image",
          mediaType: "image/png",
          image: bytes.toString("base64")
        },
        serializedProviderPart: JSON.stringify({
          type: "file",
          data: bytes.toJSON(),
          mediaType: "image/png"
        })
      }
    }
  );
  const serialized = await readFile(filePath, "utf8");
  const parsed = JSON.parse(serialized) as {
    sharedTwice: Array<{ label: string } | string>;
    circular: { label: string; self: unknown };
  };
  assert.deepEqual(parsed.sharedTwice, [shared, shared]);
  assert.deepEqual(parsed.circular, { label: "cycle", self: "[Circular]" });
  assert.equal(serialized.includes(bytes.toString("base64").slice(0, 64)), false);
  assert.equal(serialized.includes('"0":90'), false);
  assert.equal(serialized.includes('"data":[90,90'), false);

  await writeArtifactJson(path.join(artifactDir, "tool-results.json"), {
    duplicate: bytes.toJSON()
  });
  const blobs = await readdir(path.join(artifactDir, "blobs"));
  assert.equal(blobs.length, 1);
  assert.equal((await stat(path.join(artifactDir, "blobs", blobs[0]!))).size, 123_652);
} finally {
  await rm(artifactDir, { recursive: true, force: true });
}
