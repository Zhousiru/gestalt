import { Braces, ChevronDown } from "lucide-react";
import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import type { ReactNode } from "react";
import { cn } from "../ui";

const jsonViewStyles = {
  ...darkStyles,
  container: "trace-json-view",
  childFieldsContainer: "trace-json-children"
};

export function JsonDetails({
  value,
  label = "View JSON",
  summary,
  className,
  summaryClassName,
  contentClassName
}: {
  value: unknown;
  label?: string;
  summary?: ReactNode;
  className?: string;
  summaryClassName?: string;
  contentClassName?: string;
}) {
  return (
    <details className={cn("group min-w-0", className)}>
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-1.5 rounded-md text-xs font-medium text-neutral-700 outline-none hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
          summaryClassName
        )}
      >
        {summary ?? (
          <>
          <Braces aria-hidden="true" size={13} />
          {label}
          </>
        )}
        <ChevronDown
          aria-hidden="true"
          className="ml-auto shrink-0 transition-transform duration-150 group-open:rotate-180"
          size={13}
        />
      </summary>
      <div
        className={cn(
          "mt-2 max-h-96 overflow-auto rounded-md bg-neutral-950 p-3 font-mono text-[11px]",
          contentClassName
        )}
      >
        <JsonView
          data={toJsonData(value)}
          shouldExpandNode={collapseAllNested}
          style={jsonViewStyles}
        />
      </div>
    </details>
  );
}

function toJsonData(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return { value };
}
