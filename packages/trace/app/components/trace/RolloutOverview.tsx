import type { RolloutDetail } from "@gestalt/live-contracts";
import { AlertCircle, CheckCircle2, Clock3, Radio, Wrench } from "lucide-react";
import type { ReactNode } from "react";
import {
  formatCount,
  formatDateTime,
  formatDuration,
  shortId,
  statusTone
} from "../../lib/format";
import { StatusPill } from "../ui";

export function RolloutOverview({
  detail,
  binaryCaptureEnabled
}: {
  detail: RolloutDetail;
  binaryCaptureEnabled: boolean | undefined;
}) {
  const { summary, modelSession } = detail;
  const usage = totalUsage(detail);
  return (
    <div className="space-y-5 p-4">
      {summary.failureReason ? (
        <div className="flex gap-2 rounded-md bg-red-50 p-3 text-xs leading-5 text-red-900 ring-1 ring-inset ring-red-200">
          <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={15} />
          <div>
            <p className="font-semibold">Rollout failed</p>
            <p className="mt-0.5 break-words">{summary.failureReason}</p>
          </div>
        </div>
      ) : null}

      <section aria-labelledby="rollout-status-heading">
        <h3 className="text-xs font-semibold text-neutral-950" id="rollout-status-heading">Status</h3>
        <dl className="mt-2 divide-y divide-neutral-200 rounded-md bg-white px-3 ring-1 ring-inset ring-neutral-200">
          <Datum label="State">
            <StatusPill tone={statusTone(summary.status)}>{summary.status}</StatusPill>
          </Datum>
          <Datum label="Started">{formatDateTime(summary.startedAt)}</Datum>
          <Datum label="Ended">{formatDateTime(summary.endedAt)}</Datum>
          <Datum label="Duration">{formatDuration(summary.durationMs)}</Datum>
          <Datum label="Phase">{summary.phase ?? "Not reported"}</Datum>
          <Datum label="Model">{summary.model ?? "Not reported"}</Datum>
          <Datum label="Binary capture">
            {binaryCaptureEnabled === undefined
              ? "Unknown"
              : binaryCaptureEnabled
                ? "Enabled"
                : "Disabled by default"}
          </Datum>
        </dl>
      </section>

      <section aria-labelledby="rollout-shape-heading">
        <h3 className="text-xs font-semibold text-neutral-950" id="rollout-shape-heading">Session shape</h3>
        <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-md bg-neutral-200 ring-1 ring-neutral-200">
          <Metric icon={<Radio aria-hidden="true" size={14} />} label="Generations" value={formatCount(summary.generationCount)} />
          <Metric icon={<Wrench aria-hidden="true" size={14} />} label="Tools" value={formatCount(summary.toolCount)} />
          <Metric icon={<CheckCircle2 aria-hidden="true" size={14} />} label="Actions" value={formatCount(summary.actionCount)} />
          <Metric icon={<Clock3 aria-hidden="true" size={14} />} label="Messages" value={formatCount(summary.messageCount)} />
        </div>
      </section>

      <section aria-labelledby="model-session-heading">
        <h3 className="text-xs font-semibold text-neutral-950" id="model-session-heading">Model session</h3>
        <dl className="mt-2 divide-y divide-neutral-200 rounded-md bg-white px-3 ring-1 ring-inset ring-neutral-200">
          <Datum label="Initialized">{formatDateTime(modelSession.initializedAt)}</Datum>
          <Datum label="Initial messages">{modelSession.initialMessageCount}</Datum>
          <Datum label="Tool protocol">{modelSession.toolCount} tools</Datum>
          <Datum label="Initial state hash">
            {modelSession.initialStateHash ? (
              <span className="font-mono" title={modelSession.initialStateHash}>{shortId(modelSession.initialStateHash, 18)}</span>
            ) : "Not reported"}
          </Datum>
          <Datum label="Input tokens">{formatCount(usage.input)}</Datum>
          <Datum label="Output tokens">{formatCount(usage.output)}</Datum>
          <Datum label="Cache reads">{formatCount(usage.cacheRead)}</Datum>
        </dl>
        {modelSession.toolNames.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {modelSession.toolNames.map((name) => <StatusPill key={name}>{name}</StatusPill>)}
          </div>
        ) : null}
      </section>

      {detail.signals.length ? (
        <section aria-labelledby="rollout-signals-heading">
          <h3 className="text-xs font-semibold text-neutral-950" id="rollout-signals-heading">Signals</h3>
          <div className="mt-2 space-y-2">
            {detail.signals.map((signal) => (
              <div className="rounded-md bg-white p-3 ring-1 ring-inset ring-neutral-200" key={signal.id}>
                <div className="flex items-center gap-2">
                  <StatusPill tone={signal.severity === "error" ? "error" : signal.severity === "warning" ? "warning" : "info"}>{signal.severity}</StatusPill>
                  <span className="text-xs font-semibold text-neutral-950">{signal.title}</span>
                </div>
                <p className="mt-2 text-xs leading-5 text-neutral-600">{signal.message}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 py-2 text-xs">
      <dt className="shrink-0 text-neutral-600">{label}</dt>
      <dd className="min-w-0 break-words text-right font-medium text-neutral-900">{children}</dd>
    </div>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="bg-white p-3">
      <div className="flex items-center gap-2 text-neutral-500">{icon}<span className="text-[11px]">{label}</span></div>
      <p className="mt-1 text-sm font-semibold tabular-nums text-neutral-950">{value}</p>
    </div>
  );
}

function totalUsage(detail: RolloutDetail) {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let hasInput = false;
  let hasOutput = false;
  let hasCacheRead = false;
  for (const generation of detail.generations) {
    if (generation.usage?.inputTokens !== undefined) {
      input += generation.usage.inputTokens;
      hasInput = true;
    }
    if (generation.usage?.outputTokens !== undefined) {
      output += generation.usage.outputTokens;
      hasOutput = true;
    }
    if (generation.cache?.readInputTokens !== undefined) {
      cacheRead += generation.cache.readInputTokens;
      hasCacheRead = true;
    }
  }
  return {
    input: hasInput ? input : undefined,
    output: hasOutput ? output : undefined,
    cacheRead: hasCacheRead ? cacheRead : undefined
  };
}
