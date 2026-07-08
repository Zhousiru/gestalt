import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import type { ButtonHTMLAttributes, ComponentProps, PropsWithChildren, ReactNode } from "react";
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
      className={cn("flex border-b border-slate-300 bg-white", className)}
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
        "border-r border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 outline-none data-[state=active]:bg-slate-950 data-[state=active]:text-white",
        "focus-visible:bg-cyan-100",
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
      className={cn("outline-none focus-visible:ring-2 focus-visible:ring-cyan-400", className)}
      {...props}
    />
  );
}

export function ScrollArea({
  className,
  children,
}: PropsWithChildren<{ className?: string }>) {
  return (
    <ScrollAreaPrimitive.Root className={cn("overflow-hidden", className)}>
      <ScrollAreaPrimitive.Viewport className="h-full w-full">
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar
        className="flex w-2 touch-none border-l border-slate-200 bg-slate-100 p-px"
        orientation="vertical"
      >
        <ScrollAreaPrimitive.Thumb className="flex-1 bg-slate-400" />
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
          className="z-50 border border-slate-950 bg-white px-2 py-1 text-xs text-slate-950 shadow-[3px_3px_0_#0f172a]"
          sideOffset={6}
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-slate-950" />
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
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-slate-950/20" />
        <DialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 grid max-h-[86vh] w-[min(980px,92vw)] -translate-x-1/2 -translate-y-1/2 grid-rows-[auto_minmax(0,1fr)] border border-slate-950 bg-white shadow-[8px_8px_0_#0f172a]">
          <header className="flex items-center justify-between border-b border-slate-300 px-4 py-3">
            <DialogPrimitive.Title className="text-sm font-semibold">
              {title}
            </DialogPrimitive.Title>
            <DialogPrimitive.Close className="grid h-8 w-8 place-items-center border border-slate-300 bg-white text-slate-700 hover:bg-slate-100">
              <X size={16} />
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0">{children}</div>
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
        "grid h-9 w-9 place-items-center border border-slate-300 bg-white text-slate-700 hover:border-slate-950 hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40",
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
        "inline-flex items-center border px-2 py-0.5 text-[11px] font-medium",
        tone === "neutral" && "border-slate-300 bg-white text-slate-600",
        tone === "ok" && "border-emerald-700 bg-emerald-50 text-emerald-800",
        tone === "warning" && "border-amber-700 bg-amber-50 text-amber-800",
        tone === "error" && "border-red-700 bg-red-50 text-red-800",
        tone === "info" && "border-cyan-700 bg-cyan-50 text-cyan-800"
      )}
    >
      {children}
    </span>
  );
}
