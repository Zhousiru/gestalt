import {
  Activity,
  AlertTriangle,
  Bot,
  Braces,
  CheckCircle2,
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
import { useEffect, useMemo, useState, type ReactNode } from "react";
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
  WaterfallSpan
} from "../lib/types";

type LoadState = "loading" | "ready" | "error";

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
      const response = await fetch("/api/snapshot", { cache: "no-store" });
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

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, []);

  useEffect(() => {
    const source = new EventSource("/events");
    source.addEventListener("ready", () => {
      setLiveState("live");
    });
    source.addEventListener("snapshot_changed", () => {
      setLiveState("live");
      void loadSnapshot();
    });
    source.addEventListener("heartbeat", () => {
      setLiveState("live");
    });
    source.onerror = () => {
      setLiveState("offline");
    };
    return () => {
      source.close();
    };
  }, []);

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
    let cancelled = false;
    setTraceLoading(true);
    fetch(`/api/traces/${encodeURIComponent(selectedTraceId)}`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Trace request failed with ${response.status}`);
        }
        return response.json() as Promise<TraceDetail>;
      })
      .then((detail) => {
        if (!cancelled) {
          setTraceDetail(detail);
        }
      })
      .catch((detailError) => {
        if (!cancelled) {
          setTraceDetail(undefined);
          setError(detailError instanceof Error ? detailError.message : String(detailError));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setTraceLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
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
      <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] bg-slate-50 text-slate-950">
        <Header
          workspace={workspace}
          liveState={liveState}
          loadState={loadState}
          onRefresh={() => void loadSnapshot()}
        />
        <section className="grid min-h-0 max-w-full grid-cols-1 overflow-auto border-t border-slate-300 lg:grid-cols-[300px_minmax(420px,1fr)_minmax(380px,34vw)] lg:overflow-hidden">
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
    <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] bg-slate-50 text-slate-950">
      <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 bg-white px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center border border-slate-950 bg-slate-950 text-white">
            <Activity size={18} />
          </div>
          <div>
            <h1 className="text-base font-semibold">Gestalt Trace</h1>
            <p className="font-mono text-xs text-slate-500">Loading GestaltHome</p>
          </div>
        </div>
        <StatusPill tone="info">connecting</StatusPill>
      </header>
      <section className="grid place-items-center border-t border-slate-300">
        <div className="border border-slate-300 bg-white p-6 text-sm text-slate-500 shadow-[4px_4px_0_#cbd5e1]">
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
    <header className="flex min-h-16 flex-wrap items-center justify-between gap-4 bg-white px-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center border border-slate-950 bg-slate-950 text-white">
            <Activity size={18} />
          </div>
          <div>
            <h1 className="text-base font-semibold">Gestalt Trace</h1>
            <p className="max-w-[70vw] truncate font-mono text-xs text-slate-500">
              {workspace?.home.root ?? "Loading GestaltHome"}
            </p>
          </div>
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
        <StatusPill tone="neutral">
          {workspace ? `${workspace.sessionExportCount} sessions` : "no sessions"}
        </StatusPill>
        <Tooltip label="Refresh snapshot">
          <IconButton onClick={onRefresh} disabled={loadState === "loading"}>
            {loadState === "loading" ? (
              <Loader2 size={16} className="animate-spin" />
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
    <aside className="grid min-h-[320px] min-w-0 grid-rows-[auto_minmax(0,1fr)] border-b border-r border-slate-300 bg-white lg:min-h-0 lg:border-b-0">
      <div className="border-b border-slate-300 p-3">
        <label className="flex h-10 items-center border border-slate-300 bg-slate-50 px-3 text-sm focus-within:border-slate-950">
          <Search size={15} className="mr-2 text-slate-500" />
          <input
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-slate-400"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search"
          />
        </label>
      </div>
      <Tabs defaultValue="conversations" className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <TabsList>
          <TabsTrigger value="conversations">Conversations</TabsTrigger>
          <TabsTrigger value="traces">Runs</TabsTrigger>
          <TabsTrigger value="diagnostics">Warnings</TabsTrigger>
        </TabsList>
        <TabsContent value="conversations" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="divide-y divide-slate-200">
              {conversations.map((conversation) => (
                <button
                  key={conversation.key}
                  className={cn(
                    "block w-full px-3 py-3 text-left hover:bg-cyan-50",
                    selectedConversationKey === conversation.key && "bg-slate-950 text-white hover:bg-slate-950"
                  )}
                  type="button"
                  onClick={() => onSelectConversation(conversation.key)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-mono text-xs">{conversation.key}</span>
                    <SeverityDot diagnostics={conversation.diagnostics} />
                  </div>
                  <p className={cn("mt-2 line-clamp-2 text-xs", selectedConversationKey === conversation.key ? "text-slate-200" : "text-slate-500")}>
                    {conversation.lastText ?? "No messages"}
                  </p>
                  <div className={cn("mt-2 flex gap-2 font-mono text-[11px]", selectedConversationKey === conversation.key ? "text-slate-300" : "text-slate-500")}>
                    <span>{conversation.eventCount} evt</span>
                    <span>{conversation.turnCount} run</span>
                    <span>{conversation.loopExitCount} exit</span>
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="traces" className="min-h-0">
          <ScrollArea className="h-full">
            <div className="divide-y divide-slate-200">
              {traces.map((trace) => (
                <button
                  key={trace.id}
                  className={cn(
                    "block w-full px-3 py-3 text-left hover:bg-cyan-50",
                    selectedTraceId === trace.id && "bg-slate-950 text-white hover:bg-slate-950"
                  )}
                  type="button"
                  onClick={() => onSelectTrace(trace.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs">{trace.shortId}</span>
                    <StatusIcon status={trace.status} />
                  </div>
                  <p className={cn("mt-2 truncate text-xs", selectedTraceId === trace.id ? "text-slate-200" : "text-slate-500")}>
                    {trace.actionNames.join(", ") || "no action"}
                  </p>
                  <div className={cn("mt-2 flex items-center gap-2 font-mono text-[11px]", selectedTraceId === trace.id ? "text-slate-300" : "text-slate-500")}>
                    <Clock size={12} />
                    <span>{formatDuration(trace.durationMs)}</span>
                    {trace.model ? <span className="truncate">{trace.model}</span> : null}
                  </div>
                </button>
              ))}
            </div>
          </ScrollArea>
        </TabsContent>
        <TabsContent value="diagnostics" className="min-h-0">
          <ScrollArea className="h-full">
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
  return (
    <section className="grid min-h-[640px] min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-slate-50/95 lg:min-h-0">
      <header className="border-b border-slate-300 bg-white px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-slate-500">Session replay</p>
            <h2 className="truncate text-lg font-semibold">
              {conversation?.key ?? "No conversation"}
            </h2>
          </div>
          {conversation ? (
            <div className="flex shrink-0 gap-2">
              <StatusPill tone="neutral">{conversation.eventCount} events</StatusPill>
              <StatusPill tone="neutral">{conversation.turnCount} runs</StatusPill>
              <StatusPill tone={conversation.diagnostics.some((item) => item.severity === "error") ? "error" : conversation.diagnostics.length ? "warning" : "ok"}>
                {conversation.diagnostics.length} signals
              </StatusPill>
            </div>
          ) : null}
        </div>
      </header>
      <ScrollArea className="min-h-0">
        <div className="mx-auto max-w-5xl px-5 py-5">
          {loading ? <EmptyState icon={<Loader2 className="animate-spin" />} title="Loading" /> : null}
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
    <article className="grid grid-cols-[92px_minmax(0,1fr)] gap-3">
      <TimeCell at={item.at} />
      <div
        className={cn(
          "border bg-white p-3 shadow-[3px_3px_0_#cbd5e1]",
          item.isSelf ? "border-cyan-700" : "border-slate-300"
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {item.isSelf ? <Bot size={15} className="text-cyan-700" /> : <MessageSquare size={15} className="text-slate-500" />}
            <span className="truncate text-sm font-medium">
              {item.senderName ?? item.senderId ?? "unknown"}
            </span>
            <span className="font-mono text-xs text-slate-500">seq {item.seq}</span>
          </div>
          <div className="flex shrink-0 gap-2">
            {item.mentionsBot ? <StatusPill tone="info">mention</StatusPill> : null}
            {item.source ? <StatusPill tone="neutral">{item.source}</StatusPill> : null}
          </div>
        </div>
        <p className="mt-3 whitespace-pre-wrap text-sm leading-6">{item.text}</p>
        <div className="mt-3 flex gap-3 font-mono text-[11px] text-slate-500">
          <span>{item.eventId}</span>
          {item.messageId ? <span>message {item.messageId}</span> : null}
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
    <article className="grid grid-cols-[92px_minmax(0,1fr)] gap-3">
      <TimeCell at={item.at} />
      <button
        className={cn(
          "border p-3 text-left shadow-[3px_3px_0_#cbd5e1] hover:border-slate-950",
          selected ? "border-slate-950 bg-slate-950 text-white shadow-[3px_3px_0_#06b6d4]" : "border-slate-300 bg-white"
        )}
        type="button"
        onClick={() => onSelectTrace(item.traceId)}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Activity size={15} />
            <span className="font-mono text-xs">run {item.shortTraceId}</span>
            {!item.hasTrace ? <StatusPill tone="warning">missing trace</StatusPill> : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <StatusPill tone={item.diagnostics.some((diag) => diag.severity === "error") ? "error" : item.diagnostics.length ? "warning" : "ok"}>
              {item.status}
            </StatusPill>
            <StatusPill tone="neutral">{formatDuration(item.durationMs)}</StatusPill>
          </div>
        </div>
        <div className={cn("mt-3 flex flex-wrap gap-2 text-xs", selected ? "text-slate-100" : "text-slate-600")}>
          {(item.actionNames.length ? item.actionNames : ["no action"]).map((action) => (
            <span key={action} className={cn("border px-2 py-1", selected ? "border-slate-500" : "border-slate-300 bg-slate-50")}>
              {action}
            </span>
          ))}
          {item.toolStatuses.map((status, index) => (
            <span key={`${status}:${index}`} className={cn("border px-2 py-1", selected ? "border-slate-500" : "border-slate-300 bg-slate-50")}>
              {status}
            </span>
          ))}
        </div>
        {item.diagnostics.length ? (
          <div className={cn("mt-3 space-y-1 text-xs", selected ? "text-amber-100" : "text-amber-800")}>
            {item.diagnostics.slice(0, 2).map((diagnostic) => (
              <p key={diagnostic.id}>{diagnostic.title}</p>
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
    <div className="grid grid-cols-[92px_minmax(0,1fr)] gap-3">
      <TimeCell at={at} />
      <div className="flex items-center gap-2 border border-dashed border-slate-300 bg-white px-3 py-2 text-xs text-slate-600">
        {icon}
        <span className="font-mono">{title}</span>
        <span className="truncate">{meta}</span>
      </div>
    </div>
  );
}

function TimeCell({ at }: { at: string }) {
  return (
    <div className="pt-3 text-right font-mono text-[11px] text-slate-500">
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
    <aside className="grid min-h-[640px] min-w-0 grid-rows-[auto_minmax(0,1fr)] border-l border-t border-slate-300 bg-white lg:min-h-0 lg:border-t-0">
      <header className="border-b border-slate-300 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-mono text-xs text-slate-500">Agent run</p>
            <h2 className="truncate text-lg font-semibold">
              {detail?.summary.shortId ?? selectedTraceId?.slice(0, 8) ?? "No run"}
            </h2>
          </div>
          {detail ? (
            <div className="flex shrink-0 gap-2">
              <StatusPill tone={detail.summary.status === "error" ? "error" : detail.summary.status === "warning" ? "warning" : "ok"}>
                {detail.summary.status}
              </StatusPill>
              <CopyButton value={detail.summary.id} />
            </div>
          ) : null}
        </div>
      </header>
      <div className="min-h-0">
        {loading ? <EmptyState icon={<Loader2 className="animate-spin" />} title="Loading run" /> : null}
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
    <Tabs defaultValue="summary" className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <TabsList>
        <TabsTrigger value="summary">Summary</TabsTrigger>
        <TabsTrigger value="waterfall">Waterfall</TabsTrigger>
        <TabsTrigger value="evidence">Evidence</TabsTrigger>
        <TabsTrigger value="raw">Raw</TabsTrigger>
      </TabsList>
      <TabsContent value="summary" className="min-h-0">
        <ScrollArea className="h-full">
          <div className="space-y-4 p-4">
            <MetricGrid detail={detail} />
            <DiagnosticList diagnostics={detail.diagnostics} />
            <ActionList trace={detail.trace} />
            {detail.relatedEvent ? <RelatedEvent event={detail.relatedEvent} /> : null}
          </div>
        </ScrollArea>
      </TabsContent>
      <TabsContent value="waterfall" className="min-h-0">
        <ScrollArea className="h-full">
          <Waterfall spans={detail.waterfall} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="evidence" className="min-h-0">
        <ScrollArea className="h-full">
          <ObservationList observations={detail.trace.observations ?? []} />
        </ScrollArea>
      </TabsContent>
      <TabsContent value="raw" className="min-h-0">
        <ScrollArea className="h-full">
          <JsonBlock value={detail.trace} />
        </ScrollArea>
      </TabsContent>
    </Tabs>
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
    <div className="grid grid-cols-2 border border-slate-300">
      {metrics.map(([label, value]) => (
        <div key={label} className="min-w-0 border-b border-r border-slate-200 p-3">
          <p className="text-[11px] uppercase text-slate-500">{label}</p>
          <p className="mt-1 truncate font-mono text-xs">{value}</p>
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
      <div className="p-4 text-sm text-slate-500">No diagnostics</div>
    ) : (
      <section className="border border-emerald-700 bg-emerald-50 p-3 text-sm text-emerald-900">
        No diagnostics for this run
      </section>
    );
  }
  return (
    <div className={compact ? "divide-y divide-slate-200" : "space-y-2"}>
      {diagnostics.map((diagnostic) => {
        const content = (
          <div
            className={cn(
              compact ? "p-3" : "border p-3",
              diagnostic.severity === "error" && "border-red-700 bg-red-50 text-red-950",
              diagnostic.severity === "warning" && "border-amber-700 bg-amber-50 text-amber-950",
              diagnostic.severity === "info" && "border-cyan-700 bg-cyan-50 text-cyan-950"
            )}
          >
            <div className="flex items-center gap-2">
              <SeverityIcon severity={diagnostic.severity} />
              <p className="text-sm font-medium">{diagnostic.title}</p>
            </div>
            <p className="mt-2 text-xs leading-5">{diagnostic.message}</p>
            <p className="mt-2 font-mono text-[11px] opacity-70">{diagnostic.code}</p>
          </div>
        );
        if (diagnostic.traceId && onSelectTrace) {
          return (
            <button
              key={diagnostic.id}
              className="block w-full text-left hover:bg-slate-50"
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
      <div className="mt-2 divide-y divide-slate-200 border border-slate-300">
        {actions.length ? (
          actions.map((action, index) => (
            <div key={action.id ?? index} className="p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-xs">{action.toolName ?? "unknown"}</span>
                <RawDialog title="Action JSON" value={action} />
              </div>
              {action.reason ? <p className="mt-2 text-xs leading-5 text-slate-600">{action.reason}</p> : null}
            </div>
          ))
        ) : (
          <div className="p-3 text-sm text-slate-500">No proposed actions</div>
        )}
      </div>
      <h3 className="mt-4 text-sm font-semibold">Tool results</h3>
      <div className="mt-2 divide-y divide-slate-200 border border-slate-300">
        {results.length ? (
          results.map((result, index) => (
            <div key={index} className="flex items-center justify-between gap-3 p-3">
              <span className="truncate text-xs text-slate-600">{jsonLabel(result)}</span>
              <RawDialog title="Tool result JSON" value={result} />
            </div>
          ))
        ) : (
          <div className="p-3 text-sm text-slate-500">No tool results</div>
        )}
      </div>
    </section>
  );
}

function RelatedEvent({ event }: { event: EventTimelineItem }) {
  return (
    <section className="border border-slate-300 p-3">
      <h3 className="text-sm font-semibold">Related event</h3>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-6">{event.text}</p>
      <p className="mt-2 font-mono text-[11px] text-slate-500">{event.eventId}</p>
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
            <p className="text-[11px] text-slate-500">{span.kind}</p>
          </div>
          <div className="relative h-7 border border-slate-200 bg-slate-50">
            <div
              className={cn(
                "absolute top-1 h-5 border",
                span.status === "error" && "border-red-700 bg-red-200",
                span.status !== "error" && span.kind === "generation" && "border-violet-700 bg-violet-200",
                span.status !== "error" && span.kind === "tool" && "border-emerald-700 bg-emerald-200",
                span.status !== "error" && span.kind === "span" && "border-cyan-700 bg-cyan-200",
                span.status !== "error" && span.kind !== "span" && span.kind !== "tool" && span.kind !== "generation" && "border-slate-700 bg-slate-200"
              )}
              style={{
                left: `${span.offsetPct}%`,
                width: `${span.widthPct}%`
              }}
            />
          </div>
          <div className="font-mono text-[11px] text-slate-500">
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
    <div className="divide-y divide-slate-200">
      {observations.map((observation) => (
        <div key={observation.id} className="p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <StatusPill tone={observation.level === "ERROR" ? "error" : observation.type === "generation" ? "info" : "neutral"}>
                  {observation.type}
                </StatusPill>
                <span className="truncate font-mono text-xs">{observation.name}</span>
              </div>
              <p className="mt-2 truncate text-xs text-slate-500">
                {observation.model ?? observation.statusMessage ?? observation.startedAt ?? observation.id}
              </p>
            </div>
            <RawDialog title="Observation JSON" value={observation} />
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-700">
            {jsonLabel(observation.output ?? observation.metadata ?? observation.input)}
          </p>
        </div>
      ))}
    </div>
  );
}

function RawDialog({ title, value }: { title: string; value: unknown }) {
  return (
    <Dialog
      title={title}
      trigger={
        <IconButton className="h-8 w-8">
          <Braces size={14} />
        </IconButton>
      }
    >
      <ScrollArea className="h-[72vh]">
        <JsonBlock value={value} />
      </ScrollArea>
    </Dialog>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  return (
    <pre className="overflow-auto bg-slate-950 p-4 font-mono text-xs leading-5 text-slate-100">
      {JSON.stringify(value, null, 2)}
    </pre>
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
    <div className={cn("m-4 grid min-h-40 place-items-center border border-dashed p-6 text-center", tone === "error" ? "border-red-700 bg-red-50 text-red-900" : "border-slate-300 bg-white text-slate-500")}>
      <div>
        <div className="mx-auto grid h-10 w-10 place-items-center border border-current">
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
    return <span className="h-2 w-2 bg-red-600" />;
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "warning")) {
    return <span className="h-2 w-2 bg-amber-500" />;
  }
  if (diagnostics.length) {
    return <span className="h-2 w-2 bg-cyan-500" />;
  }
  return <span className="h-2 w-2 bg-emerald-500" />;
}

function StatusIcon({ status }: { status: TraceSummary["status"] }) {
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
