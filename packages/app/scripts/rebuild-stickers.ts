import path from "node:path";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { z } from "zod";
import { loadConfig } from "../src/home/loadConfig";
import { resolveGestaltHome } from "../src/home/resolveGestaltHome";
import { createAiStickerAnalyzer, createAiStickerEmbedder } from "../src/stickers/ai";
import { prepareStickerMedia } from "../src/stickers/contactSheet";
import {
  createStickerVectorIndex,
  stickerVectorIndexId
} from "../src/stickers/lance";
import { embedAndIndex } from "../src/stickers/processor";
import {
  StickerAssetSchema,
  StickerMfaceDeliverySchema,
  StickerRecordSchema,
  type StickerRecord
} from "../src/stickers/schemas";

const LegacyStickerRecordSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
    status: z.enum(["processing", "ready", "failed"]),
    asset: StickerAssetSchema,
    mface: StickerMfaceDeliverySchema.optional(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1)
  })
  .passthrough();

interface Arguments {
  home?: string;
  concurrency: number;
  only?: string;
  dryRun: boolean;
  help: boolean;
}

const args = readArguments(process.argv.slice(2));
if (args.help) {
  process.stdout.write(`Usage: pnpm --filter @gestalt/app rebuild:stickers -- [options]\n\nOptions:\n  --home <path>         GestaltHome to rebuild (defaults to configured home)\n  --only <sticker_id>   Rebuild one sticker only\n  --concurrency <1-16>  Parallel analysis jobs (default: 2)\n  --dry-run             List rebuild candidates without changing records\n  --help                Show this help\n`);
  process.exit(0);
}
const home = await resolveGestaltHome({
  ...(args.home ? { homePath: args.home } : {}),
  create: false
});
const reportPath = path.join(home.stickersDir, "rebuild-structured.jsonl");
const names = (await readdir(home.stickerRecordsDir))
  .filter((name) => name.endsWith(".json"))
  .filter((name) => !args.only || name === `${args.only}.json`)
  .sort();

let nextIndex = 0;
let succeeded = 0;
let skipped = 0;
let failed = 0;

if (args.dryRun) {
  for (const name of names) {
    try {
      const raw = JSON.parse(
        await readFile(path.join(home.stickerRecordsDir, name), "utf8")
      );
      const legacy = LegacyStickerRecordSchema.parse(raw);
      skipped += 1;
      await report({
        stickerId: legacy.id,
        status: "candidate",
        asset: legacy.asset.relativePath,
        reason: "dry_run"
      });
    } catch (error) {
      failed += 1;
      await report({
        file: name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
  process.stdout.write(
    `${JSON.stringify({ records: names.length, candidates: skipped, failed, reportPath, dryRun: true }, null, 2)}\n`
  );
  process.exit(failed > 0 ? 1 : 0);
}

const config = await loadConfig(home);
const analyzer = createAiStickerAnalyzer(config);
const embedder = createAiStickerEmbedder(config);
const vectorIndex = await createStickerVectorIndex({
  directory: home.stickerLanceDbDir,
  embeddingId: embedder.id
});
const workers = Array.from(
  { length: Math.min(args.concurrency, names.length) },
  async () => {
    while (nextIndex < names.length) {
      const index = nextIndex++;
      const name = names[index];
      if (!name) continue;
      const filePath = path.join(home.stickerRecordsDir, name);
      try {
        const raw = JSON.parse(await readFile(filePath, "utf8"));
        const current = StickerRecordSchema.safeParse(raw);
        if (
          current.success &&
          current.data.status === "ready" &&
          current.data.description &&
          current.data.embedding?.id === stickerVectorIndexId(embedder.id)
        ) {
          skipped += 1;
          await report({ stickerId: current.data.id, status: "skipped", reason: "already_current" });
          continue;
        }
        const legacy = LegacyStickerRecordSchema.parse(raw);
        const mediaPath = resolveWithinHome(home.root, legacy.asset.relativePath);
        const bytes = await readFile(mediaPath);
        const prepared = await prepareStickerMedia(bytes);
        const analyzed = await analyzer.describe({
          image: prepared.analysisImage,
          mime: prepared.contactSheet ? "image/png" : prepared.mime,
          animated: prepared.animated,
          frameCount: prepared.frameCount,
          ...(legacy.mface?.summary ? { platformSummary: legacy.mface.summary } : {})
        });
        const at = new Date().toISOString();
        const base: StickerRecord = StickerRecordSchema.parse({
          id: legacy.id,
          status: "processing",
          description: analyzed.description,
          asset: legacy.asset,
          ...(legacy.mface ? { mface: legacy.mface } : {}),
          analysis: {
            provider: analyzed.provider,
            model: analyzed.model,
            promptHash: analyzed.promptHash,
            analyzedAt: at
          },
          createdAt: legacy.createdAt,
          updatedAt: at
        });
        const rebuilt = await embedAndIndex(base, {
          embedder,
          vectorIndex,
          now: () => new Date()
        });
        await writeJsonAtomic(filePath, rebuilt);
        succeeded += 1;
        await report({
          stickerId: rebuilt.id,
          status: "rebuilt",
          usageCount: rebuilt.description?.usage.length,
          vectorUnits:
            2 + (rebuilt.description?.usage.length ?? 0)
        });
      } catch (error) {
        failed += 1;
        await report({
          file: name,
          status: "failed",
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }
);
await Promise.all(workers);

process.stdout.write(
  `${JSON.stringify({ records: names.length, succeeded, skipped, failed, reportPath }, null, 2)}\n`
);
if (failed > 0) {
  process.exitCode = 1;
}

async function report(value: Record<string, unknown>): Promise<void> {
  await appendFile(
    reportPath,
    `${JSON.stringify({ at: new Date().toISOString(), ...value })}\n`,
    "utf8"
  );
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function resolveWithinHome(root: string, relativePath: string): string {
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Sticker asset path escapes GestaltHome.");
  }
  return absolute;
}

function readArguments(values: string[]): Arguments {
  const result: Arguments = { concurrency: 2, dryRun: false, help: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--help" || value === "-h") {
      result.help = true;
      continue;
    }
    if (value === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (value === "--home" || value === "--only" || value === "--concurrency") {
      const next = values[++index];
      if (!next) throw new Error(`${value} requires a value.`);
      if (value === "--home") result.home = next;
      if (value === "--only") result.only = next;
      if (value === "--concurrency") result.concurrency = Number(next);
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  if (!Number.isInteger(result.concurrency) || result.concurrency < 1 || result.concurrency > 16) {
    throw new Error("--concurrency must be an integer from 1 through 16.");
  }
  return result;
}
