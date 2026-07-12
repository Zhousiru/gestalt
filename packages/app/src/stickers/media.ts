import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type {
  Connector,
  ConnectorFetchedSegment,
  ConnectorMediaReference
} from "../connectors/types";
import { classifyStickerSegment } from "./extract";
import type { StickerJob, StickerSourceKind } from "./schemas";

const MAX_STICKER_BYTES = 16 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface StickerMediaResolver {
  resolve(job: StickerJob): Promise<Uint8Array>;
}

export function createStickerMediaResolver(input: {
  connector: Connector;
  fetch?: typeof fetch;
}): StickerMediaResolver {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  return {
    async resolve(job) {
      const inline = readInlineBase64(job.segment.data);
      if (inline) {
        return inline;
      }

      const direct = await resolveOpaqueFile(
        input.connector,
        fetchImplementation,
        job.segment.data
      );
      if (direct) {
        return direct;
      }

      const fetched = await input.connector.fetchMessage({
        messageId: job.messageId
      });
      if (fetched.ok && fetched.segments) {
        const segment = selectFetchedSegment(job, fetched.segments);
        if (segment) {
          const resolved = await resolveFetchedSegment(
            input.connector,
            fetchImplementation,
            segment
          );
          if (resolved) {
            return resolved;
          }
        }
      }
      throw new Error("The sticker media could not be resolved from the received message.");
    }
  };
}

async function resolveFetchedSegment(
  connector: Connector,
  fetchImplementation: typeof fetch,
  segment: ConnectorFetchedSegment
): Promise<Uint8Array | undefined> {
  const inline = readInlineBase64(segment.data);
  if (inline) {
    return inline;
  }
  if (segment.media) {
    return readTrustedMediaReference(segment.media, fetchImplementation);
  }
  return resolveOpaqueFile(
    connector,
    fetchImplementation,
    segment.data
  );
}

async function resolveOpaqueFile(
  connector: Connector,
  fetchImplementation: typeof fetch,
  data: Record<string, unknown>
): Promise<Uint8Array | undefined> {
  const file = readString(data.file);
  if (!file || file === "marketface" || isBase64Reference(file)) {
    return undefined;
  }
  const image = await connector.readImage({ file });
  if (!image.ok || !image.media) {
    return undefined;
  }
  return readTrustedMediaReference(image.media, fetchImplementation);
}

function selectFetchedSegment(
  job: StickerJob,
  segments: readonly ConnectorFetchedSegment[]
): ConnectorFetchedSegment | undefined {
  const indexed = segments.find(
    (candidate) => candidate.segmentIndex === job.segmentIndex
  );
  if (indexed && segmentIdentityMatches(job, indexed)) {
    return indexed;
  }

  return segments.find((candidate) => segmentIdentityMatches(job, candidate));
}

function segmentIdentityMatches(
  job: StickerJob,
  candidate: ConnectorFetchedSegment
): boolean {
  if (classifyStickerSegment(candidate) !== job.sourceKind) {
    return false;
  }
  const original = job.segment.data;
  const current = candidate.data;

  for (const aliases of identityConstraintAliases(job.sourceKind)) {
    const expected = readAliasedIdentity(original, aliases);
    const actual = readAliasedIdentity(current, aliases);
    if (expected !== undefined && actual !== undefined && expected !== actual) {
      return false;
    }
  }

  return identityMatchAliases(job.sourceKind).some((aliases) => {
    const expected = readAliasedIdentity(original, aliases);
    const actual = readAliasedIdentity(current, aliases);
    return expected !== undefined && expected === actual;
  });
}

function identityConstraintAliases(sourceKind: StickerSourceKind): string[][] {
  return sourceKind === "mface"
    ? [
        ["emoji_id", "emojiId"],
        ["emoji_package_id", "emojiPackageId"],
        ["key"],
        ["md5", "sha256"]
      ]
    : [["file"], ["file_id", "fileId"], ["md5", "sha256"]];
}

function identityMatchAliases(sourceKind: StickerSourceKind): string[][] {
  return sourceKind === "mface"
    ? [
        ["emoji_id", "emojiId"],
        ["key"],
        ["md5", "sha256"],
        ["file_id", "fileId"],
        ["file"]
      ]
    : [["file"], ["file_id", "fileId"], ["md5", "sha256"]];
}

function readAliasedIdentity(
  data: Record<string, unknown>,
  aliases: readonly string[]
): string | undefined {
  for (const alias of aliases) {
    const value = readString(data[alias]);
    if (
      value &&
      value !== "marketface" &&
      !isBase64Reference(value)
    ) {
      return value;
    }
  }
  return undefined;
}

function readInlineBase64(
  data: Record<string, unknown>
): Uint8Array | undefined {
  for (const candidate of [data.path, data.url, data.file]) {
    const reference = readString(candidate);
    if (reference && isBase64Reference(reference)) {
      return decodeBase64Reference(reference);
    }
  }
  return undefined;
}

async function readTrustedMediaReference(
  reference: ConnectorMediaReference,
  fetchImplementation: typeof fetch
): Promise<Uint8Array | undefined> {
  if (reference.source !== "connector-action") {
    return undefined;
  }
  if (reference.kind === "base64") {
    return decodeBase64Reference(reference.value);
  }
  if (reference.kind === "https-url") {
    return downloadUrl(reference.value, fetchImplementation);
  }
  if (reference.kind === "local-file") {
    return readTrustedLocalFile(reference.value);
  }
  return undefined;
}

function decodeBase64Reference(reference: string): Uint8Array {
  const comma = reference.indexOf(",");
  const encoded = reference.startsWith("base64://")
    ? reference.slice("base64://".length)
    : comma >= 0
      ? reference.slice(comma + 1)
      : "";
  const compact = encoded.replace(/\s/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    throw new Error("Sticker media contains invalid base64 data.");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (estimatedBytes > MAX_STICKER_BYTES) {
    throw new Error(`Sticker media exceeds ${MAX_STICKER_BYTES} bytes.`);
  }
  return checkedBytes(Buffer.from(compact, "base64"));
}

async function downloadUrl(
  reference: string,
  fetchImplementation: typeof fetch
): Promise<Uint8Array | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchImplementation(reference, {
      signal: controller.signal
    });
    if (!response.ok) {
      return undefined;
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_STICKER_BYTES) {
      throw new Error(`Sticker media exceeds ${MAX_STICKER_BYTES} bytes.`);
    }
    return readResponseBody(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    return checkedBytes(new Uint8Array(await response.arrayBuffer()));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > MAX_STICKER_BYTES) {
        await reader.cancel();
        throw new Error(`Sticker media exceeds ${MAX_STICKER_BYTES} bytes.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return checkedBytes(bytes);
}

async function readTrustedLocalFile(
  reference: string
): Promise<Uint8Array | undefined> {
  let filePath: string;
  try {
    filePath = reference.startsWith("file://")
      ? fileURLToPath(reference)
      : reference;
  } catch {
    return undefined;
  }
  if (!path.isAbsolute(filePath)) {
    return undefined;
  }
  try {
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return undefined;
    }
    if (metadata.size > MAX_STICKER_BYTES) {
      throw new Error(`Sticker media exceeds ${MAX_STICKER_BYTES} bytes.`);
    }
    return checkedBytes(await readFile(filePath));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function checkedBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    throw new Error("Sticker media is empty.");
  }
  if (bytes.byteLength > MAX_STICKER_BYTES) {
    throw new Error(`Sticker media exceeds ${MAX_STICKER_BYTES} bytes.`);
  }
  return bytes;
}

function isBase64Reference(value: string): boolean {
  return value.startsWith("base64://") || /^data:image\/[a-z0-9.+-]+;base64,/i.test(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
