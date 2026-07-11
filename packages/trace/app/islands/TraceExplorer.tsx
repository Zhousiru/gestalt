import {
  Activity,
  AlertTriangle,
  ArrowDown,
  Bot,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  MessageSquare,
  MousePointer2,
  Radio,
  RefreshCw,
  Search,
  XCircle
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { allExpanded, collapseAllNested, darkStyles, JsonView } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import {
  Dialog,
  IconButton,
  ScrollArea,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Tooltip,
  TooltipProvider,
  cn
} from "../components/ui";
import type {
  AgentTurnTrace,
  ConversationView,
  Diagnostic,
  EventTimelineItem,
  ObservationRecord,
  TimelineItem,
  TraceDetail,
  TraceSummary,
  TraceWorkspace,
  TurnTimelineItem,
  WaterfallSpan,
  RuntimeLiveEventEnvelope
} from "../lib/types";

type LoadState = "loading" | "ready" | "error";

const panelClass =
  "min-w-0 overflow-hidden bg-white";
const cardClass =
  "min-w-0 rounded-md bg-white ring-1 ring-neutral-200";
const mutedCardClass = "min-w-0 rounded-md bg-neutral-50 ring-1 ring-neutral-200";
const selectedCardClass =
  "bg-neutral-50 text-neutral-950 ring-1 ring-[var(--trace-accent)]";
const focusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1";
const jsonViewStyles = {
  ...darkStyles,
  container: "trace-json-view",
  childFieldsContainer: "trace-json-children"
};

export default function TraceExplorer() {
  const [workspace, setWorkspace] = useState<TraceWorkspace | undefined>();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | undefined>();
  const [liveState, setLiveState] = useState<"connecting" | "live" | "offline">(
    "connecting"
  );
  const [query, setQuery] = useState("");
  const [selectedConversationKey, setSelectedConversationKey] = useState<string | undefined>();
  const [selectedTraceId, setSelectedTraceId] = useState<string | undefined>();
  const [traceDetail, setTraceDetail] = useState<TraceDetail | undefined>();
  const [traceLoading, setTraceLoading] = useState(false);
  const [mounted, setMounted] = useState(false);

  const loadSnapshot = async () => {
    setLoadState((state) => (state === "ready" ? state : "loading"));
    try {
      const response = await fetch("/api/live/snapshot", { cache: "no-store" });
      if (!response.ok) {
        throw new Error(`Snapshot request failed with ${response.status}`);
      }
      const nextWorkspace = (await response.json()) as TraceWorkspace;
      setWorkspace(nextWorkspace);
      setLoadState("ready");
      setError(undefined);
    } catch (snapshotError) {
      setLoadState("error");
      setError(snapshotError instanceof Error ? snapshotError.message : String(snapshotError));
    }
  };

  const loadTraceDetail = async (traceId: string, quiet = false) => {
    if (!quiet) {
      setTraceLoading(true);
    }
    try {
      const response = await fetch(`/api/live/traces/${encodeURIComponent(traceId)}`, {
        cache: "no-store"
      });
      if (!response.ok) {
        throw new Error(`Trace request failed with ${response.status}`);
      }
      setTraceDetail((await response.json()) as TraceDetail);
    } catch (detailError) {
      if (!quiet) {
        setTraceDetail(undefined);
      }
      setError(detailError instanceof Error ? detailError.message : String(detailError));
    } finally {
      if (!quiet) {
        setTraceLoading(false);
      }
    }
  };

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    const source = new EventSource("/api/live/events");
    source.addEventListener("live", (event) => {
      setLiveState("live");
      const envelope = parseLiveEvent(event);
      if (!envelope || envelope.type === "live.ready" || envelope.type === "live.heartbeat") {
        return;
      }
      void loadSnapshot();
      if (selectedTraceId && eventTouchesTrace(envelope, selectedTraceId)) {
        void loadTraceDetail(selectedTraceId, true);
      }
    });
    source.onerror = () => {
      setLiveState("offline");
    };
    return () => {
      source.close();
    };
  }, [selectedTraceId]);

  useEffect(() => {
    if (!workspace) {
      return;
    }
    if (
      selectedConversationKey &&
      workspace.conversations.some((conversation) => conversation.key === selectedConversationKey)
    ) {
      return;
    }
    setSelectedConversationKey(workspace.conversations[0]?.key);
  }, [workspace, selectedConversationKey]);

  useEffect(() => {
    if (!workspace || selectedTraceId) {
      return;
    }
    setSelectedTraceId(workspace.traces[0]?.id);
  }, [workspace, selectedTraceId]);

  useEffect(() => {
    if (!selectedTraceId) {
      setTraceDetail(undefined);
      return;
    }
    void loadTraceDetail(selectedTraceId);
  }, [selectedTraceId]);

  const selectedConversation = useMemo(
    () =>
      workspace?.conversations.find(
        (conversation) => conversation.key === selectedConversationKey
      ),
    [workspace, selectedConversationKey]
  );

  const visibleConversations = useMemo(
    () =>
      filterConversations(workspace?.conversations ?? [], query),
    [workspace, query]
  );
  const visibleTraces = useMemo(
    () => filterTraces(workspace?.traces ?? [], query),
    [workspace, query]
  );
  const visibleDiagnostics = useMemo(
    () => filterDiagnostics(workspace?.diagnostics ?? [], query),
    [workspace, query]
  );

  if (!mounted) {
    return <BootShell />;
  }

  return (
    <TooltipProvider>
      <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] bg-[var(--trace-bg)] text-neutral-950">
        <Header
          workspace={workspace}
          liveState={liveState}
          loadState={loadState}
          onRefresh={() => void loadSnapshot()}
        />
        <section className="grid min-h-0 max-w-full grid-cols-1 overflow-auto border-t border-neutral-200 lg:grid-cols-[308px_minmax(430px,1fr)_minmax(390px,35vw)] lg:overflow-hidden">
          <Sidebar
            query={query}
            setQuery={setQuery}
            conversations={visibleConversations}
            traces={visibleTraces}
            diagnostics={visibleDiagnostics}
            selectedConversationKey={selectedConversationKey}
            selectedTraceId={selectedTraceId}
            onSelectConversation={setSelectedConversationKey}
            onSelectTrace={setSelectedTraceId}
          />
          <TimelinePanel
            conversation={selectedConversation}
            selectedTraceId={selectedTraceId}
            onSelectTrace={setSelectedTraceId}
            loading={loadState === "loading"}
            error={loadState === "error" ? error : undefined}
          />
          <TraceDetailPanel
            detail={traceDetail}
            selectedTraceId={selectedTraceId}
            loading={traceLoading}
          />
        </section>
      </main>
    </TooltipProvider>
  );
}

function BootShell() {
  return (
    <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] bg-[var(--trace-bg)] text-neutral-950">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-[var(--trace-accent)] text-white">
            <Activity size={18} />
          </div>
          <h1 className="text-base font-semibold">Gestalt Trace</h1>
        </div>
        <StatusPill tone="info">connecting</StatusPill>
      </header>
      <section className="grid place-items-center p-6">
        <div className="rounded-md bg-white p-6 text-sm text-neutral-500 ring-1 ring-neutral-200">
          Loading trace workspace
        </div>
      </section>
    </main>
  );
}

function Header({
  workspace,
  liveState,
  loadState,
  onRefresh,
}: {
  workspace: TraceWorkspace | undefined;
  liveState: "connecting" | "live" | "offline";
  loadState: LoadState;
  onRefresh: () => void;
}) {
  return (
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 border-b border-neutral-200 bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-md bg-[var(--trace-accent)] text-white">
            <Activity size={18} />
          </div>
          <h1 className="text-base font-semibold">Gestalt Trace</h1>
        </div>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
        <StatusPill tone={liveState === "live" ? "ok" : liveState === "offline" ? "error" : "info"}>
          <Radio size={12} className="mr-1" />
          {liveState}
        </StatusPill>
        <StatusPill tone={loadState === "error" ? "error" : "neutral"}>
          {workspace ? `${workspace.traceCount} traces` : "no traces"}
        </StatusPill>
        <StatusPill tone={workspace?.activeRunCount ? "info" : "neutral"}>
          {workspace ? `${workspace.activeRunCount} active` : "no active"}
        </StatusPill>
        <StatusPill tone="neutral">
          {workspace ? `${workspace.sessionExportCount} sessions` : "no sessions"}
        </StatusPill>
        <Tooltip label="Refresh snapshot">
          <IconButton onClick={onRefresh} disabled={loadState === "loading"}>
            {loadState === "loading" ? (
              <Loader2 size={16} />
            ) : (
              <RefreshCw size={16} />
            )}
          </IconButton>
        </Tooltip>
      </div>
    </header>
  );
}

function Sidebar({
  query,
  setQuery,
  conversations,
  traces,
  diagnostics,
  selectedConversationKey,
  selectedTraceId,
  onSelectConversation,
  onSelectTrace,
}: {
  query: string;
  setQuery: (query: string) => void;
  conversations: ConversationView[];
  traces: TraceSummary[];
  diagnostics: Diagnostic[];
  selectedConversationKey: string | undefined;
  selectedTraceId: string | undefined;
  onSelectConversation: (key: string) => void;
  onSelectTrace: (id: string) => void;
}) {
  return (
    <aside className={cn(panelClass, "grid min-h-[320px] grid-rows-[auto_minmax(0,1fr)] border-b border-neutral-200 lg:min-h-0 lg:border-b-0 lg:border-r")}>
      <div className="border-b border-neutral-200 p-3">
        <label className="flex h-10 items-center rounded-md bg-neutral-50 px-3 text-sm ring-1 ring-neutral-200 focus-within:bg-white focus-within:ring-2 focus-within:ring-[var(--trace-accent)]">
          <Search size={15} className="mr-2 text-neutral-500" />
          <input
            className="min-w-0 flex-1 bg-transparent text-neutral-900 outline-none placeholder:text-neutral-500"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
          />
        </label>
      </div>
      <Tabs defaultValue="conversations" className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
        <TabsList>
          <TabsTrigger value="conversations">Chats</TabsTrigger>
          <TabsTrigger value="traces">Runs</TabsTrigger>
          <TabsTrigger value="diagnostics">Signals</TabsTrigger>
        </TabsList>
        <TabsContent value="conversations" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full w-full min-w-0 max-w-full">
            <div className="w-full min-w-0 max-w-full space-y-1 overflow-hidden p-2">
              {conversations.map((conversation) => (
                <button
                  key={conversation.key}
                  className={cn(
                    "block w-full min-w-0 max-w-full overflow-hidden rounded-md px-3 py-3 text-left hover:bg-neutral-50",
                    focusClass,
                    selectedConversationKey === conversation.key && "bg-neutral-50 text-neutral-950 ring-1 ring-[var(--trace-accent)] hover:bg-neutral-50"
                  )}
                  type="button"
                  onClick={() => onSelectConversation(conversation.key)}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-xs" title={conversation.key}>
                      {conversation.key}
                    </span>
                    <SeverityDot diagnostics={conversation.diagnostics} />
                  </div>
                  <p className={cn("mt-2 line-clamp-2 text-xs leading-5 [overflow-wrap:anywhere]", selectedConversationKey === conversation.key ? "text-neutral-700" : "text-neutral-500")}>
                    {conversation.lastText ?? "No messages"}
                  </p>
                  <div className={cn("mt-2 flex flex-wrap gap-2 font-mono text-[11px]", selectedConversationKey === conversation.key ? "text-[var(--trace-accent)]" : "text-neutral-500")}>
                    <span>{conversation.eventCount} evt</span>
                    <span>{conversation.turnCount} run</span>
                    <span>{conversation.loopExitCount} exit</span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="traces" className="min-h-0 min-w-0 overflow-hidden">
          <ScrollArea className="h-full w-full min-w-0 max-w-full">
            <div className="w-full min-w-0 max-w-full space-y-1 overflow-hidden p-2">
              {traces.map((trace) => (
                <button
                  key={trace.id}
                  className={cn(
                    "block w-full min-w-0 max-w-full overflow-hidden rounded-md px-3 py-3 text-left hover:bg-neutral-50",
                    focusClass,
                    selectedTraceId === trace.id && "bg-neutral-50 text-neutral-950 ring-1 ring-[var(--trace-accent)] hover:bg-neutral-50"
                  )}
                  type="button"
                  onClick={() => onSelectTrace(trace.id)}
                >
                  <div className="flex min-w-0 items-center justify-between gap-2">
                    <span className="font-mono text-xs">{trace.shortId}</span>
                    <StatusIcon status={trace.status} />
                  </div>
                  <p
                    className={cn("mt-2 truncate text-xs", selectedTraceId === trace.id ? "text-neutral-700" : "text-neutral-500")}
                    title={`${trace.phase ? `${trace.phase} · ` : ""}${trace.actionNames.join(", ") || "no action"}`}
                  >
                    {trace.phase ? `${trace.phase} · ` : ""}
                    {trace.actionNames.join(", ") || "no action"}
                  </p>
                  <div className={cn("mt-2 flex min-w-0 max-w-full items-center gap-2 overflow-hidden font-mono text-[11px]", selectedTraceId === trace.id ? "text-[var(--trace-accent)]" : "text-neutral-500")}>
                    <Clock size={12} />
                    <span>{formatDuration(trace.durationMs)}</span>
                    {trace.model ? (
                      <span className="min-w-0 flex-1 truncate" title={trace.model}>{trace.model}</span>
                    ) : null}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="diagnostics" className="min-h-0 min-w-0">
          <ScrollArea className="h-full min-w-0">
            <DiagnosticList diagnostics={diagnostics} compact onSelectTrace={onSelectTrace} />
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function TimelinePanel({
  conversation,
  selectedTraceId,
  onSelectTrace,
  loading,
  error,
}: {
  conversation: ConversationView | undefined;
  selectedTraceId: string | undefined;
  onSelectTrace: (id: string) => void;
  loading: boolean;
  error: string | undefined;
}) {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);
  const timelineTail =
    conversation?.timeline.at(-1)?.id ?? conversation?.key ?? "empty";

  useEffect(() => {
    setStickToBottom(true);
  }, [conversation?.key]);

  useEffect(() => {
    if (!stickToBottom) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
  }, [stickToBottom, timelineTail, loading, error]);

  const handleTimelineScroll = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    const distanceFromBottom =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    setStickToBottom(distanceFromBottom < 48);
  };

  const scrollToLatest = () => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "auto"
    });
    setStickToBottom(true);
  };

  return (
    <section className={cn(panelClass, "relative grid min-h-[640px] grid-rows-[auto_minmax(0,1fr)] border-b border-neutral-200 bg-neutral-50 lg:min-h-0 lg:border-b-0 lg:border-r")}>
      <header className="border-b border-neutral-200 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-neutral-500">Session replay</p>
            <h2 className="truncate text-base font-semibold">
              {conversation?.key ?? "No conversation"}
            </h2>
          </div>
          {conversation ? (
            <div className="flex shrink-0 flex-wrap justify-end gap-2">
              <StatusPill tone="neutral">{conversation.eventCount} events</StatusPill>
              <StatusPill tone="neutral">{conversation.turnCount} runs</StatusPill>
              <StatusPill tone={conversation.diagnostics.some((item) => item.severity === "error") ? "error" : conversation.diagnostics.length ? "warning" : "ok"}>
                {conversation.diagnostics.length} signals
              </StatusPill>
            </div>
          ) : null}
        </div>
      </header>
      <ScrollArea
        className="min-h-0"
        viewportRef={viewportRef}
        onViewportScroll={handleTimelineScroll}
      >
        <div className="mx-auto max-w-5xl min-w-0 px-4 py-5 sm:px-5">
          {loading ? <EmptyState icon={<Loader2 />} title="Loading" /> : null}
          {error ? <EmptyState icon={<XCircle />} title={error} tone="error" /> : null}
          {!loading && !error && !conversation ? (
            <EmptyState icon={<MessageSquare />} title="No session snapshot" />
          ) : null}
          {conversation ? (
            <div className="space-y-3">
              {conversation.timeline.map((item) => (
                <TimelineRow
                  key={`${item.type}:${item.id}`}
                  item={item}
                  selectedTraceId={selectedTraceId}
                  onSelectTrace={onSelectTrace}
                />
              ))}
            </div>
          ) : null}
        </div>
      </ScrollArea>
      {!stickToBottom && conversation ? (
        <Tooltip label="Jump to latest">
          <IconButton
            className="absolute bottom-4 right-4 z-10 bg-white shadow-[var(--trace-shadow-sm)]"
            onClick={scrollToLatest}
          >
            <ArrowDown size={16} />
          </IconButton>
        </Tooltip>
      ) : null}
    </section>
  );
}

function TimelineRow({
  item,
  selectedTraceId,
  onSelectTrace,
}: {
  item: TimelineItem;
  selectedTraceId: string | undefined;
  onSelectTrace: (id: string) => void;
}) {
  if (item.type === "event") {
    return <EventRow item={item} />;
  }
  if (item.type === "turn") {
    return (
      <TurnRow
        item={item}
        selected={selectedTraceId === item.traceId}
        onSelectTrace={onSelectTrace}
      />
    );
  }
  if (item.type === "window") {
    return (
      <ThinRow
        icon={<MousePointer2 size={14} />}
        title={`window:${item.reason}`}
        meta={`seq ${item.fromSeq}-${item.toSeq}`}
        at={item.at}
      />
    );
  }
  return (
    <ThinRow
      icon={<Clock size={14} />}
      title={`exit:${item.reason}`}
      meta={item.description ?? item.triggerName}
      at={item.at}
    />
  );
}

function EventRow({ item }: { item: EventTimelineItem }) {
  return (
    <article className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-3 sm:grid-cols-[92px_minmax(0,1fr)]">
      <TimeCell at={item.at} />
      <div
        className={cn(
          cardClass,
          "p-3",
          item.isSelf && "bg-neutral-50 ring-neutral-200"
        )}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "grid h-7 w-7 shrink-0 place-items-center rounded-md",
                item.isSelf
                  ? "bg-white text-[var(--trace-accent)] ring-1 ring-[var(--trace-accent-border)]"
                  : "bg-neutral-100 text-neutral-500"
              )}
            >
              {item.isSelf ? <Bot size={15} /> : <MessageSquare size={15} />}
            </span>
            <span className="truncate text-sm font-medium">
              {item.senderName ?? item.senderId ?? "unknown"}
            </span>
            <span className="font-mono text-xs text-neutral-500">seq {item.seq}</span>
          </div>
          <div className="flex shrink-0 gap-2">
            {item.mentionsBot ? <StatusPill tone="info">mention</StatusPill> : null}
            {item.source ? <StatusPill tone="neutral">{item.source}</StatusPill> : null}
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
          {item.text}
        </p>
        <div className="mt-3 flex min-w-0 flex-wrap gap-3 font-mono text-[11px] text-neutral-500">
          <span className="min-w-0 break-all">{item.eventId}</span>
          {item.messageId ? (
            <span className="min-w-0 break-all">message {item.messageId}</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

function TurnRow({
  item,
  selected,
  onSelectTrace,
}: {
  item: TurnTimelineItem;
  selected: boolean;
  onSelectTrace: (id: string) => void;
}) {
  return (
    <article className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-3 sm:grid-cols-[92px_minmax(0,1fr)]">
      <TimeCell at={item.at} />
      <button
        className={cn(
          cardClass,
          "p-3 text-left hover:bg-neutral-50 hover:ring-neutral-300",
          focusClass,
          selected && selectedCardClass
        )}
        type="button"
        onClick={() => onSelectTrace(item.traceId)}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span
              className={cn(
                "grid h-7 w-7 place-items-center rounded-md",
                selected
                  ? "bg-white text-[var(--trace-accent)] ring-1 ring-[var(--trace-accent-border)]"
                  : "bg-neutral-100 text-neutral-600"
              )}
            >
              <Activity size={15} />
            </span>
            <span className="break-all font-mono text-xs">run {item.shortTraceId}</span>
            {!item.hasTrace ? <StatusPill tone="warning">missing trace</StatusPill> : null}
            {item.isActive ? <StatusPill tone="info">active</StatusPill> : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <StatusPill tone={item.diagnostics.some((diag) => diag.severity === "error") ? "error" : item.diagnostics.length ? "warning" : "ok"}>
              {item.status}
            </StatusPill>
            <StatusPill tone="neutral">{formatDuration(item.durationMs)}</StatusPill>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2 text-xs text-neutral-600">
          {(item.actionNames.length ? item.actionNames : ["no action"]).map((action) => (
            <span key={action} className="max-w-full break-all rounded-md bg-neutral-100 px-2 py-1 text-neutral-700 ring-1 ring-neutral-200">
              {action}
            </span>
          ))}
          {item.toolStatuses.map((status, index) => (
            <span key={`${status}:${index}`} className="max-w-full break-all rounded-md bg-neutral-100 px-2 py-1 text-neutral-700 ring-1 ring-neutral-200">
              {status}
            </span>
          ))}
        </div>
        {item.diagnostics.length ? (
          <div className="mt-3 space-y-1 text-xs text-amber-800">
            {item.diagnostics.slice(0, 2).map((diagnostic) => (
              <p key={diagnostic.id} className="[overflow-wrap:anywhere]">
                {diagnostic.title}
              </p>
            ))}
          </div>
        ) : null}
      </button>
    </article>
  );
}

function ThinRow({
  icon,
  title,
  meta,
  at,
}: {
  icon: ReactNode;
  title: string;
  meta: string;
  at: string;
}) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-3 sm:grid-cols-[92px_minmax(0,1fr)]">
      <TimeCell at={at} />
      <div className={cn(mutedCardClass, "flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-neutral-600")}>
        <span className="grid h-6 w-6 place-items-center rounded-md bg-white text-neutral-500 ring-1 ring-neutral-200">
          {icon}
        </span>
        <span className="break-all font-mono">{title}</span>
        <span className="min-w-0 [overflow-wrap:anywhere]">{meta}</span>
      </div>
    </div>
  );
}

function TimeCell({ at }: { at: string }) {
  return (
    <div className="pt-3 text-right font-mono text-[10px] leading-4 text-neutral-500 sm:text-[11px]">
      <div>{formatTime(at)}</div>
      <div>{formatDate(at)}</div>
    </div>
  );
}

function TraceDetailPanel({
  detail,
  selectedTraceId,
  loading,
}: {
  detail: TraceDetail | undefined;
  selectedTraceId: string | undefined;
  loading: boolean;
}) {
  return (
    <aside className={cn(panelClass, "grid min-h-[640px] grid-rows-[auto_minmax(0,1fr)] lg:min-h-0")}>
      <header className="border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-neutral-500">Agent run</p>
            <h2 className="truncate text-base font-semibold">
              {detail?.summary.shortId ?? selectedTraceId?.slice(0, 8) ?? "No run"}
            </h2>
          </div>
          {detail ? (
            <div className="flex shrink-0 gap-2">
              <StatusPill tone={statusTone(detail.summary.status)}>
                {detail.summary.status}
              </StatusPill>
              <CopyButton value={detail.summary.id} />
            </div>
          ) : null}
        </div>
      </header>
      <div className="min-h-0">
        {loading ? <EmptyState icon={<Loader2 />} title="Loading run" /> : null}
        {!loading && !detail ? (
          <EmptyState icon={<Activity />} title="No run selected" />
        ) : null}
        {detail ? <RunDetail detail={detail} /> : null}
      </div>
    </aside>
  );
}

function RunDetail({ detail }: { detail: TraceDetail }) {
  return (
    <Tabs defaultValue="summary" className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
      <TabsList>
        <TabsTrigger value="summary">Run</TabsTrigger>
        <TabsTrigger value="model">Model</TabsTrigger>
        <TabsTrigger value="waterfall">Flow</TabsTrigger>
        <TabsTrigger value="evidence">Logs</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>
      <TabsContent value="summary" className="min-h-0 min-w-0">
        <ScrollArea className="h-full min-w-0">
          <div className="space-y-4 p-4">
            <MetricGrid detail={detail} />
            <DiagnosticList diagnostics={detail.diagnostics} />
            <ActionList trace={detail.trace} />
            {detail.relatedEvent ? <RelatedEvent event={detail.relatedEvent} /> : null}
          </div>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="model" className="min-h-0 min-w-0">
        <div className="h-full min-h-0 min-w-0 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
          <ModelIoPanel trace={detail.trace} diagnostics={detail.diagnostics} />
        </div>
      </TabsContent>
      <TabsContent value="waterfall" className="min-h-0 min-w-0">
        <ScrollArea className="h-full min-w-0">
          <Waterfall spans={detail.waterfall} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="evidence" className="min-h-0 min-w-0">
        <ScrollArea className="h-full min-w-0">
          <ObservationList observations={detail.trace.observations ?? []} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="raw" className="min-h-0 min-w-0">
        <ScrollArea className="h-full min-w-0">
          <JsonBlock value={detail.trace} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
  );
}

interface ModelStepView {
  id: string;
  requestIndex: number;
  stepNumber: number;
  purpose: string;
  model: string | undefined;
  provider: string | undefined;
  sessionId: string | undefined;
  promptCacheEnabled: boolean | undefined;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  temperature: number | undefined;
  finishReason: string | undefined;
  startedAt: string | undefined;
  endedAt: string | undefined;
  durationMs: number;
  messages: ModelMessageView[];
  tools: unknown[];
  toolChoice: string | undefined;
  outputContent: string | undefined;
  reasoning: string | undefined;
  toolCalls: unknown[];
  toolResults: unknown[];
  usage: unknown | undefined;
  requestBody: unknown | undefined;
  responseBody: unknown | undefined;
  source: "generation" | "span";
  observation: ObservationRecord | undefined;
}

interface ModelMessageView {
  role: string;
  content: string;
  markers: string[];
}

type PromptViewMode = "delta" | "full";

interface PromptDelta {
  kind: "initial" | "appended" | "changed" | "unchanged";
  messages: ModelMessageView[];
  reusedCount: number;
  replacedCount: number;
}

function ModelIoPanel({
  trace,
  diagnostics
}: {
  trace: AgentTurnTrace;
  diagnostics: Diagnostic[];
}) {
  const [promptView, setPromptView] = useState<PromptViewMode>("delta");
  const steps = collectModelSteps(trace);
  const silentDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.code === "silent_model_stop"
  );

  if (!steps.length) {
    return (
      <div className="p-4">
        <EmptyState icon={<Braces />} title="No model I/O captured" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <section className={cn(cardClass, "overflow-hidden")}>
        <div className="p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold">Model I/O</h3>
              <p className="mt-1 text-xs text-neutral-500">
                {steps.length} model step{steps.length === 1 ? "" : "s"} · prompt changes shown by default
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <PromptViewToggle value={promptView} onChange={setPromptView} />
              <StatusPill tone={silentDiagnostics.length ? "warning" : "neutral"}>
                {silentDiagnostics.length ? "silent output" : "captured"}
              </StatusPill>
            </div>
          </div>
          {silentDiagnostics.map((diagnostic) => (
            <div
              key={diagnostic.id}
              className="mt-3 rounded-md bg-amber-50 p-3 text-xs leading-5 text-amber-950 ring-1 ring-amber-200 [overflow-wrap:anywhere]"
            >
              {diagnostic.message}
            </div>
          ))}
        </div>
        <ModelSessionOverview steps={steps} />
      </section>

      {groupModelSteps(steps).map((group) => (
        <section key={group.id} className="space-y-2">
          <div className="flex min-w-0 items-center justify-between gap-3 px-1">
            <div className="flex min-w-0 items-center gap-2">
              <StatusPill tone={purposeTone(group.purpose)}>
                {purposeLabel(group.purpose)}
              </StatusPill>
              <span className="text-xs text-neutral-500">
                {group.steps.length} request{group.steps.length === 1 ? "" : "s"}
              </span>
            </div>
            <span className="font-mono text-[11px] text-neutral-500">
              {cacheGroupLabel(group.steps)}
            </span>
          </div>
          {group.steps.map((step) => {
            const stepIndex = steps.indexOf(step);
            return (
              <ModelStepCard
                key={step.id}
                step={step}
                previousStep={stepIndex > 0 ? steps[stepIndex - 1] : undefined}
                promptView={promptView}
              />
            );
          })}
        </section>
      ))}
    </div>
  );
}

function PromptViewToggle({
  value,
  onChange
}: {
  value: PromptViewMode;
  onChange: (value: PromptViewMode) => void;
}) {
  return (
    <div
      className="inline-flex rounded-md bg-neutral-100 p-0.5 ring-1 ring-inset ring-neutral-200"
      aria-label="Prompt view"
    >
      {(["delta", "full"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={cn(
            "rounded px-2 py-1 text-[11px] font-medium text-neutral-600 outline-none hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
            value === mode && "bg-white text-neutral-950 shadow-sm"
          )}
          aria-pressed={value === mode}
          onClick={() => onChange(mode)}
        >
          {mode === "delta" ? "Changes" : "Full prompt"}
        </button>
      ))}
    </div>
  );
}

function ModelSessionOverview({ steps }: { steps: ModelStepView[] }) {
  const sessionIds = Array.from(
    new Set(
      steps
        .map((step) => step.sessionId)
        .filter((value): value is string => Boolean(value))
    )
  );
  const cacheReadTokens = steps.reduce(
    (total, step) => total + step.cacheReadTokens,
    0
  );
  const cacheHits = steps.filter((step) => step.cacheReadTokens > 0).length;
  const firstDreamingIndex = steps.findIndex(
    (step) => step.purpose === "dreaming"
  );
  const firstDreaming =
    firstDreamingIndex >= 0 ? steps[firstDreamingIndex] : undefined;
  const lastAction =
    firstDreamingIndex >= 0
      ? steps
          .slice(0, firstDreamingIndex)
          .filter((step) => step.purpose === "agent_action")
          .at(-1)
      : undefined;
  const hasContinuation = Boolean(firstDreaming && lastAction);
  const prefixPreserved =
    hasContinuation && firstDreaming && lastAction
      ? hasMessagePrefix(firstDreaming.messages, lastAction.messages)
      : undefined;
  const protocolStable =
    hasContinuation && firstDreaming && lastAction
      ? toolProtocolKey(firstDreaming.tools) === toolProtocolKey(lastAction.tools)
      : undefined;
  const sameSession =
    hasContinuation &&
    sessionIds.length === 1 &&
    steps.every((step) => step.sessionId === sessionIds[0]);
  const continuationHealthy =
    hasContinuation && sameSession && prefixPreserved && protocolStable;

  return (
    <div className="border-t border-neutral-200 bg-neutral-50/70 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <StatusPill
          tone={
            continuationHealthy
              ? "ok"
              : hasContinuation
                ? "warning"
                : "neutral"
          }
        >
          {continuationHealthy
            ? "continuous session"
            : hasContinuation
              ? "continuation incomplete"
              : "single phase"}
        </StatusPill>
        {steps.some((step) => step.promptCacheEnabled === true) ? (
          <StatusPill tone={cacheHits > 0 ? "ok" : "warning"}>
            cache {cacheHits}/{steps.length} hit
          </StatusPill>
        ) : steps.some((step) => step.promptCacheEnabled === false) ? (
          <StatusPill tone="neutral">cache disabled</StatusPill>
        ) : (
          <StatusPill tone="neutral">cache metadata unavailable</StatusPill>
        )}
      </div>

      <dl className="mt-3 grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <SessionDatum
          label="session"
          value={
            sessionIds.length === 1
              ? shortId(sessionIds[0]!)
              : sessionIds.length > 1
                ? `${sessionIds.length} ids`
                : "legacy trace"
          }
          title={sessionIds.join(", ")}
        />
        <SessionDatum
          label="cache read"
          value={formatTokenCount(cacheReadTokens)}
        />
        <SessionDatum
          label="action → dreaming"
          value={
            hasContinuation
              ? `${prefixPreserved ? "prefix kept" : "prefix changed"} · ${
                  protocolStable ? "protocol stable" : "protocol changed"
                }`
              : "not present"
          }
        />
        <SessionDatum
          label="first dream cache"
          value={
            firstDreaming
              ? !hasCacheMetadata(firstDreaming)
                ? "unknown"
                : firstDreaming.cacheReadTokens > 0
                ? `${formatTokenCount(firstDreaming.cacheReadTokens)} hit`
                : "miss"
              : "not present"
          }
        />
      </dl>
    </div>
  );
}

function SessionDatum({
  label,
  value,
  title
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] font-medium uppercase text-neutral-500">
        {label}
      </dt>
      <dd
        className="mt-1 truncate font-mono text-[11px] text-neutral-800"
        title={title ?? value}
      >
        {value}
      </dd>
    </div>
  );
}

function ModelStepCard({
  step,
  previousStep,
  promptView
}: {
  step: ModelStepView;
  previousStep: ModelStepView | undefined;
  promptView: PromptViewMode;
}) {
  const usage = summarizeUsage(step.usage);
  const promptDelta = getPromptDelta(step, previousStep);
  const isSilentText =
    step.finishReason === "stop" &&
    Boolean(step.outputContent) &&
    step.toolCalls.length === 0;
  const hasRawPayload =
    step.requestBody !== undefined || step.responseBody !== undefined;

  return (
    <details className={cn(cardClass, "group scroll-mb-8")}>
      <summary className={cn("model-step-summary flex min-w-0 cursor-pointer items-center gap-3 p-3 hover:bg-neutral-50", focusClass)}>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-500">
          <ChevronRight size={15} className="group-open:hidden" />
          <ChevronDown size={15} className="hidden group-open:block" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={purposeTone(step.purpose)}>
              {purposeLabel(step.purpose)}
            </StatusPill>
            <StatusPill tone="neutral">request {step.requestIndex}</StatusPill>
            <StatusPill tone="neutral">step {step.stepNumber}</StatusPill>
            <StatusPill tone={step.source === "generation" ? "ok" : "warning"}>
              {step.source}
            </StatusPill>
            {step.promptCacheEnabled === true ? (
              <StatusPill tone={step.cacheReadTokens > 0 ? "ok" : "neutral"}>
                {step.cacheReadTokens > 0
                  ? `cache ${formatTokenCount(step.cacheReadTokens)}`
                  : "cache miss"}
              </StatusPill>
            ) : null}
            {step.finishReason ? (
              <StatusPill tone={isSilentText ? "warning" : "neutral"}>
                {step.finishReason}
              </StatusPill>
            ) : null}
          </div>
          <p className="mt-2 truncate font-mono text-xs text-neutral-700" title={step.model ?? "unknown model"}>
            {step.model ?? "unknown model"}
          </p>
          {step.provider ? (
            <p className="mt-1 truncate font-mono text-[11px] text-neutral-500" title={step.provider}>
              {step.provider}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right font-mono text-[11px] text-neutral-500">
          <p>{formatDuration(step.durationMs)}</p>
          <p className="mt-1 max-w-28 truncate" title={usage.tokens}>{usage.tokens}</p>
        </div>
      </summary>

      <div className="border-t border-neutral-200">
        <div className="p-3">
          {hasRawPayload ? (
            <div className="mb-3 flex justify-end gap-2">
              {step.requestBody !== undefined ? (
                <RawDialog title="Request body" value={parseMaybeJson(step.requestBody)} />
              ) : null}
              {step.responseBody !== undefined ? (
                <RawDialog title="Response body" value={step.responseBody} />
              ) : null}
            </div>
          ) : null}
          <div className="grid grid-cols-2 overflow-hidden rounded-lg ring-1 ring-neutral-200 sm:grid-cols-3">
            <MiniMetric label="latency" value={formatDuration(step.durationMs)} />
            <MiniMetric
              label="temperature"
              value={step.temperature === undefined ? "unknown" : String(step.temperature)}
            />
            <MiniMetric label="tokens" value={usage.tokens} />
            <MiniMetric label="cost" value={usage.cost} />
            <MiniMetric
              label="cache read"
              value={
                hasCacheMetadata(step)
                  ? formatTokenCount(step.cacheReadTokens)
                  : "unknown"
              }
            />
            <MiniMetric
              label="cache write"
              value={
                hasCacheMetadata(step)
                  ? formatTokenCount(step.cacheWriteTokens)
                  : "unknown"
              }
            />
            <MiniMetric label="messages" value={String(step.messages.length)} />
            <MiniMetric
              label="session"
              value={step.sessionId ? shortId(step.sessionId) : "legacy"}
            />
          </div>
        </div>

        {isSilentText ? (
          <div className="border-y border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
            模型生成了自然语言文本，但没有调用可见消息工具。
          </div>
        ) : null}

        <div className="grid min-w-0 divide-y divide-neutral-200 xl:grid-cols-2 xl:divide-x xl:divide-y-0">
          <section className="min-w-0 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h4 className="text-sm font-semibold">
                  {promptView === "delta" ? "Prompt changes" : "Full prompt"}
                </h4>
                <p className="mt-1 text-[11px] text-neutral-500">
                  {promptDeltaSummary(promptDelta, step.messages.length)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill tone={promptDelta.kind === "changed" ? "warning" : "neutral"}>
                  {promptDeltaLabel(promptDelta)}
                </StatusPill>
                {step.toolChoice ? (
                  <StatusPill tone="neutral">toolChoice {step.toolChoice}</StatusPill>
                ) : null}
              </div>
            </div>
            <PromptMessageList
              messages={promptView === "delta" ? promptDelta.messages : step.messages}
              emptyMessage={promptDeltaEmptyMessage(promptDelta)}
            />
            <ToolInventory tools={step.tools} purpose={step.purpose} />
          </section>

          <section className="min-w-0 p-3">
            <h4 className="text-sm font-semibold">Output</h4>
            {step.outputContent ? (
              <TextPanel title="content" value={step.outputContent} tone="plain" />
            ) : (
              <div className={cn(mutedCardClass, "mt-2 p-3 text-xs text-neutral-500")}>
                No assistant content
              </div>
            )}
            {step.reasoning ? (
              <TextPanel title="reasoning" value={step.reasoning} tone="muted" />
            ) : null}
            <StructuredList title="tool calls" items={step.toolCalls} />
            <StructuredList title="tool results" items={step.toolResults} />
            {step.usage !== undefined ? (
              <section className="mt-3 overflow-hidden rounded-md bg-neutral-50 ring-1 ring-neutral-200">
                <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-medium uppercase text-neutral-500">
                  usage
                </div>
                <JsonBlock value={step.usage} />
              </section>
            ) : null}
          </section>
        </div>
      </div>
    </details>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 border-b border-r border-neutral-200 bg-neutral-50/70 p-2 last:border-r-0 md:border-b-0">
      <p className="text-[10px] font-medium uppercase text-neutral-500">{label}</p>
      <p className="mt-1 break-all font-mono text-[11px] text-neutral-800">{value}</p>
    </div>
  );
}

function PromptMessageList({
  messages,
  emptyMessage = "No prompt messages captured"
}: {
  messages: ModelMessageView[];
  emptyMessage?: string;
}) {
  if (!messages.length) {
    return (
      <div className={cn(mutedCardClass, "mt-2 p-3 text-xs text-neutral-500")}>
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      {messages.map((message, index) => (
        <section key={`${message.role}:${index}`} className="overflow-hidden rounded-md bg-neutral-50 ring-1 ring-neutral-200">
          <header className="flex flex-wrap items-center gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
            <StatusPill tone={message.role === "system" ? "info" : "neutral"}>
              {message.role}
            </StatusPill>
            {message.markers.map((marker) => (
              <StatusPill key={marker} tone={marker === "current_window" ? "warning" : "neutral"}>
                {marker}
              </StatusPill>
            ))}
          </header>
          <pre className="whitespace-pre-wrap p-3 font-mono text-[11px] leading-5 text-neutral-800 [overflow-wrap:anywhere]">
            {message.content}
          </pre>
        </section>
      ))}
    </div>
  );
}

function getPromptDelta(
  step: ModelStepView,
  previousStep: ModelStepView | undefined
): PromptDelta {
  const startsNewSession =
    !previousStep ||
    Boolean(
      step.sessionId &&
        previousStep.sessionId &&
        step.sessionId !== previousStep.sessionId
    );

  if (startsNewSession) {
    return {
      kind: "initial",
      messages: step.messages,
      reusedCount: 0,
      replacedCount: 0
    };
  }

  let reusedCount = 0;
  const comparableLength = Math.min(
    step.messages.length,
    previousStep.messages.length
  );
  while (
    reusedCount < comparableLength &&
    sameModelMessage(step.messages[reusedCount], previousStep.messages[reusedCount])
  ) {
    reusedCount += 1;
  }

  const messages = step.messages.slice(reusedCount);
  const replacedCount = previousStep.messages.length - reusedCount;
  if (!messages.length && replacedCount === 0) {
    return {
      kind: "unchanged",
      messages,
      reusedCount,
      replacedCount
    };
  }

  return {
    kind: replacedCount > 0 ? "changed" : "appended",
    messages,
    reusedCount,
    replacedCount
  };
}

function sameModelMessage(
  current: ModelMessageView | undefined,
  previous: ModelMessageView | undefined
): boolean {
  return Boolean(
    current &&
      previous &&
      current.role === previous.role &&
      current.content === previous.content
  );
}

function promptDeltaLabel(delta: PromptDelta): string {
  if (delta.kind === "initial") {
    return "initial context";
  }
  if (delta.kind === "unchanged") {
    return "no changes";
  }
  if (delta.kind === "changed") {
    return `${delta.messages.length} changed`;
  }
  return `${delta.messages.length} new`;
}

function promptDeltaSummary(delta: PromptDelta, totalCount: number): string {
  if (delta.kind === "initial") {
    return `${totalCount} messages establish the request context`;
  }
  if (delta.kind === "unchanged") {
    return `${delta.reusedCount} messages reused from the previous request`;
  }

  const parts = [
    `${delta.messages.length} ${delta.kind === "changed" ? "current" : "new"}`,
    `${delta.reusedCount} reused`
  ];
  if (delta.replacedCount > 0) {
    parts.push(`${delta.replacedCount} replaced`);
  }
  return `${parts.join(" · ")} · ${totalCount} total`;
}

function promptDeltaEmptyMessage(delta: PromptDelta): string {
  if (delta.kind === "initial") {
    return "No prompt messages captured for the initial request.";
  }
  if (delta.kind === "changed") {
    return `The request removed ${delta.replacedCount} previous message${
      delta.replacedCount === 1 ? "" : "s"
    }; no prompt messages remain.`;
  }
  return "No new prompt messages. This request reused the previous context unchanged.";
}

function ToolInventory({
  tools,
  purpose
}: {
  tools: unknown[];
  purpose: string;
}) {
  if (!tools.length) {
    return null;
  }

  const activeToolNames =
    purpose === "dreaming"
      ? new Set(["bash", "finish_dreaming"])
      : purpose === "agent_action"
        ? new Set(
            tools
              .map(toolName)
              .filter(
                (name) => name !== "bash" && name !== "finish_dreaming"
              )
          )
        : undefined;

  return (
    <section className="mt-3 overflow-hidden rounded-md bg-neutral-50 ring-1 ring-neutral-200">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-2">
        <span className="text-[11px] font-medium uppercase text-neutral-500">
          provider tool protocol
        </span>
        {activeToolNames ? (
          <span className="text-[10px] text-neutral-500">
            {purpose === "dreaming"
              ? "memory execution gate"
              : "chat-action execution gate"}
          </span>
        ) : null}
      </header>
      <div className="flex flex-wrap gap-2 p-3">
        {tools.map((tool, index) => {
          const name = toolName(tool);
          const isActive = activeToolNames?.has(name) ?? true;
          return (
            <span
              key={`${name}:${index}`}
              className={cn(
                "max-w-full break-all rounded-md px-2 py-1 font-mono text-[11px] ring-1",
                isActive
                  ? "bg-[var(--trace-accent-soft)] text-[var(--trace-accent)] ring-[var(--trace-accent-border)]"
                  : "bg-neutral-100 text-neutral-500 ring-neutral-200"
              )}
              title={isActive ? "Executable in this phase" : "Stable protocol only; execution gated"}
            >
              {name}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function TextPanel({
  title,
  value,
  tone
}: {
  title: string;
  value: string;
  tone: "plain" | "muted";
}) {
  return (
    <section className="mt-2 overflow-hidden rounded-md bg-neutral-50 ring-1 ring-neutral-200">
      <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-medium uppercase text-neutral-500">
        {title}
      </div>
      <pre
        className={cn(
          "max-h-72 overflow-y-auto whitespace-pre-wrap p-3 text-xs leading-5 [overflow-wrap:anywhere]",
          tone === "plain" && "text-neutral-900",
          tone === "muted" && "bg-neutral-50 text-neutral-600"
        )}
      >
        {value}
      </pre>
    </section>
  );
}

function StructuredList({ title, items }: { title: string; items: unknown[] }) {
  return (
    <section className="mt-3 overflow-hidden rounded-md bg-neutral-50 ring-1 ring-neutral-200">
      <header className="border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-medium uppercase text-neutral-500">
        {title}
      </header>
      {items.length ? (
        <div className="divide-y divide-neutral-200">
          {items.map((item, index) => (
            <div key={index} className="flex min-w-0 items-start justify-between gap-3 p-3">
              <div className="min-w-0 text-xs leading-5 [overflow-wrap:anywhere]">
                <p className="font-mono text-[11px] text-neutral-500">
                  {toolName(item)}
                </p>
                <p className="mt-1">{jsonLabel(item)}</p>
              </div>
              <RawDialog title={`${title} JSON`} value={item} />
            </div>
          ))}
        </div>
      ) : (
        <div className="p-3 text-xs text-neutral-500">None</div>
      )}
    </section>
  );
}

function MetricGrid({ detail }: { detail: TraceDetail }) {
  const metrics = [
    ["duration", formatDuration(detail.summary.durationMs)],
    ["model", detail.summary.model ?? "unknown"],
    ["spans", String(detail.summary.spanCount)],
    ["observations", String(detail.summary.observationCount)],
    ["event", detail.summary.eventId],
    ["conversation", detail.relatedConversation ?? "unknown"]
  ];
  return (
    <div className="grid grid-cols-2 overflow-hidden rounded-md bg-white ring-1 ring-neutral-200">
      {metrics.map(([label, value]) => (
        <div key={label} className="min-w-0 border-b border-r border-neutral-200 p-3 even:border-r-0">
          <p className="text-[11px] font-medium uppercase text-neutral-500">{label}</p>
          <p className="mt-1 break-all font-mono text-xs text-neutral-900">{value}</p>
        </div>
      ))}
    </div>
  );
}

function DiagnosticList({
  diagnostics,
  compact,
  onSelectTrace,
}: {
  diagnostics: Diagnostic[];
  compact?: boolean;
  onSelectTrace?: (id: string) => void;
}) {
  if (!diagnostics.length) {
    return compact ? (
      <div className="p-4 text-sm text-neutral-500">No diagnostics</div>
    ) : (
      <section className="rounded-lg bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-emerald-200">
        No diagnostics for this run
      </section>
    );
  }
  return (
    <div className={compact ? "w-full divide-y divide-neutral-200" : "space-y-2"}>
      {diagnostics.map((diagnostic) => {
        const content = (
          <div
            className={cn(
              compact ? "w-full px-3 py-3" : "rounded-lg p-3 ring-1 ring-inset",
              diagnostic.severity === "error" && "bg-red-50 text-red-950 ring-red-200",
              diagnostic.severity === "warning" && "bg-amber-50 text-amber-950 ring-amber-200",
              diagnostic.severity === "info" && "bg-neutral-50 text-neutral-950 ring-neutral-200"
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <SeverityIcon severity={diagnostic.severity} />
              <p className="min-w-0 text-sm font-medium [overflow-wrap:anywhere]">
                {diagnostic.title}
              </p>
            </div>
            <p className="mt-2 text-xs leading-5 [overflow-wrap:anywhere]">
              {diagnostic.message}
            </p>
            <p className="mt-2 break-all font-mono text-[11px] opacity-70">
              {diagnostic.code}
            </p>
          </div>
        );
        if (diagnostic.traceId && onSelectTrace) {
          return (
            <button
              key={diagnostic.id}
              className={cn("block w-full text-left hover:bg-neutral-50", !compact && "rounded-lg", focusClass)}
              type="button"
              onClick={() => onSelectTrace(diagnostic.traceId as string)}
            >
              {content}
            </button>
          );
        }
        return <div key={diagnostic.id}>{content}</div>;
      })}
    </div>
  );
}

function ActionList({ trace }: { trace: AgentTurnTrace }) {
  const actions = trace.proposedActions ?? [];
  const results = trace.toolResults ?? [];
  return (
    <section>
      <h3 className="text-sm font-semibold">Actions</h3>
      <div className="mt-2 overflow-hidden rounded-md bg-white ring-1 ring-neutral-200">
        {actions.length ? (
          actions.map((action, index) => (
            <div key={action.id ?? index} className="border-b border-neutral-200 p-3 last:border-b-0">
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono text-xs">{action.toolName ?? "unknown"}</span>
                <RawDialog title="Action JSON" value={action} />
              </div>
              {action.reason ? (
                <p className="mt-2 text-xs leading-5 text-neutral-600 [overflow-wrap:anywhere]">
                  {action.reason}
                </p>
              ) : null}
            </div>
          ))
        ) : (
          <div className="p-3 text-sm text-neutral-500">No proposed actions</div>
        )}
      </div>
      <h3 className="mt-4 text-sm font-semibold">Tool results</h3>
      <div className="mt-2 overflow-hidden rounded-md bg-white ring-1 ring-neutral-200">
        {results.length ? (
          results.map((result, index) => (
            <div key={index} className="flex min-w-0 items-center justify-between gap-3 border-b border-neutral-200 p-3 last:border-b-0">
              <span className="min-w-0 text-xs text-neutral-600 [overflow-wrap:anywhere]">
                {jsonLabel(result)}
              </span>
              <RawDialog title="Tool result JSON" value={result} />
            </div>
          ))
        ) : (
          <div className="p-3 text-sm text-neutral-500">No tool results</div>
        )}
      </div>
    </section>
  );
}

function RelatedEvent({ event }: { event: EventTimelineItem }) {
  return (
    <section className={cn(cardClass, "p-3")}>
      <h3 className="text-sm font-semibold">Related event</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6 [overflow-wrap:anywhere]">
        {event.text}
      </p>
      <p className="mt-2 break-all font-mono text-[11px] text-neutral-500">
        {event.eventId}
      </p>
    </section>
  );
}

function Waterfall({ spans }: { spans: WaterfallSpan[] }) {
  if (!spans.length) {
    return <EmptyState icon={<Activity />} title="No spans" />;
  }
  return (
    <div className="space-y-2 p-4">
      {spans.map((span) => (
        <div key={span.id} className="grid grid-cols-[132px_minmax(0,1fr)_72px] items-center gap-3 text-xs">
          <div className="min-w-0">
            <p className="truncate font-mono">{span.name}</p>
            <p className="text-[11px] text-neutral-500">{span.kind}</p>
          </div>
          <div className="relative h-7 overflow-hidden rounded-md bg-neutral-100 ring-1 ring-neutral-200">
            <div
              className={cn(
                "absolute top-1 h-5 rounded-sm",
                span.status === "error" && "bg-red-400",
                span.status === "running" && "bg-[var(--trace-accent)]",
                span.status !== "error" && span.status !== "running" && span.kind === "generation" && "bg-violet-400",
                span.status !== "error" && span.status !== "running" && span.kind === "tool" && "bg-emerald-400",
                span.status !== "error" &&
                  span.status !== "running" &&
                  span.kind === "span" &&
                  "bg-[var(--trace-accent-border)]",
                span.status !== "error" && span.status !== "running" && span.kind !== "span" && span.kind !== "tool" && span.kind !== "generation" && "bg-neutral-300"
              )}
              style={{
                left: `${span.offsetPct}%`,
                width: `${span.widthPct}%`
              }}
            />
          </div>
          <div className="font-mono text-[11px] text-neutral-500">
            {formatDuration(span.durationMs)}
          </div>
        </div>
      ))}
    </div>
  );
}

function ObservationList({ observations }: { observations: ObservationRecord[] }) {
  if (!observations.length) {
    return <EmptyState icon={<Braces />} title="No observations" />;
  }
  return (
    <div className="w-full divide-y divide-neutral-200">
      {observations.map((observation) => (
        <div key={observation.id} className="w-full p-4">
          <div className="flex min-w-0 items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <StatusPill tone={observation.level === "ERROR" ? "error" : observation.type === "generation" ? "info" : "neutral"}>
                  {observation.type}
                </StatusPill>
                <span className="min-w-0 break-all font-mono text-xs">{observation.name}</span>
                {observation.type === "generation" ? (
                  <GenerationObservationPills observation={observation} />
                ) : null}
              </div>
              <p className="mt-2 break-all text-xs text-neutral-500">
                {observation.model ?? observation.statusMessage ?? observation.startedAt ?? observation.id}
              </p>
            </div>
            <RawDialog title="Observation JSON" value={observation} />
          </div>
          <p className="mt-3 text-xs leading-5 text-neutral-700 [overflow-wrap:anywhere]">
            {jsonLabel(observation.output ?? observation.metadata ?? observation.input)}
          </p>
        </div>
      ))}
    </div>
  );
}

function GenerationObservationPills({
  observation
}: {
  observation: ObservationRecord;
}) {
  const input = asRecord(observation.input);
  const metadata = asRecord(observation.metadata);
  const purpose =
    readString(metadata.purpose) ?? purposeFromName(observation.name);
  const cacheReadTokens = readNumber(metadata.cacheReadTokens) ?? 0;
  const sessionId = readString(input.sessionId);

  return (
    <>
      <StatusPill tone={purposeTone(purpose)}>{purposeLabel(purpose)}</StatusPill>
      {cacheReadTokens > 0 ? (
        <StatusPill tone="ok">
          cache {formatTokenCount(cacheReadTokens)}
        </StatusPill>
      ) : null}
      {sessionId ? (
        <span
          className="font-mono text-[10px] text-neutral-500"
          title={sessionId}
        >
          {shortId(sessionId)}
        </span>
      ) : null}
    </>
  );
}

function RawDialog({ title, value }: { title: string; value: unknown }) {
  return (
    <Dialog
      title={title}
      trigger={
        <IconButton className="h-8 w-8 shrink-0">
          <Braces size={14} />
        </IconButton>
      }
    >
      <JsonDialogViewer value={value} />
    </Dialog>
  );
}

function JsonDialogViewer({ value }: { value: unknown }) {
  const [expandRequest, setExpandRequest] = useState(0);

  return (
    <div className="relative h-full min-h-0 w-full bg-neutral-950">
      <button
        className="absolute right-3 top-3 z-10 rounded-md bg-white px-3 py-2 text-xs font-medium text-neutral-950 ring-1 ring-neutral-300 hover:bg-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]"
        type="button"
        onClick={() => setExpandRequest((request) => request + 1)}
      >
        Expand all
      </button>
      <ScrollArea className="h-full min-h-0 w-full bg-neutral-950">
        <JsonBlock
          key={expandRequest}
          value={value}
          expandAll={expandRequest > 0}
        />
      </ScrollArea>
    </div>
  );
}

function JsonBlock({ value, expandAll = false }: { value: unknown; expandAll?: boolean }) {
  return (
    <div className="min-h-full w-full bg-neutral-950 p-4 font-mono text-xs leading-5 text-neutral-100 [overflow-wrap:anywhere]">
      <JsonView
        data={toJsonViewData(value)}
        style={jsonViewStyles}
        shouldExpandNode={expandAll ? allExpanded : collapseAllNested}
        clickToExpandNode
        aria-label="JSON data"
      />
    </div>
  );
}

function EmptyState({
  icon,
  title,
  tone = "neutral",
}: {
  icon: ReactNode;
  title: string;
  tone?: "neutral" | "error";
}) {
  return (
    <div className={cn("m-4 grid min-h-40 place-items-center rounded-lg border border-dashed p-6 text-center", tone === "error" ? "border-red-200 bg-red-50 text-red-900" : "border-neutral-200 bg-white text-neutral-500")}>
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center rounded-lg bg-neutral-100 text-neutral-500">
          {icon}
        </div>
        <p className="mt-3 text-sm">{title}</p>
      </div>
    </div>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied" : "Copy id"}>
      <IconButton
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 900);
          });
        }}
      >
        <Copy size={15} />
      </IconButton>
    </Tooltip>
  );
}

function SeverityDot({ diagnostics }: { diagnostics: Diagnostic[] }) {
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return <span className="h-2 w-2 rounded-full bg-red-500" />;
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return <span className="h-2 w-2 rounded-full bg-amber-500" />;
  }
  if (diagnostics.length) {
    return <span className="h-2 w-2 rounded-full bg-[var(--trace-accent)]" />;
  }
  return <span className="h-2 w-2 rounded-full bg-emerald-500" />;
}

function StatusIcon({ status }: { status: TraceSummary["status"] }) {
  if (status === "running") {
    return <Loader2 size={15} className="text-[var(--trace-accent)]" />;
  }
  if (status === "error") {
    return <XCircle size={15} className="text-red-600" />;
  }
  if (status === "warning") {
    return <AlertTriangle size={15} className="text-amber-600" />;
  }
  return <CheckCircle2 size={15} className="text-emerald-600" />;
}

function SeverityIcon({ severity }: { severity: Diagnostic["severity"] }) {
  if (severity === "error") {
    return <XCircle size={15} />;
  }
  if (severity === "warning") {
    return <AlertTriangle size={15} />;
  }
  return <Activity size={15} />;
}

function statusTone(
  status: TraceSummary["status"]
): "neutral" | "ok" | "warning" | "error" | "info" {
  if (status === "running") {
    return "info";
  }
  if (status === "error") {
    return "error";
  }
  if (status === "warning") {
    return "warning";
  }
  return "ok";
}

function parseLiveEvent(event: Event): RuntimeLiveEventEnvelope | undefined {
  if (!("data" in event) || typeof event.data !== "string") {
    return undefined;
  }
  try {
    return JSON.parse(event.data) as RuntimeLiveEventEnvelope;
  } catch {
    return undefined;
  }
}

function eventTouchesTrace(
  event: RuntimeLiveEventEnvelope,
  selectedTraceId: string
): boolean {
  const traceId = readTraceId(event.data);
  if (!traceId) {
    return false;
  }
  return traceId === selectedTraceId || traceId.startsWith(selectedTraceId);
}

function readTraceId(value: unknown): string | undefined {
  const record = isRecord(value) ? value : {};
  const direct = readString(record.traceId);
  if (direct) {
    return direct;
  }
  const trace = isRecord(record.trace) ? record.trace : undefined;
  const traceId = readString(trace?.id);
  if (traceId) {
    return traceId;
  }
  const turn = isRecord(record.turn) ? record.turn : undefined;
  return readString(turn?.traceId);
}

function collectModelSteps(trace: AgentTurnTrace): ModelStepView[] {
  const generationSteps = (trace.observations ?? [])
    .filter((observation) => observation.type === "generation")
    .map((observation, index) => modelStepFromObservation(observation, index));

  if (generationSteps.length) {
    return generationSteps;
  }

  const modelSpan = (trace.spans ?? []).find((span) => span.name === "model.decide");
  const responses = asArray(asRecord(modelSpan?.attributes).modelResponses);
  return responses.map((response, index) =>
    modelStepFromSpanResponse(response, modelSpan, index)
  );
}

function modelStepFromObservation(
  observation: ObservationRecord,
  index: number
): ModelStepView {
  const input = asRecord(observation.input);
  const output = asRecord(observation.output);
  const metadata = asRecord(observation.metadata);
  const cacheUsage = asRecord(output.cacheUsage);
  const responseBody = output.responseBody;

  const stepNumber =
    readNumber(input.stepNumber) ??
    readNumber(output.stepNumber) ??
    readNumber(metadata.stepIndex) ??
    index;
  const usage = observation.usage ?? output.usage;

  return {
    id: observation.id,
    requestIndex: index + 1,
    stepNumber,
    purpose:
      readString(metadata.purpose) ?? purposeFromName(observation.name),
    model:
      observation.model ??
      readString(input.model) ??
      readString(metadata.model) ??
      readStringFromPath(responseBody, ["model"]),
    provider: readString(input.provider) ?? readString(metadata.provider),
    sessionId: readString(input.sessionId),
    promptCacheEnabled: readBoolean(input.promptCacheEnabled),
    cacheReadTokens:
      readNumber(cacheUsage.readTokens) ??
      readNumber(metadata.cacheReadTokens) ??
      0,
    cacheWriteTokens:
      readNumber(cacheUsage.writeTokens) ??
      readNumber(metadata.cacheWriteTokens) ??
      0,
    temperature: readNumber(input.temperature) ?? readNumber(metadata.temperature),
    finishReason:
      readString(output.finishReason) ??
      readString(metadata.finishReason) ??
      readStringFromPath(responseBody, ["choices", 0, "finish_reason"]) ??
      readStringFromPath(responseBody, ["choices", 0, "native_finish_reason"]),
    startedAt: observation.startedAt,
    endedAt: observation.endedAt,
    durationMs: elapsedMs(observation.startedAt, observation.endedAt),
    messages: asArray(input.messages).map(toModelMessage),
    tools: asArray(input.tools),
    toolChoice:
      readString(input.toolChoice) ??
      readString(input.tool_choice) ??
      readString(asRecord(input.toolChoice).type),
    outputContent:
      readString(output.content) ??
      readStringFromPath(responseBody, ["choices", 0, "message", "content"]),
    reasoning:
      readString(output.reasoning) ??
      readStringFromPath(responseBody, ["choices", 0, "message", "reasoning"]) ??
      readReasoningDetails(responseBody),
    toolCalls:
      asArray(output.toolCalls).length > 0
        ? asArray(output.toolCalls)
        : asArray(
            readPath(responseBody, ["choices", 0, "message", "tool_calls"])
          ),
    toolResults: asArray(output.toolResults),
    usage,
    requestBody: output.requestBody,
    responseBody,
    source: "generation",
    observation
  };
}

function modelStepFromSpanResponse(
  response: unknown,
  span: AgentTurnTrace["spans"][number] | undefined,
  index: number
): ModelStepView {
  const record = asRecord(response);
  return {
    id: `${span?.id ?? "model-span"}:${index}`,
    requestIndex: index + 1,
    stepNumber: readNumber(record.stepNumber) ?? index,
    purpose: "agent_action",
    model: readString(asRecord(span?.attributes).model),
    finishReason: readString(record.finishReason),
    startedAt: span?.startedAt,
    endedAt: span?.endedAt,
    durationMs: elapsedMs(span?.startedAt, span?.endedAt),
    messages: [],
    tools: [],
    provider: undefined,
    sessionId: undefined,
    promptCacheEnabled: undefined,
    cacheReadTokens:
      readNumber(asRecord(record.cacheUsage).readTokens) ?? 0,
    cacheWriteTokens:
      readNumber(asRecord(record.cacheUsage).writeTokens) ?? 0,
    temperature: undefined,
    toolChoice: undefined,
    outputContent: readString(record.content),
    reasoning: undefined,
    toolCalls: asArray(record.toolCalls),
    toolResults: asArray(record.toolResults),
    usage: record.usage,
    requestBody: undefined,
    responseBody: undefined,
    observation: undefined,
    source: "span"
  };
}

function toModelMessage(value: unknown): ModelMessageView {
  const record = asRecord(value);
  const role = readString(record.role) ?? "unknown";
  const content = contentToText(record.content);
  return {
    role,
    content,
    markers: promptMarkers(content)
  };
}

function contentToText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(contentToText).filter(Boolean).join("\n");
  }
  const record = asRecord(value);
  const text = readString(record.text) ?? readString(record.content);
  if (text) {
    return text;
  }
  return jsonLabel(value);
}

function promptMarkers(content: string): string[] {
  const markers: string[] = [];
  if (content.includes("What you remember:")) {
    markers.push("memory");
  }
  if (content.includes("Available tools:")) {
    markers.push("tools");
  }
  if (content.includes("Now you are dreaming.")) {
    markers.push("dreaming");
  }
  if (
    content.startsWith("Group chat ") ||
    content.startsWith("Private chat ")
  ) {
    markers.push("transcript");
  }
  return markers;
}

function summarizeUsage(value: unknown): { tokens: string; cost: string } {
  const usage = asRecord(value);
  const raw = asRecord(usage.raw);
  const inputTokens =
    readNumber(usage.inputTokens) ?? readNumber(raw.prompt_tokens);
  const outputTokens =
    readNumber(usage.outputTokens) ?? readNumber(raw.completion_tokens);
  const totalTokens =
    readNumber(usage.totalTokens) ?? readNumber(raw.total_tokens);
  const cost = readNumber(raw.cost) ?? readNumber(usage.cost);

  return {
    tokens:
      totalTokens !== undefined
        ? `${totalTokens} total`
        : inputTokens !== undefined || outputTokens !== undefined
          ? `${inputTokens ?? 0} in / ${outputTokens ?? 0} out`
          : "unknown",
    cost: cost === undefined ? "unknown" : `$${cost.toFixed(6)}`
  };
}

function groupModelSteps(
  steps: ModelStepView[]
): Array<{ id: string; purpose: string; steps: ModelStepView[] }> {
  const groups: Array<{ id: string; purpose: string; steps: ModelStepView[] }> = [];
  for (const step of steps) {
    const current = groups.at(-1);
    if (current?.purpose === step.purpose) {
      current.steps.push(step);
      continue;
    }
    groups.push({
      id: `${step.purpose}:${step.requestIndex}`,
      purpose: step.purpose,
      steps: [step]
    });
  }
  return groups;
}

function purposeFromName(name: string): string {
  if (name.startsWith("dreaming.")) {
    return "dreaming";
  }
  if (name.startsWith("agent_action.")) {
    return "agent_action";
  }
  return "model";
}

function purposeLabel(purpose: string): string {
  if (purpose === "agent_action") {
    return "action";
  }
  return purpose;
}

function purposeTone(
  purpose: string
): "neutral" | "ok" | "warning" | "error" | "info" {
  if (purpose === "dreaming") {
    return "neutral";
  }
  if (purpose === "agent_action") {
    return "info";
  }
  return "neutral";
}

function hasMessagePrefix(
  messages: ModelMessageView[],
  prefix: ModelMessageView[]
): boolean {
  return (
    messages.length >= prefix.length &&
    prefix.every(
      (message, index) =>
        messages[index]?.role === message.role &&
        messages[index]?.content === message.content
    )
  );
}

function toolProtocolKey(tools: unknown[]): string {
  return tools.map(toolName).join("\u0000");
}

function formatTokenCount(tokens: number): string {
  return new Intl.NumberFormat().format(tokens);
}

function hasCacheMetadata(step: ModelStepView): boolean {
  return (
    step.promptCacheEnabled !== undefined ||
    step.cacheReadTokens > 0 ||
    step.cacheWriteTokens > 0
  );
}

function cacheGroupLabel(steps: ModelStepView[]): string {
  if (!steps.some(hasCacheMetadata)) {
    return "cache unavailable";
  }
  if (steps.every((step) => step.promptCacheEnabled === false)) {
    return "cache disabled";
  }
  return `${formatTokenCount(
    steps.reduce((total, step) => total + step.cacheReadTokens, 0)
  )} cached`;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function readReasoningDetails(value: unknown): string | undefined {
  const details = asArray(
    readPath(value, ["choices", 0, "message", "reasoning_details"])
  );
  const text = details
    .map((detail) => readString(asRecord(detail).text))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
  return text || undefined;
}

function toolName(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  return (
    readString(record.name) ??
    readString(record.toolName) ??
    readString(record.status) ??
    readString(asRecord(record.function).name) ??
    "item"
  );
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function toJsonViewData(value: unknown): Record<string, unknown> | unknown[] {
  return Array.isArray(value) || isRecord(value) ? value : { value };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readStringFromPath(
  value: unknown,
  path: Array<string | number>
): string | undefined {
  return readString(readPath(value, path));
}

function readPath(value: unknown, path: Array<string | number>): unknown {
  let current = value;
  for (const segment of path) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function filterConversations(conversations: ConversationView[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return conversations;
  }
  return conversations.filter((conversation) =>
    [conversation.key, conversation.lastText ?? ""].some((value) =>
      value.toLowerCase().includes(needle)
    )
  );
}

function filterTraces(traces: TraceSummary[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return traces;
  }
  return traces.filter((trace) =>
    [
      trace.id,
      trace.eventId,
      trace.model ?? "",
      ...trace.actionNames,
      ...trace.toolStatuses
    ].some((value) => value.toLowerCase().includes(needle))
  );
}

function filterDiagnostics(diagnostics: Diagnostic[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return diagnostics;
  }
  return diagnostics.filter((diagnostic) =>
    [
      diagnostic.code,
      diagnostic.title,
      diagnostic.message,
      diagnostic.traceId ?? "",
      diagnostic.eventId ?? "",
      diagnostic.conversationKey ?? ""
    ].some((value) => value.toLowerCase().includes(needle))
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "--:--:--";
  }
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "unknown";
  }
  return date.toLocaleDateString(undefined, {
    month: "2-digit",
    day: "2-digit"
  });
}

function elapsedMs(startedAt: string | undefined, endedAt: string | undefined): number {
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const end = endedAt ? Date.parse(endedAt) : Number.NaN;
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, Math.round(end - start));
}

function formatDuration(ms: number) {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${(ms / 60_000).toFixed(1)}m`;
}

function jsonLabel(value: unknown) {
  if (value === undefined || value === null) {
    return "empty";
  }
  if (typeof value === "string") {
    return value.length > 160 ? `${value.slice(0, 159)}…` : value;
  }
  try {
    const text = JSON.stringify(value);
    return text.length > 160 ? `${text.slice(0, 159)}…` : text;
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
