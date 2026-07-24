import type { RolloutDetail } from "@gestalt/live-contracts";
import { ArrowLeft, Bot } from "lucide-react";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import type { LoadState } from "../../hooks/useLiveData";
import { shortId, statusTone } from "../../lib/format";
import {
  ScrollArea,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn
} from "../ui";
import { ModelSteps } from "./ModelSteps";
import { RolloutFlow } from "./RolloutFlow";
import { RolloutOverview } from "./RolloutOverview";
import { RolloutRecords } from "./RolloutRecords";
import { EmptyState, ErrorNotice, SkeletonRows } from "./StateViews";

type InspectorTab = "overview" | "model" | "flow" | "records";

export function RolloutInspector({
  selectedRolloutId,
  detail,
  state,
  error,
  binaryCaptureEnabled,
  onRetry,
  onClose,
  closeButtonRef,
  className
}: {
  selectedRolloutId: string | undefined;
  detail: RolloutDetail | undefined;
  state: LoadState;
  error: string | undefined;
  binaryCaptureEnabled: boolean | undefined;
  onRetry: () => void;
  onClose: () => void;
  closeButtonRef?: Ref<HTMLButtonElement> | undefined;
  className?: string;
}) {
  const [tab, setTab] = useState<InspectorTab>("overview");

  useEffect(() => setTab("overview"), [selectedRolloutId]);

  return (
    <aside
      aria-label="Rollout inspector"
      className={cn(
        "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-l border-neutral-200 bg-white",
        className
      )}
    >
      <header className="flex min-h-16 items-center gap-3 border-b border-neutral-200 px-3 py-2.5 sm:px-4">
        <button
          aria-label="Close rollout inspector"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-neutral-600 outline-none hover:bg-neutral-100 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] xl:hidden"
          onClick={onClose}
          ref={closeButtonRef}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={17} />
        </button>
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-600 ring-1 ring-inset ring-neutral-200">
          <Bot aria-hidden="true" size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-neutral-950">Rollout inspector</h2>
          <p className="mt-0.5 truncate font-mono text-[11px] text-neutral-600" title={selectedRolloutId}>
            {selectedRolloutId ? shortId(selectedRolloutId, 24) : "No rollout selected"}
          </p>
        </div>
        {detail ? <StatusPill tone={statusTone(detail.summary.status)}>{detail.summary.status}</StatusPill> : null}
      </header>

      {!selectedRolloutId ? (
        <EmptyState description="Choose a rollout from the list or a conversation timeline to inspect it." title="Select a rollout" />
      ) : state === "loading" && !detail ? (
        <SkeletonRows rows={7} />
      ) : state === "error" && !detail ? (
        <ErrorNotice message={error ?? "Unknown error"} onRetry={onRetry} />
      ) : detail ? (
        <Tabs className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]" onValueChange={(value) => setTab(value as InspectorTab)} value={tab}>
          <TabsList aria-label="Rollout detail">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="model">Model</TabsTrigger>
            <TabsTrigger value="flow">Flow</TabsTrigger>
            <TabsTrigger value="records">Records</TabsTrigger>
          </TabsList>
          {error ? <ErrorNotice compact message={error} onRetry={onRetry} /> : null}
          <InspectorContent value="overview"><RolloutOverview binaryCaptureEnabled={binaryCaptureEnabled} detail={detail} /></InspectorContent>
          <TabsContent className="min-h-0 overflow-hidden" value="model">
            <ModelSteps detail={detail} />
          </TabsContent>
          <InspectorContent value="flow"><RolloutFlow detail={detail} /></InspectorContent>
          <InspectorContent value="records"><RolloutRecords detail={detail} /></InspectorContent>
        </Tabs>
      ) : null}
    </aside>
  );
}

function InspectorContent({ value, children }: { value: InspectorTab; children: ReactNode }) {
  return (
    <TabsContent className="min-h-0 overflow-hidden" value={value}>
      <ScrollArea className="h-full">{children}</ScrollArea>
    </TabsContent>
  );
}
