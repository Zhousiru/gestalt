import type {
  LiveEventEnvelope,
  RolloutStatus,
  RolloutSummary
} from "@gestalt/live-contracts";
import { AlertCircle, Loader2, Radio, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppHeader } from "../components/AppHeader";
import { ConversationTimeline } from "../components/trace/ConversationTimeline";
import { RolloutInspector } from "../components/trace/RolloutInspector";
import { TraceSidebar } from "../components/trace/TraceSidebar";
import {
  IconButton,
  StatusPill,
  Tooltip,
  TooltipProvider,
  cn
} from "../components/ui";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import {
  useConversationTimeline,
  useConversations,
  useOverview,
  useRolloutDetail,
  useRollouts
} from "../hooks/useLiveData";
import { useLiveEvents } from "../hooks/useLiveEvents";

type MobileView = "list" | "timeline" | "detail";
type FocusTarget =
  | "conversation"
  | "sidebarRollout"
  | "timelineBack"
  | "timelineRollout"
  | "inspectorClose";

export default function TraceExplorer() {
  const [query, setQuery] = useState("");
  const [rolloutStatus, setRolloutStatus] = useState<RolloutStatus>();
  const [selectedConversationKey, setSelectedConversationKey] = useState<string>();
  const [selectedRolloutId, setSelectedRolloutId] = useState<string>();
  const [mobileView, setMobileView] = useState<MobileView>("list");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorReturnView, setInspectorReturnView] = useState<MobileView>("list");
  const selectedConversationButtonRef = useRef<HTMLButtonElement>(null);
  const selectedSidebarRolloutButtonRef = useRef<HTMLButtonElement>(null);
  const selectedTimelineRolloutButtonRef = useRef<HTMLButtonElement>(null);
  const timelineBackButtonRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseButtonRef = useRef<HTMLButtonElement>(null);
  const pendingFocusRef = useRef<FocusTarget | null>(null);
  const debouncedQuery = useDebouncedValue(query.trim(), 200);

  const overview = useOverview();
  const conversations = useConversations(debouncedQuery);
  const rollouts = useRollouts(debouncedQuery, rolloutStatus);
  const timeline = useConversationTimeline(selectedConversationKey);
  const rolloutDetail = useRolloutDetail(selectedRolloutId);

  useEffect(() => {
    if (!selectedConversationKey && conversations.items[0]) {
      setSelectedConversationKey(conversations.items[0].key);
    }
  }, [conversations.items, selectedConversationKey]);

  useEffect(() => {
    if (!selectedRolloutId && rollouts.items[0]) {
      setSelectedRolloutId(rollouts.items[0].id);
    }
  }, [rollouts.items, selectedRolloutId]);

  useEffect(() => {
    const target = pendingFocusRef.current;
    if (!target) return;
    const frame = requestAnimationFrame(() => {
      const element = {
        conversation: selectedConversationButtonRef.current,
        sidebarRollout: selectedSidebarRolloutButtonRef.current,
        timelineBack: timelineBackButtonRef.current,
        timelineRollout: selectedTimelineRolloutButtonRef.current,
        inspectorClose: inspectorCloseButtonRef.current
      }[target];
      pendingFocusRef.current = null;
      if (!element || element.getClientRects().length === 0) return;
      element.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [inspectorOpen, mobileView, selectedConversationKey, selectedRolloutId]);

  const openRollout = useCallback((rolloutId: string, returnView: MobileView) => {
    pendingFocusRef.current = "inspectorClose";
    setSelectedRolloutId(rolloutId);
    setInspectorReturnView(returnView);
    setInspectorOpen(true);
    setMobileView("detail");
  }, []);

  const onLiveEvent = useCallback(
    (event: LiveEventEnvelope) => {
      if (event.type === "live.ready" || event.type === "live.heartbeat" || event.type.startsWith("sticker.")) {
        return;
      }
      const target = liveEventTarget(event);
      void overview.reload(true);
      if (target.kind === "conversation" || target.kind === "overview") {
        void conversations.reload(true);
        if (!target.id || target.id === selectedConversationKey) void timeline.reload(true);
      }
      if (target.kind === "rollout" || target.kind === "overview") {
        void rollouts.reload(true);
        if (!target.id || target.id === selectedRolloutId) void rolloutDetail.reload(true);
        if (selectedConversationKey) void timeline.reload(true);
      }
      if (target.kind === "signal") {
        if (target.id === selectedRolloutId) void rolloutDetail.reload(true);
      }
    },
    [
      conversations,
      overview,
      rolloutDetail,
      rollouts,
      selectedConversationKey,
      selectedRolloutId,
      timeline
    ]
  );
  const liveState = useLiveEvents(onLiveEvent);

  const refreshAll = () => {
    void overview.reload();
    void conversations.reload(true);
    void rollouts.reload(true);
    if (selectedConversationKey) void timeline.reload(true);
    if (selectedRolloutId) void rolloutDetail.reload(true);
  };

  const closeInspector = () => {
    pendingFocusRef.current =
      inspectorReturnView === "timeline" ? "timelineRollout" : "sidebarRollout";
    setInspectorOpen(false);
    setMobileView(inspectorReturnView === "detail" ? "list" : inspectorReturnView);
  };

  return (
    <TooltipProvider>
      <main className="grid h-dvh min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--trace-bg)] text-neutral-950" data-trace-explorer>
        <h1 className="sr-only">Gestalt rollout traces</h1>
        <AppHeader
          current="traces"
          actions={
            <>
              <StatusPill tone={liveState === "live" ? "ok" : liveState === "offline" ? "warning" : "info"}>
                <Radio aria-hidden="true" className="mr-1" size={11} />
                {liveState}
              </StatusPill>
              {overview.error ? (
                <StatusPill tone="error">
                  <AlertCircle aria-hidden="true" className="mr-1" size={11} />
                  overview unavailable
                </StatusPill>
              ) : (
                <StatusPill>
                  {overview.data
                    ? `${overview.data.counts.rollouts}${overview.data.counts.rolloutsCapped ? "+" : ""} rollouts`
                    : "loading rollouts"}
                </StatusPill>
              )}
              <StatusPill tone={overview.data?.counts.activeRollouts ? "info" : "neutral"}>
                {overview.data ? `${overview.data.counts.activeRollouts} active` : "loading active"}
              </StatusPill>
              <Tooltip label="Refresh live data">
                <IconButton
                  aria-label="Refresh live trace data"
                  disabled={overview.state === "loading"}
                  onClick={refreshAll}
                >
                  {overview.state === "loading" ? <Loader2 aria-hidden="true" className="animate-spin" size={16} /> : <RefreshCw aria-hidden="true" size={16} />}
                </IconButton>
              </Tooltip>
              <span aria-live="polite" className="sr-only">Live connection is {liveState}</span>
            </>
          }
        />

        <section className="relative grid min-h-0 min-w-0 grid-cols-1 overflow-hidden border-t border-neutral-200 md:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(420px,1fr)_minmax(390px,34vw)]">
          <TraceSidebar
            className={cn(mobileView === "list" ? "grid" : "hidden", "md:grid")}
            conversations={conversations}
            onQueryChange={setQuery}
            onRolloutStatusChange={setRolloutStatus}
            onSelectConversation={(conversation) => {
              pendingFocusRef.current = "timelineBack";
              setSelectedConversationKey(conversation.key);
              setMobileView("timeline");
            }}
            onSelectRollout={(rollout: RolloutSummary) => {
              if (rollout.conversationKey) setSelectedConversationKey(rollout.conversationKey);
              openRollout(rollout.id, "list");
            }}
            overview={overview.data}
            query={query}
            rolloutStatus={rolloutStatus}
            rollouts={rollouts}
            selectedConversationKey={selectedConversationKey}
            selectedConversationButtonRef={selectedConversationButtonRef}
            selectedRolloutId={selectedRolloutId}
            selectedRolloutButtonRef={selectedSidebarRolloutButtonRef}
          />

          <ConversationTimeline
            backButtonRef={timelineBackButtonRef}
            className={cn(mobileView === "timeline" ? "grid" : "hidden", "md:grid")}
            conversation={timeline.conversation}
            error={timeline.error}
            items={timeline.items}
            loadingMore={timeline.loadingMore}
            nextCursor={timeline.nextCursor}
            onBack={() => {
              pendingFocusRef.current = "conversation";
              setMobileView("list");
            }}
            onLoadMore={timeline.loadMore}
            onRetry={() => void timeline.reload()}
            onSelectRollout={(rolloutId) => openRollout(rolloutId, "timeline")}
            selectedRolloutId={selectedRolloutId}
            selectedRolloutButtonRef={selectedTimelineRolloutButtonRef}
            state={timeline.state}
          />

          {inspectorOpen ? (
            <button
              aria-hidden="true"
              className="absolute inset-0 z-20 hidden bg-neutral-950/20 md:block xl:hidden"
              onClick={closeInspector}
              tabIndex={-1}
              type="button"
            />
          ) : null}
          <RolloutInspector
            binaryCaptureEnabled={overview.data?.binaryCaptureEnabled}
            className={cn(
              inspectorOpen || mobileView === "detail"
                ? "absolute inset-0 z-30 grid shadow-[var(--trace-shadow-md)] md:left-auto md:w-[min(520px,calc(100vw-300px))]"
                : "hidden",
              "xl:static xl:z-auto xl:grid xl:w-auto xl:shadow-none"
            )}
            detail={rolloutDetail.data}
            error={rolloutDetail.error}
            onClose={closeInspector}
            closeButtonRef={inspectorCloseButtonRef}
            onRetry={() => void rolloutDetail.reload()}
            selectedRolloutId={selectedRolloutId}
            state={rolloutDetail.state}
          />
        </section>
      </main>
    </TooltipProvider>
  );
}

function liveEventTarget(event: LiveEventEnvelope): {
  kind: "overview" | "conversation" | "rollout" | "signal";
  id?: string | undefined;
} {
  if (event.data.entity) return event.data.entity;
  const data = event.data as Record<string, unknown>;
  const rolloutId = readString(data.rolloutId) ?? readString(data.traceId);
  const conversationKey = readString(data.conversationKey);
  if (rolloutId || event.type.startsWith("agent.") || event.type.startsWith("trace.") || event.type.startsWith("rollout.")) {
    return { kind: "rollout", ...(rolloutId ? { id: rolloutId } : {}) };
  }
  if (conversationKey || event.type.startsWith("session.") || event.type.startsWith("conversation.")) {
    return { kind: "conversation", ...(conversationKey ? { id: conversationKey } : {}) };
  }
  if (event.type.startsWith("signal.") || event.type.startsWith("diagnostic.")) {
    const signalId = readString(data.id);
    return { kind: "signal", ...(signalId ? { id: signalId } : {}) };
  }
  return { kind: "overview" };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}
