import {
  BinaryDescriptorSchema,
  type BinaryDescriptor
} from "@gestalt/live-contracts";
import { Eye, FileImage, ImageOff } from "lucide-react";
import { useState } from "react";
import { formatBytes, shortId } from "../../lib/format";
import { liveApi } from "../../lib/liveApi";
import { StatusPill } from "../ui";
import { JsonDialog } from "./JsonDialog";

export function MessageContent({ value }: { value: unknown }) {
  if (typeof value === "string") {
    return <p className="whitespace-pre-wrap break-words text-sm leading-6">{value}</p>;
  }

  const directBinary = BinaryDescriptorSchema.safeParse(value);
  if (directBinary.success) {
    return <BinaryAttachment descriptor={directBinary.data} />;
  }

  if (Array.isArray(value)) {
    return (
      <div className="space-y-2">
        {value.map((part, index) => (
          <MessageContent key={contentKey(part, index)} value={part} />
        ))}
      </div>
    );
  }

  if (isRecord(value) && typeof value.text === "string") {
    const binaries = collectBinaries(value);
    return (
      <div className="space-y-2">
        <p className="whitespace-pre-wrap break-words text-sm leading-6">{value.text}</p>
        {binaries.map((descriptor) => (
          <BinaryAttachment descriptor={descriptor} key={descriptor.sha256} />
        ))}
      </div>
    );
  }

  const binaries = collectBinaries(value);
  return (
    <div className="space-y-2">
      {binaries.map((descriptor) => (
        <BinaryAttachment descriptor={descriptor} key={descriptor.sha256} />
      ))}
      <JsonDialog label="Inspect content" title="Message content" value={value} />
    </div>
  );
}

export function BinaryAttachment({ descriptor }: { descriptor: BinaryDescriptor }) {
  const [previewRequested, setPreviewRequested] = useState(false);
  const stored = descriptor.availability === "stored";
  const url = liveApi.blobUrl(descriptor.sha256);

  return (
    <div className="rounded-md bg-neutral-50 p-3 ring-1 ring-inset ring-neutral-200">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white text-neutral-500 ring-1 ring-inset ring-neutral-200">
          {stored ? <FileImage aria-hidden="true" size={16} /> : <ImageOff aria-hidden="true" size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-neutral-900">{descriptor.mediaType}</span>
            <StatusPill tone={stored ? "ok" : "neutral"}>
              {availabilityLabel(descriptor.availability)}
            </StatusPill>
          </div>
          <p className="mt-1 font-mono text-[11px] leading-5 text-neutral-600">
            {formatBytes(descriptor.byteLength)} · {shortId(descriptor.sha256, 14)}
          </p>
          {descriptor.errorCode ? (
            <p className="mt-0.5 font-mono text-[10px] text-red-700">
              {descriptor.errorCode}
            </p>
          ) : null}
        </div>
        {stored && !previewRequested ? (
          <button
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white px-2.5 text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 outline-none hover:bg-neutral-100 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]"
            onClick={() => setPreviewRequested(true)}
            type="button"
          >
            <Eye aria-hidden="true" size={13} />
            Load preview
          </button>
        ) : null}
      </div>
      {previewRequested ? (
        <div className="mt-3 overflow-hidden rounded-md bg-white ring-1 ring-inset ring-neutral-200">
          <BlobPreview descriptor={descriptor} url={url} />
        </div>
      ) : null}
    </div>
  );
}

function BlobPreview({ descriptor, url }: { descriptor: BinaryDescriptor; url: string }) {
  if (descriptor.mediaType.startsWith("image/")) {
    return <img alt="Captured binary preview" className="max-h-80 w-full object-contain" src={url} />;
  }
  if (descriptor.mediaType.startsWith("audio/")) {
    return <audio className="w-full p-2" controls src={url} />;
  }
  if (descriptor.mediaType.startsWith("video/")) {
    return <video className="max-h-80 w-full" controls src={url} />;
  }
  return (
    <a
      className="block p-3 text-sm font-medium text-[var(--trace-accent)] underline underline-offset-2"
      href={url}
      rel="noreferrer"
      target="_blank"
    >
      Open captured blob
    </a>
  );
}

function availabilityLabel(value: BinaryDescriptor["availability"]): string {
  if (value === "stored") return "Stored";
  if (value === "not_captured") return "Not captured";
  if (value === "size_limit_exceeded") return "Size limit exceeded";
  return "Write failed";
}

function collectBinaries(value: unknown): BinaryDescriptor[] {
  const found = new Map<string, BinaryDescriptor>();
  const visit = (candidate: unknown) => {
    const parsed = BinaryDescriptorSchema.safeParse(candidate);
    if (parsed.success) {
      found.set(parsed.data.sha256, parsed.data);
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
    } else if (isRecord(candidate)) {
      for (const nested of Object.values(candidate)) visit(nested);
    }
  };
  visit(value);
  return [...found.values()];
}

function contentKey(value: unknown, index: number): string {
  const binary = BinaryDescriptorSchema.safeParse(value);
  return binary.success ? binary.data.sha256 : String(index);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
