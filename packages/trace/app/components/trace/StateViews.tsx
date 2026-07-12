import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../ui";

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-label="Loading" className="space-y-2 p-3" role="status">
      {Array.from({ length: rows }, (_, index) => (
        <div
          className={cn(
            "trace-skeleton h-14 rounded-md bg-neutral-100",
            index % 3 === 1 && "w-[88%]",
            index % 3 === 2 && "w-[94%]"
          )}
          key={index}
        />
      ))}
      <span className="sr-only">Loading content</span>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="grid min-h-52 place-items-center p-6 text-center">
      <div className="max-w-sm">
        <Inbox aria-hidden="true" className="mx-auto text-neutral-400" size={22} />
        <h2 className="mt-3 text-sm font-semibold text-neutral-950">{title}</h2>
        <p className="mt-1.5 text-sm leading-6 text-neutral-600">{description}</p>
        {action ? <div className="mt-4">{action}</div> : null}
      </div>
    </div>
  );
}

export function ErrorNotice({
  message,
  onRetry,
  compact = false
}: {
  message: string;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "m-3 flex items-start gap-3 rounded-md bg-red-50 p-3 text-red-900 ring-1 ring-inset ring-red-200",
        !compact && "mx-auto max-w-lg"
      )}
      role="alert"
    >
      <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={16} />
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Could not load this view</p>
        <p className="mt-1 break-words text-xs leading-5 text-red-800">{message}</p>
      </div>
      <button
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-white px-2.5 text-xs font-medium ring-1 ring-inset ring-red-300 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]"
        onClick={onRetry}
        type="button"
      >
        <RefreshCw aria-hidden="true" size={13} />
        Retry
      </button>
    </div>
  );
}

export function InlineNotice({ children }: { children: ReactNode }) {
  return (
    <div className="m-3 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 ring-1 ring-inset ring-amber-200">
      {children}
    </div>
  );
}
