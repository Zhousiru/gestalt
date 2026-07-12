import { Braces } from "lucide-react";
import { collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import { Dialog, cn } from "../ui";

const jsonViewStyles = {
  ...darkStyles,
  container: "trace-json-view",
  childFieldsContainer: "trace-json-children"
};

export function JsonDialog({
  title,
  value,
  label = "View JSON",
  className
}: {
  title: string;
  value: unknown;
  label?: string;
  className?: string;
}) {
  return (
    <Dialog
      title={title}
      trigger={
        <button
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-md bg-white px-2.5 text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 outline-none hover:bg-neutral-50 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
            className
          )}
          type="button"
        >
          <Braces aria-hidden="true" size={13} />
          {label}
        </button>
      }
    >
      <div className="h-full overflow-auto bg-neutral-950 p-4 font-mono text-xs">
        <JsonView
          data={toJsonData(value)}
          shouldExpandNode={collapseAllNested}
          style={jsonViewStyles}
        />
      </div>
    </Dialog>
  );
}

function toJsonData(value: unknown): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return value as Record<string, unknown>;
  return { value };
}
