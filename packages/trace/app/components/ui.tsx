import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type {
  ButtonHTMLAttributes,
  ComponentProps,
  PropsWithChildren,
  ReactNode,
  Ref,
  UIEventHandler
} from "react";
import { X } from "lucide-react";

export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

export function Tabs(props: ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root {...props} />;
}

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn(
        "grid min-w-0 grid-flow-col auto-cols-fr border-b border-neutral-200 bg-white",
        className
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "min-w-0 whitespace-nowrap border-b-2 border-transparent px-2 py-2 text-xs font-medium text-neutral-600 outline-none hover:bg-neutral-50 hover:text-neutral-950 data-[state=active]:border-[var(--trace-accent)] data-[state=active]:bg-neutral-50 data-[state=active]:text-neutral-950",
        "focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1",
        className
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      className={cn(
        "min-w-0 outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
        className
      )}
      {...props}
    />
  );
}

export function ScrollArea({
  className,
  children,
  onViewportScroll,
  viewportRef
}: PropsWithChildren<{
  className?: string;
  onViewportScroll?: UIEventHandler<HTMLDivElement>;
  viewportRef?: Ref<HTMLDivElement>;
}>) {
  return (
    <ScrollAreaPrimitive.Root className={cn("min-w-0 overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport
        ref={viewportRef}
        className="h-full w-full min-w-0 overflow-x-hidden"
        onScroll={onViewportScroll}
      >
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        className="flex w-2 touch-none border-l border-neutral-100 bg-transparent p-px"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 rounded-full bg-neutral-300 hover:bg-neutral-400" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function TooltipProvider({ children }: PropsWithChildren) {
  return <TooltipPrimitive.Provider delayDuration={250}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  label,
  children,
}: PropsWithChildren<{ label: string }>) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          className="z-50 rounded-md bg-neutral-950 px-2.5 py-1.5 text-xs font-medium text-white shadow-md"
          sideOffset={6}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-neutral-950" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function Dialog({
  title,
  trigger,
  children,
}: PropsWithChildren<{ title: string; trigger: ReactNode }>) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-neutral-950/30 backdrop-blur-[2px]" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 grid h-[86vh] max-h-[900px] w-[calc(100vw-2rem)] max-w-6xl -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg bg-white shadow-[var(--trace-shadow-md)] ring-1 ring-neutral-200">
          <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold text-neutral-950">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close
              aria-label="Close dialog"
              className="grid h-8 w-8 place-items-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]"
            >
              <X size={16} />
            </DialogPrimitive.Close>
          </header>
          <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function IconButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cn(
        "grid h-9 w-9 place-items-center rounded-md bg-white text-neutral-600 ring-1 ring-neutral-200 hover:bg-neutral-50 hover:text-neutral-950 hover:ring-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
      type="button"
      {...props}
    />
  );
}

export function StatusPill({
  children,
  tone = "neutral",
}: PropsWithChildren<{ tone?: "neutral" | "ok" | "warning" | "error" | "info" }>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        tone === "neutral" && "bg-neutral-100 text-neutral-700 ring-neutral-200",
        tone === "ok" && "bg-emerald-50 text-emerald-700 ring-emerald-200",
        tone === "warning" && "bg-amber-50 text-amber-800 ring-amber-200",
        tone === "error" && "bg-red-50 text-red-700 ring-red-200",
        tone === "info" &&
          "bg-[var(--trace-accent-soft)] text-[var(--trace-accent)] ring-[var(--trace-accent-border)]"
      )}
    >
      {children}
    </span>
  );
}
