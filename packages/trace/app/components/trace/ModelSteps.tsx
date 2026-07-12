import type {
  GenerationSummary,
  ModelInputView,
  RolloutDetail
} from "@gestalt/live-contracts";
import { Database } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useModelInput } from "../../hooks/useLiveData";
import { formatCount, formatDuration, formatTime, shortId } from "../../lib/format";
import { StatusPill, cn } from "../ui";
import { MessageContent } from "./BinaryContent";
import { JsonDialog } from "./JsonDialog";
import { EmptyState, ErrorNotice, SkeletonRows } from "./StateViews";

export function ModelSteps({ detail }: { detail: RolloutDetail }) {
  const [selectedGenerationId, setSelectedGenerationId] = useState<string>();
  const [view, setView] = useState<ModelInputView>("delta");
  const generation = useMemo(
    () => detail.generations.find((item) => item.id === selectedGenerationId),
    [detail.generations, selectedGenerationId]
  );
  const input = useModelInput(detail.summary.id, generation?.id, view);

  useEffect(() => {
    setSelectedGenerationId(detail.generations[0]?.id);
    setView("delta");
  }, [detail.summary.id]);

  if (!detail.generations.length) {
    return (
      <EmptyState
        description="Generation metadata appears after the first committed model step."
        title="No generations recorded"
      />
    );
  }

  return (
    <div className="space-y-4 p-4">
      <section aria-labelledby="generation-list-heading">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-xs font-semibold text-neutral-950" id="generation-list-heading">Generations</h3>
          <span className="text-[11px] text-neutral-600">{detail.generations.length} steps</span>
        </div>
        <div className="mt-2 flex gap-2 overflow-x-auto pb-1">
          {detail.generations.map((item, index) => (
            <button
              aria-pressed={item.id === generation?.id}
              className={cn(
                "trace-list-row min-w-32 rounded-md bg-white px-3 py-2 text-left ring-1 ring-inset ring-neutral-200 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
                item.id === generation?.id && "bg-[var(--trace-accent-soft)] ring-[var(--trace-accent-border)]"
              )}
              key={item.id}
              onClick={() => {
                setSelectedGenerationId(item.id);
                setView("delta");
              }}
              type="button"
            >
              <span className="block text-xs font-semibold text-neutral-950">Step {index + 1}</span>
              <span className="mt-1 block text-[11px] text-neutral-600">{formatTime(item.completedAt)}</span>
            </button>
          ))}
        </div>
      </section>

      {generation ? (
        <>
          <GenerationMetadata generation={generation} />

          <section aria-labelledby="model-input-heading">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-xs font-semibold text-neutral-950" id="model-input-heading">Model input</h3>
                <p className="mt-0.5 text-[11px] text-neutral-600">
                  Full prompt is reconstructed only when requested.
                </p>
              </div>
              <div className="flex rounded-md bg-neutral-100 p-1 ring-1 ring-inset ring-neutral-200" role="group" aria-label="Model input view">
                <ViewButton active={view === "delta"} onClick={() => setView("delta")}>Delta</ViewButton>
                <ViewButton active={view === "full"} onClick={() => setView("full")}>Full prompt</ViewButton>
              </div>
            </div>

            <div className="mt-3">
              {input.state === "loading" ? (
                <SkeletonRows rows={4} />
              ) : input.state === "error" || !input.data ? (
                <ErrorNotice message={input.error ?? "Model input is unavailable"} onRetry={() => void input.reload()} />
              ) : (
                <ModelInput input={input.data} view={view} />
              )}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function GenerationMetadata({ generation }: { generation: GenerationSummary }) {
  const prefixReused = generation.cache?.prefixReused;
  return (
    <section aria-labelledby="generation-metadata-heading">
      <h3 className="text-xs font-semibold text-neutral-950" id="generation-metadata-heading">Selected step</h3>
      <dl className="mt-2 divide-y divide-neutral-200 rounded-md bg-white px-3 ring-1 ring-inset ring-neutral-200">
        <Datum label="State hash"><span className="font-mono" title={generation.inputStateHash}>{shortId(generation.inputStateHash, 18)}</span></Datum>
        <Datum label="Messages">{generation.messageCount}</Datum>
        <Datum label="Finish reason">{generation.finishReason ?? "Not reported"}</Datum>
        <Datum label="Latency">{generation.latencyMs === undefined ? "Not reported" : formatDuration(generation.latencyMs)}</Datum>
        <Datum label="Prefix reuse">
          <StatusPill tone={prefixReused ? "ok" : prefixReused === false ? "warning" : "neutral"}>
            {prefixReused === undefined ? "Unknown" : prefixReused ? "Reused" : "Not reused"}
          </StatusPill>
        </Datum>
        <Datum label="Cache read">{formatCount(generation.cache?.readInputTokens)} tokens</Datum>
        <Datum label="Input usage">{formatCount(generation.usage?.inputTokens)} tokens</Datum>
        <Datum label="Output usage">{formatCount(generation.usage?.outputTokens)} tokens</Datum>
      </dl>
    </section>
  );
}

function ModelInput({
  input,
  view
}: {
  input: NonNullable<ReturnType<typeof useModelInput>["data"]>;
  view: ModelInputView;
}) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={view === "full" ? "warning" : "info"}>{view === "full" ? "Full reconstructed input" : "Committed delta"}</StatusPill>
        <span className="text-[11px] text-neutral-600">{input.messages.length} shown · {input.messageCount} total</span>
        {input.unavailableBinaryCount ? <StatusPill tone="warning">{input.unavailableBinaryCount} binaries unavailable</StatusPill> : null}
      </div>
      {input.messages.length ? (
        <ol className="space-y-2">
          {input.messages.map((message) => (
            <li className="rounded-md bg-white p-3 ring-1 ring-inset ring-neutral-200" key={message.id}>
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <StatusPill>{message.role}</StatusPill>
                {message.name ? <span className="truncate text-[11px] text-neutral-600">{message.name}</span> : null}
                <span className="ml-auto truncate font-mono text-[10px] text-neutral-500" title={message.id}>{shortId(message.id, 12)}</span>
              </div>
              <MessageContent value={message.content} />
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-md bg-neutral-50 p-4 text-center text-xs text-neutral-600 ring-1 ring-inset ring-neutral-200">
          No messages were added since the previous generation.
        </div>
      )}
      {input.tools ? (
        <div className="flex items-center justify-between gap-3 rounded-md bg-neutral-50 p-3 ring-1 ring-inset ring-neutral-200">
          <span className="inline-flex items-center gap-2 text-xs text-neutral-700"><Database aria-hidden="true" size={14} />{input.tools.length} tool definitions</span>
          <JsonDialog label="Inspect protocol" title="Tool protocol" value={input.tools} />
        </div>
      ) : null}
    </div>
  );
}

function ViewButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "h-7 rounded px-2.5 text-[11px] font-medium text-neutral-600 outline-none hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
        active && "bg-white text-neutral-950 shadow-[var(--trace-shadow-xs)] ring-1 ring-neutral-200"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-2 text-xs">
      <dt className="shrink-0 text-neutral-600">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-neutral-900">{children}</dd>
    </div>
  );
}
