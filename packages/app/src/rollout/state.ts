import { createHash } from "node:crypto";
import type { BinaryDescriptor, RolloutMessage } from "./types";

const INITIAL_STATE_DOMAIN = "gestalt.rollout.state.initial\n";
const APPENDED_MESSAGE_DOMAIN = "gestalt.rollout.state.message\n";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MEDIA_TYPE_PATTERN =
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export interface CanonicalModelState {
  messages: readonly RolloutMessage[];
  tools: readonly unknown[];
}

/**
 * Serializes JSON-like model state with stable object-key ordering.
 *
 * Binary descriptors intentionally hash only their logical identity. Capture
 * availability is a storage concern and must not change a model prefix hash.
 */
export function canonicalStringify(value: unknown): string {
  return serializeCanonical(value, new WeakSet<object>(), false);
}

export function computeInitialStateHash(
  messages: readonly RolloutMessage[],
  tools: readonly unknown[]
): string {
  return digest(
    INITIAL_STATE_DOMAIN +
      canonicalStringify({
        messages,
        tools
      })
  );
}

export function advanceStateHash(
  previousStateHash: string,
  message: RolloutMessage
): string {
  assertStateHash(previousStateHash);
  return digest(
    `${APPENDED_MESSAGE_DOMAIN}${previousStateHash}\n${canonicalStringify(
      message
    )}`
  );
}

export function computeStateHash(state: CanonicalModelState): string {
  return computeInitialStateHash(state.messages, state.tools);
}

export function computeAppendedStateHash(
  initialMessages: readonly RolloutMessage[],
  tools: readonly unknown[],
  committedMessages: readonly RolloutMessage[]
): string {
  let hash = computeInitialStateHash(initialMessages, tools);
  for (const message of committedMessages) {
    hash = advanceStateHash(hash, message);
  }
  return hash;
}

export function isStateHash(value: string): boolean {
  return SHA256_PATTERN.test(value);
}

function assertStateHash(value: string): void {
  if (!isStateHash(value)) {
    throw new Error("State hash must be a lowercase SHA-256 digest.");
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function serializeCanonical(
  value: unknown,
  seen: WeakSet<object>,
  inArray: boolean
): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical state cannot contain non-finite numbers.");
    }
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (value === undefined) {
    if (inArray) {
      return "null";
    }
    throw new TypeError("Canonical state cannot have an undefined root value.");
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Canonical state cannot contain ${typeof value} values.`);
  }
  if (typeof value !== "object") {
    throw new TypeError("Canonical state contains an unsupported value.");
  }
  if (isRawBinary(value)) {
    throw new TypeError(
      "Canonical state contains raw binary. Sanitize it before hashing."
    );
  }
  if (seen.has(value)) {
    throw new TypeError("Canonical state cannot contain circular references.");
  }

  const logicalBinary = readBinaryIdentity(value);
  if (logicalBinary) {
    return serializeCanonical(
      [
        logicalBinary.type,
        logicalBinary.mediaType,
        logicalBinary.byteLength,
        logicalBinary.sha256
      ],
      seen,
      inArray
    );
  }

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value
        .map((item) => serializeCanonical(item, seen, true))
        .join(",")}]`;
    }
    if (!isPlainObject(value)) {
      throw new TypeError(
        "Canonical state must contain only plain objects, arrays, and primitives."
      );
    }

    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item === undefined) {
        continue;
      }
      fields.push(
        `${JSON.stringify(key)}:${serializeCanonical(item, seen, false)}`
      );
    }
    return `{${fields.join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

function isRawBinary(value: object): boolean {
  return (
    Buffer.isBuffer(value) ||
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof SharedArrayBuffer !== "undefined" &&
      value instanceof SharedArrayBuffer)
  );
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function readBinaryIdentity(
  value: object
): Omit<BinaryDescriptor, "availability" | "errorCode"> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }
  const candidate = value as Partial<BinaryDescriptor>;
  if (
    candidate.type !== "binary" ||
    typeof candidate.mediaType !== "string" ||
    typeof candidate.byteLength !== "number" ||
    !Number.isSafeInteger(candidate.byteLength) ||
    candidate.byteLength < 0 ||
    typeof candidate.sha256 !== "string" ||
    !SHA256_PATTERN.test(candidate.sha256) ||
    !MEDIA_TYPE_PATTERN.test(candidate.mediaType)
  ) {
    return undefined;
  }
  return {
    type: "binary",
    mediaType: candidate.mediaType,
    byteLength: candidate.byteLength,
    sha256: candidate.sha256
  };
}
