import { Activity, Images } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./ui";

export type AppSection = "traces" | "stickers";

export function AppHeader({
  current,
  actions,
}: {
  current: AppSection;
  actions?: ReactNode;
}) {
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-neutral-200 bg-white px-3 py-2.5 sm:px-4">
      <div className="flex min-w-0 flex-wrap items-center gap-3 sm:gap-5">
        <a
          aria-label="Gestalt Live traces"
          className="flex shrink-0 items-center gap-2.5 rounded-md text-neutral-950 outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-2"
          href="#/traces"
        >
          <span className="grid h-9 w-9 place-items-center rounded-md bg-[var(--trace-accent)] text-white">
            <Activity aria-hidden="true" size={18} />
          </span>
          <span className="hidden text-sm font-semibold sm:inline">Gestalt Live</span>
        </a>
        <nav
          aria-label="Workspace"
          className="flex items-center rounded-md bg-neutral-100 p-1 ring-1 ring-inset ring-neutral-200"
        >
          <NavigationItem
            current={current === "traces"}
            href="#/traces"
            icon={<Activity aria-hidden="true" size={15} />}
          >
            Traces
          </NavigationItem>
          <NavigationItem
            current={current === "stickers"}
            href="#/stickers"
            icon={<Images aria-hidden="true" size={15} />}
          >
            Stickers
          </NavigationItem>
        </nav>
      </div>
      {actions ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          {actions}
        </div>
      ) : null}
    </header>
  );
}

function NavigationItem({
  current,
  href,
  icon,
  children,
}: {
  current: boolean;
  href: string;
  icon: ReactNode;
  children: ReactNode;
}) {
  return (
    <a
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex h-8 items-center gap-2 rounded px-2.5 text-xs font-medium text-neutral-600 outline-none hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1",
        current && "bg-white text-neutral-950 shadow-[var(--trace-shadow-xs)] ring-1 ring-neutral-200"
      )}
      href={href}
    >
      {icon}
      {children}
    </a>
  );
}
