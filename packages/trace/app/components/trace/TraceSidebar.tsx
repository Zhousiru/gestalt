import type {
  ConversationSummary,
  LiveOverview,
  LiveSignal,
  RolloutStatus,
  RolloutSummary
} from "@gestalt/live-contracts";
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  MessageSquare,
  Radio,
  Search
} from "lucide-react";
import type { ReactNode, Ref } from "react";
import type { LoadState } from "../../hooks/useLiveData";
import {
  formatDuration,
  formatTime,
  shortId,
  signalTotal,
  statusTone
} from "../../lib/format";
import {
  ScrollArea,
  StatusPill,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  cn
} from "../ui";
import { EmptyState, ErrorNotice, SkeletonRows } from "./StateViews";

type PagedListState<T> = {
  items: T[];
  nextCursor: string | undefined;
  state: LoadState;
  error: string | undefined;
  loadingMore: boolean;
  reload: (quiet?: boolean) => Promise<void>;
  loadMore: () => Promise<void>;
};

export function TraceSidebar({
  overview,
  query,
  onQueryChange,
  rolloutStatus,
  onRolloutStatusChange,
  conversations,
  rollouts,
  selectedConversationKey,
  selectedConversationButtonRef,
  selectedRolloutId,
  selectedRolloutButtonRef,
  onSelectConversation,
  onSelectRollout,
  className
}: {
  overview: LiveOverview | undefined;
  query: string;
  onQueryChange: (value: string) => void;
  rolloutStatus: RolloutStatus | undefined;
  onRolloutStatusChange: (value: RolloutStatus | undefined) => void;
  conversations: PagedListState<ConversationSummary>;
  rollouts: PagedListState<RolloutSummary>;
  selectedConversationKey: string | undefined;
  selectedConversationButtonRef?: Ref<HTMLButtonElement> | undefined;
  selectedRolloutId: string | undefined;
  selectedRolloutButtonRef?: Ref<HTMLButtonElement> | undefined;
  onSelectConversation: (conversation: ConversationSummary) => void;
  onSelectRollout: (rollout: RolloutSummary) => void;
  className?: string;
}) {
  const visibleSignals = filterSignals(overview?.signals ?? [], query);

  return (
    <aside
      aria-label="Trace navigation"
      className={cn(
        "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden border-r border-neutral-200 bg-white",
        className
      )}
    >
      <div className="border-b border-neutral-200 p-3">
        <label className="flex h-10 items-center rounded-md bg-neutral-50 px-3 text-sm ring-1 ring-inset ring-neutral-300 focus-within:bg-white focus-within:ring-2 focus-within:ring-[var(--trace-accent)]">
          <Search aria-hidden="true" className="mr-2 shrink-0 text-neutral-600" size={15} />
          <span className="sr-only">Search chats and rollouts</span>
          <input
            className="min-w-0 flex-1 bg-transparent text-neutral-950 outline-none placeholder:text-neutral-600"
            onChange={(event) => onQueryChange(event.currentTarget.value)}
            placeholder="Search chats and rollouts"
            type="search"
            value={query}
          />
        </label>
      </div>

      <Tabs className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]" defaultValue="chats">
        <TabsList aria-label="Trace data">
          <TabsTrigger value="chats">
            Chats <Count value={overview?.counts.conversations} />
          </TabsTrigger>
          <TabsTrigger value="rollouts">
            Rollouts <Count suffix={overview?.counts.rolloutsCapped ? "+" : ""} value={overview?.counts.rollouts} />
          </TabsTrigger>
          <TabsTrigger value="signals">
            Signals <Count value={overview?.counts.signals} />
          </TabsTrigger>
        </TabsList>

        <TabsContent className="min-h-0 overflow-hidden" value="chats">
          <PagedList
            emptyDescription={
              query
                ? "Try a broader server search."
                : "New conversations appear here as journal messages arrive."
            }
            emptyTitle={query ? "No matching chats" : "No chats yet"}
            {...conversations}
          >
            {(conversation) => (
              <ConversationRow
                conversation={conversation}
                key={conversation.key}
                onSelect={() => onSelectConversation(conversation)}
                buttonRef={
                  selectedConversationKey === conversation.key
                    ? selectedConversationButtonRef
                    : undefined
                }
                selected={selectedConversationKey === conversation.key}
              />
            )}
          </PagedList>
        </TabsContent>

        <TabsContent className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden" value="rollouts">
          <div className="border-b border-neutral-200 p-2">
            <label className="flex items-center justify-between gap-2 text-xs font-medium text-neutral-700">
              Status
              <select
                className="h-8 rounded-md bg-white px-2 text-xs text-neutral-900 ring-1 ring-inset ring-neutral-300 outline-none focus:ring-2 focus:ring-[var(--trace-accent)]"
                onChange={(event) =>
                  onRolloutStatusChange(
                    event.currentTarget.value
                      ? (event.currentTarget.value as RolloutStatus)
                      : undefined
                  )
                }
                value={rolloutStatus ?? ""}
              >
                <option value="">All</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>
          </div>
          <PagedList
            emptyDescription={
              query || rolloutStatus
                ? "Clear a filter or try a broader server search."
                : "A rollout appears when an active model loop starts."
            }
            emptyTitle={query || rolloutStatus ? "No matching rollouts" : "No rollouts yet"}
            {...rollouts}
          >
            {(rollout) => (
              <RolloutRow
                key={rollout.id}
                onSelect={() => onSelectRollout(rollout)}
                rollout={rollout}
                buttonRef={
                  selectedRolloutId === rollout.id
                    ? selectedRolloutButtonRef
                    : undefined
                }
                selected={selectedRolloutId === rollout.id}
              />
            )}
          </PagedList>
        </TabsContent>

        <TabsContent className="min-h-0 overflow-hidden" value="signals">
          <ScrollArea className="h-full">
            {visibleSignals.length ? (
              <div className="space-y-1 p-2">
                {visibleSignals.map((signal) => (
                  <SignalRow key={signal.id} signal={signal} />
                ))}
              </div>
            ) : (
              <EmptyState
                description={
                  query
                    ? "No recent signal contains that text."
                    : "Warnings and runtime failures will be summarized here."
                }
                title={query ? "No matching signals" : "No recent signals"}
              />
            )}
          </ScrollArea>
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function PagedList<T>({
  items,
  nextCursor,
  state,
  error,
  loadingMore,
  reload,
  loadMore,
  emptyTitle,
  emptyDescription,
  children
}: PagedListState<T> & {
  emptyTitle: string;
  emptyDescription: string;
  children: (item: T) => ReactNode;
}) {
  if (state === "loading" && !items.length) return <SkeletonRows rows={6} />;
  if (state === "error" && !items.length) {
    return <ErrorNotice compact message={error ?? "Unknown error"} onRetry={() => void reload()} />;
  }
  return (
    <ScrollArea className="h-full">
      {error ? <ErrorNotice compact message={error} onRetry={() => void reload(true)} /> : null}
      {items.length ? <div className="space-y-1 p-2">{items.map(children)}</div> : (
        <EmptyState description={emptyDescription} title={emptyTitle} />
      )}
      {nextCursor ? (
        <div className="p-2 pt-0">
          <button
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            disabled={loadingMore}
            onClick={() => void loadMore()}
            type="button"
          >
            {loadingMore ? <Loader2 aria-hidden="true" className="animate-spin" size={14} /> : null}
            {loadingMore ? "Loading" : "Load more"}
          </button>
        </div>
      ) : null}
    </ScrollArea>
  );
}

function ConversationRow({
  conversation,
  selected,
  onSelect,
  buttonRef
}: {
  conversation: ConversationSummary;
  selected: boolean;
  onSelect: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  const signalCount = signalTotal(conversation.signals);
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(
        "trace-list-row block w-full rounded-md px-3 py-3 text-left outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
        selected && "bg-[var(--trace-accent-soft)] ring-1 ring-inset ring-[var(--trace-accent-border)] hover:bg-[var(--trace-accent-soft)]"
      )}
      onClick={onSelect}
      ref={buttonRef}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <MessageSquare aria-hidden="true" className="shrink-0 text-neutral-500" size={14} />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-neutral-950">
          {conversation.name ?? conversation.key}
        </span>
        <span className="shrink-0 text-[11px] text-neutral-600">{formatTime(conversation.lastAt)}</span>
      </div>
      <p className="mt-1.5 line-clamp-2 break-words text-xs leading-5 text-neutral-600">
        {conversation.lastText || "No message preview"}
      </p>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-neutral-600">
        <span>{conversation.messageCount} messages</span>
        <span aria-hidden="true">·</span>
        <span>{conversation.rolloutCount} rollouts</span>
        {signalCount ? (
          <span className="ml-auto inline-flex items-center gap-1 text-amber-800">
            <AlertTriangle aria-hidden="true" size={11} /> {signalCount}
          </span>
        ) : null}
      </div>
    </button>
  );
}

function RolloutRow({
  rollout,
  selected,
  onSelect,
  buttonRef
}: {
  rollout: RolloutSummary;
  selected: boolean;
  onSelect: () => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <button
      aria-current={selected ? "true" : undefined}
      className={cn(
        "trace-list-row block w-full rounded-md px-3 py-3 text-left outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
        selected && "bg-[var(--trace-accent-soft)] ring-1 ring-inset ring-[var(--trace-accent-border)] hover:bg-[var(--trace-accent-soft)]"
      )}
      onClick={onSelect}
      ref={buttonRef}
      type="button"
    >
      <div className="flex min-w-0 items-center gap-2">
        <StatusIcon status={rollout.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-xs font-medium text-neutral-950" title={rollout.id}>
          {shortId(rollout.id, 16)}
        </span>
        <ChevronRight aria-hidden="true" className="shrink-0 text-neutral-400" size={14} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill tone={statusTone(rollout.status)}>{rollout.status}</StatusPill>
        {rollout.phase ? <StatusPill>{rollout.phase}</StatusPill> : null}
        <span className="ml-auto text-[11px] text-neutral-600">{formatDuration(rollout.durationMs)}</span>
      </div>
      <p className="mt-2 truncate text-[11px] text-neutral-600">
        {rollout.model ?? "Model not reported"} · {rollout.generationCount} generations
      </p>
    </button>
  );
}

function SignalRow({ signal }: { signal: LiveSignal }) {
  return (
    <div className="rounded-md px-3 py-3 ring-1 ring-inset ring-neutral-200">
      <div className="flex items-start gap-2">
        <SignalIcon severity={signal.severity} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-neutral-950">{signal.title}</p>
          <p className="mt-1 break-words text-xs leading-5 text-neutral-600">{signal.message}</p>
          <p className="mt-2 font-mono text-[10px] text-neutral-500">{signal.code}</p>
        </div>
      </div>
    </div>
  );
}

function Count({ value, suffix = "" }: { value: number | undefined; suffix?: string }) {
  return value === undefined ? null : (
    <span className="ml-1 text-[10px] tabular-nums text-neutral-500">{value}{suffix}</span>
  );
}

function StatusIcon({ status }: { status: RolloutStatus }) {
  if (status === "completed") return <CheckCircle2 aria-hidden="true" className="shrink-0 text-emerald-600" size={14} />;
  if (status === "failed") return <AlertCircle aria-hidden="true" className="shrink-0 text-red-600" size={14} />;
  if (status === "running") return <Radio aria-hidden="true" className="shrink-0 text-[var(--trace-accent)]" size={14} />;
  return <AlertTriangle aria-hidden="true" className="shrink-0 text-amber-700" size={14} />;
}

function SignalIcon({ severity }: { severity: LiveSignal["severity"] }) {
  if (severity === "error") return <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0 text-red-600" size={14} />;
  if (severity === "warning") return <AlertTriangle aria-hidden="true" className="mt-0.5 shrink-0 text-amber-700" size={14} />;
  return <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0 text-blue-700" size={14} />;
}

function filterSignals(signals: LiveSignal[], query: string): LiveSignal[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return signals;
  return signals.filter((signal) =>
    [signal.code, signal.title, signal.message].some((value) =>
      value.toLocaleLowerCase().includes(needle)
    )
  );
}
