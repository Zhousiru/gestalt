import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ConnectorMediaReference } from "../connectors/types";

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const IMAGE_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface ModelImageContent {
  data: Uint8Array;
  mediaType: string;
}

/** Resolves media returned by an explicit connector read action for the model. */
export async function readImageContentForModel(
  reference: ConnectorMediaReference,
  fetchImplementation: typeof fetch = globalThis.fetch
): Promise<ModelImageContent> {
  if (reference.source !== "connector-action") {
    throw new Error("Image media was not returned by a connector action.");
  }

  const data =
    reference.kind === "base64"
      ? decodeBase64Reference(reference.value)
      : reference.kind === "https-url"
        ? await downloadImage(reference.value, fetchImplementation)
        : await readLocalImage(reference.value);

  return {
    data,
    mediaType: detectImageMediaType(data)
  };
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
    throw new Error("Image media contains invalid base64 data.");
  }
  const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
  const estimatedBytes = Math.floor((compact.length * 3) / 4) - padding;
  if (estimatedBytes > MAX_IMAGE_BYTES) {
    throw new Error(`Image media exceeds ${MAX_IMAGE_BYTES} bytes.`);
  }
  return checkedImageBytes(Buffer.from(compact, "base64"));
}

async function downloadImage(
  url: string,
  fetchImplementation: typeof fetch
): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    IMAGE_DOWNLOAD_TIMEOUT_MS
  );
  try {
    const response = await fetchImplementation(url, {
      signal: controller.signal
    });
    if (!response.ok) {
      throw new Error(`Image download failed with HTTP ${response.status}.`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_BYTES) {
      throw new Error(`Image media exceeds ${MAX_IMAGE_BYTES} bytes.`);
    }
    return readResponseBody(response);
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBody(response: Response): Promise<Uint8Array> {
  if (!response.body) {
    return checkedImageBytes(new Uint8Array(await response.arrayBuffer()));
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
      if (total > MAX_IMAGE_BYTES) {
        await reader.cancel();
        throw new Error(`Image media exceeds ${MAX_IMAGE_BYTES} bytes.`);
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
  return checkedImageBytes(bytes);
}

async function readLocalImage(reference: string): Promise<Uint8Array> {
  const filePath = reference.startsWith("file://")
    ? fileURLToPath(reference)
    : reference;
  if (!path.isAbsolute(filePath)) {
    throw new Error("Connector image path is not absolute.");
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Connector image path is not a regular file.");
  }
  if (metadata.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image media exceeds ${MAX_IMAGE_BYTES} bytes.`);
  }
  return checkedImageBytes(await readFile(filePath));
}

function checkedImageBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength === 0) {
    throw new Error("Image media is empty.");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`Image media exceeds ${MAX_IMAGE_BYTES} bytes.`);
  }
  return bytes;
}

function detectImageMediaType(bytes: Uint8Array): string {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 6 &&
    String.fromCharCode(...bytes.slice(0, 6)).startsWith("GIF8")
  ) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  throw new Error("Connector media is not a supported PNG, GIF, WebP, or JPEG image.");
}
