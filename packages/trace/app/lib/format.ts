import type {
  RolloutStatus,
  SignalCounts,
  SignalSeverity
} from "@gestalt/live-contracts";

export function formatTime(value: string | undefined): string {
  if (!value) return "--:--";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "--:--";
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "Not finished";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) return "Running";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${(value / 60_000).toFixed(1)}m`;
}

export function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

export function formatCount(value: number | undefined): string {
  if (value === undefined) return "—";
  return new Intl.NumberFormat(undefined, { notation: "compact" }).format(value);
}

export function shortId(value: string, length = 10): string {
  return value.length <= length ? value : `${value.slice(0, length)}…`;
}

export function statusTone(
  status: RolloutStatus | "unknown"
): "neutral" | "ok" | "warning" | "error" | "info" {
  if (status === "completed") return "ok";
  if (status === "running") return "info";
  if (status === "failed") return "error";
  if (status === "cancelled") return "warning";
  return "neutral";
}

export function severityTone(
  severity: SignalSeverity
): "neutral" | "warning" | "error" | "info" {
  if (severity === "error") return "error";
  if (severity === "warning") return "warning";
  return "info";
}

export function signalTotal(signals: SignalCounts): number {
  return signals.info + signals.warning + signals.error;
}

export function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
