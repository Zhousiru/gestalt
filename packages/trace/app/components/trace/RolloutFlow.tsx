import type { FlowItem, RolloutDetail } from "@gestalt/live-contracts";
import { Bot, BrainCircuit, CircleDot, Clock3, Send, Wrench } from "lucide-react";
import { formatDuration, formatTime } from "../../lib/format";
import { StatusPill, cn } from "../ui";
import { EmptyState } from "./StateViews";

export function RolloutFlow({ detail }: { detail: RolloutDetail }) {
  if (!detail.flow.length) {
    return <EmptyState description="Completed generations, tools, actions, and spans appear here in execution order." title="No flow records" />;
  }
  return (
    <div className="p-4">
      <ol className="relative space-y-0" aria-label="Rollout execution flow">
        {detail.flow.map((item, index) => (
          <li className="relative flex gap-3 pb-5 last:pb-0" key={item.id}>
            {index < detail.flow.length - 1 ? <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-8 w-px bg-neutral-200" /> : null}
            <span className={cn("relative z-10 grid h-8 w-8 shrink-0 place-items-center rounded-md bg-white ring-1 ring-inset ring-neutral-300", item.status === "failed" && "bg-red-50 text-red-700 ring-red-200", item.status === "running" && "bg-[var(--trace-accent-soft)] text-[var(--trace-accent)] ring-[var(--trace-accent-border)]")}>
              <FlowIcon type={item.type} />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 break-words text-xs font-semibold text-neutral-950">{item.title}</span>
                <StatusPill tone={item.status === "completed" ? "ok" : item.status === "failed" ? "error" : item.status === "running" ? "info" : item.status === "cancelled" ? "warning" : "neutral"}>{item.status}</StatusPill>
              </div>
              {item.detail ? <p className="mt-1 break-words text-xs leading-5 text-neutral-600">{item.detail}</p> : null}
              {item.resultUnknownReason ? (
                <p className="mt-2 rounded-md bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-900 ring-1 ring-inset ring-amber-200">
                  {item.resultUnknownReason === "dispatch_response_lost"
                    ? "Result unknown after dispatch. It was not retried."
                    : "Result unknown after restart. It was not retried."}
                </p>
              ) : null}
              <p className="mt-1.5 flex items-center gap-1.5 text-[11px] text-neutral-500">
                <Clock3 aria-hidden="true" size={11} />
                <time dateTime={item.startedAt}>{formatTime(item.startedAt)}</time>
                <span aria-hidden="true">·</span>
                <span>{item.durationMs === undefined ? (item.status === "running" ? "Running" : "Not finished") : formatDuration(item.durationMs)}</span>
                {item.recordIds.length ? <><span aria-hidden="true">·</span><span>{item.recordIds.length} records</span></> : null}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function FlowIcon({ type }: { type: FlowItem["type"] }) {
  if (type === "generation") return <Bot aria-hidden="true" size={14} />;
  if (type === "tool") return <Wrench aria-hidden="true" size={14} />;
  if (type === "outbound_action") return <Send aria-hidden="true" size={14} />;
  if (type === "dreaming") return <BrainCircuit aria-hidden="true" size={14} />;
  return <CircleDot aria-hidden="true" size={14} />;
}
