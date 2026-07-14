import {
  AlertCircle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Database,
  FileImage,
  ImageOff,
  Images,
  Layers3,
  Loader2,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppHeader } from "../components/AppHeader";
import {
  IconButton,
  StatusPill,
  Tooltip,
  TooltipProvider,
  cn,
} from "../components/ui";
import type {
  RuntimeLiveEventEnvelope,
  StickerCatalogItemView,
  StickerJobView,
  StickerManagementAction,
  StickerManagementResponse,
  StickerRecallResponse,
  StickerSnapshot,
} from "../lib/types";

type LoadState = "loading" | "ready" | "error";
type LiveState = "connecting" | "live" | "offline";
type RecallState = "idle" | "loading" | "ready" | "error";
type StatusFilter = "all" | "ready" | "processing" | "failed";
type SourceFilter = "all" | "mface" | "image-sticker";
type Selection =
  | { kind: "sticker"; id: string }
  | { kind: "job"; id: string };

const stickerEventNames = [
  "sticker.scraping.state_changed",
  "sticker.job.updated",
  "sticker.catalog.updated",
  "sticker.index.updated",
];

const fieldClass =
  "h-9 rounded-md bg-white px-3 text-sm text-neutral-900 ring-1 ring-inset ring-neutral-300 outline-none hover:ring-neutral-400 focus:ring-2 focus:ring-[var(--trace-accent)] disabled:cursor-not-allowed disabled:opacity-50";
const focusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1";
const CATALOG_PAGE_SIZE = 24;
const OFFLINE_POLL_INTERVAL_MS = 30_000;

export default function StickersExplorer() {
  const [snapshot, setSnapshot] = useState<StickerSnapshot>();
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [liveState, setLiveState] = useState<LiveState>("connecting");
  const [error, setError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("all");
  const [catalogPage, setCatalogPage] = useState(0);
  const [selection, setSelection] = useState<Selection>();
  const [checkedStickerIds, setCheckedStickerIds] = useState<Set<string>>(
    () => new Set()
  );
  const [managementAction, setManagementAction] =
    useState<StickerManagementAction>();
  const [managementNotice, setManagementNotice] = useState<{
    tone: "ok" | "error";
    message: string;
  }>();
  const [deleteCandidateIds, setDeleteCandidateIds] = useState<string[]>([]);
  const [selectedStickerCache, setSelectedStickerCache] =
    useState<StickerCatalogItemView>();
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const snapshotRef = useRef<StickerSnapshot | undefined>(undefined);
  const loadSnapshotRef = useRef<() => Promise<void>>(async () => undefined);
  const requestIdRef = useRef(0);
  const refreshTimerRef = useRef<number | undefined>(undefined);
  const debouncedQuery = useDebouncedValue(query, 250);
  const desktopDetailVisible = useMediaQuery("(min-width: 1280px)");

  const loadSnapshot = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    if (!snapshotRef.current) {
      setLoadState("loading");
    }
    setRefreshing(true);
    try {
      const params = new URLSearchParams({
        offset: String(catalogPage * CATALOG_PAGE_SIZE),
        limit: String(CATALOG_PAGE_SIZE),
      });
      if (debouncedQuery.trim()) {
        params.set("query", debouncedQuery.trim());
      }
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      if (sourceFilter !== "all") {
        params.set("source", sourceFilter);
      }
      const response = await fetch(`/api/live/stickers/snapshot?${params}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`Sticker snapshot request failed with ${response.status}`);
      }
      const nextSnapshot = (await response.json()) as StickerSnapshot;
      if (requestId !== requestIdRef.current) {
        return;
      }
      snapshotRef.current = nextSnapshot;
      setSnapshot(nextSnapshot);
      setLoadState("ready");
      setError(undefined);
    } catch (snapshotError) {
      if (requestId !== requestIdRef.current) {
        return;
      }
      setLoadState(snapshotRef.current ? "ready" : "error");
      setError(
        snapshotError instanceof Error ? snapshotError.message : String(snapshotError)
      );
    } finally {
      if (requestId === requestIdRef.current) {
        setRefreshing(false);
      }
    }
  }, [catalogPage, debouncedQuery, sourceFilter, statusFilter]);

  useEffect(() => {
    loadSnapshotRef.current = loadSnapshot;
  }, [loadSnapshot]);

  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== undefined) {
      window.clearTimeout(refreshTimerRef.current);
    }
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = undefined;
      void loadSnapshotRef.current();
    }, 160);
  }, []);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  useEffect(() => {
    setCatalogPage(0);
  }, [debouncedQuery, sourceFilter, statusFilter]);

  useEffect(() => {
    const source = new EventSource("/api/live/events");
    const handleLiveEvent = (event: Event) => {
      setLiveState("live");
      const envelope = parseLiveEvent(event);
      if (envelope && stickerEventNames.includes(envelope.type)) {
        scheduleRefresh();
      }
    };
    const handleStickerEvent = () => {
      setLiveState("live");
      scheduleRefresh();
    };

    source.onopen = () => {
      setLiveState("live");
      void loadSnapshotRef.current();
    };
    source.addEventListener("live", handleLiveEvent);
    source.onmessage = handleLiveEvent;
    for (const eventName of stickerEventNames) {
      source.addEventListener(eventName, handleStickerEvent);
    }
    source.onerror = () => setLiveState("offline");

    return () => {
      source.close();
      if (refreshTimerRef.current !== undefined) {
        window.clearTimeout(refreshTimerRef.current);
      }
    };
  }, [scheduleRefresh]);

  useEffect(() => {
    if (liveState !== "offline") {
      return;
    }
    void loadSnapshotRef.current();
    const poll = window.setInterval(() => {
      void loadSnapshotRef.current();
    }, OFFLINE_POLL_INTERVAL_MS);
    return () => window.clearInterval(poll);
  }, [liveState]);

  useEffect(() => {
    if (desktopDetailVisible) {
      setMobileDetailOpen(false);
    }
  }, [desktopDetailVisible]);

  const visibleStickers = snapshot?.stickers ?? [];
  const filtersActive =
    Boolean(query.trim()) || statusFilter !== "all" || sourceFilter !== "all";

  useEffect(() => {
    if (!snapshot?.available) {
      if (selection) {
        setSelection(undefined);
      }
      setSelectedStickerCache(undefined);
      setMobileDetailOpen(false);
      return;
    }
    if (
      selection?.kind === "job" &&
      snapshot.jobs.some((item) => item.id === selection.id)
    ) {
      return;
    }

    const selectableStickers = snapshot.stickers;
    if (
      selection?.kind === "sticker" &&
      selectableStickers.some((item) => item.id === selection.id)
    ) {
      return;
    }
    if (
      selection?.kind === "sticker" &&
      selectedStickerCache?.id === selection.id
    ) {
      return;
    }
    const firstSticker = selectableStickers[0];
    const firstJob = filtersActive ? undefined : snapshot.jobs[0];
    const nextSelection: Selection | undefined = firstSticker
      ? { kind: "sticker", id: firstSticker.id }
      : firstJob
        ? { kind: "job", id: firstJob.id }
        : undefined;
    if (
      selection?.kind !== nextSelection?.kind ||
      selection?.id !== nextSelection?.id
    ) {
      setSelection(nextSelection);
    }
  }, [filtersActive, selectedStickerCache, selection, snapshot, visibleStickers]);

  useEffect(() => {
    if (selection?.kind !== "sticker") {
      return;
    }
    const current = snapshot?.stickers.find(
      (item) => item.id === selection.id
    );
    if (current && current !== selectedStickerCache) {
      setSelectedStickerCache(current);
    }
  }, [selectedStickerCache, selection, snapshot]);

  useEffect(() => {
    if (!snapshot?.available) {
      return;
    }
    const lastPage = Math.max(
      0,
      Math.ceil(snapshot.catalog.total / CATALOG_PAGE_SIZE) - 1
    );
    if (catalogPage > lastPage) {
      setCatalogPage(lastPage);
    }
  }, [catalogPage, snapshot]);

  const sortedJobs = useMemo(
    () => [...(snapshot?.jobs ?? [])].sort(compareUpdatedAt),
    [snapshot?.jobs]
  );

  const selectedSticker =
    selection?.kind === "sticker"
      ? (snapshot?.stickers.find((item) => item.id === selection.id) ??
        (selectedStickerCache?.id === selection.id
          ? selectedStickerCache
          : undefined))
      : undefined;
  const selectedJob =
    selection?.kind === "job"
      ? snapshot?.jobs.find((item) => item.id === selection.id)
      : undefined;
  const selectForInspection = (nextSelection: Selection) => {
    setSelection(nextSelection);
    if (nextSelection.kind === "sticker") {
      const selected = snapshot?.stickers.find(
        (item) => item.id === nextSelection.id
      );
      if (selected) {
        setSelectedStickerCache(selected);
      }
    }
    if (!desktopDetailVisible) {
      setMobileDetailOpen(true);
    }
  };

  const toggleStickerChecked = (stickerId: string, checked: boolean) => {
    setCheckedStickerIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(stickerId);
      } else {
        next.delete(stickerId);
      }
      return next;
    });
  };

  const toggleVisibleStickers = (checked: boolean) => {
    setCheckedStickerIds((current) => {
      const next = new Set(current);
      for (const sticker of visibleStickers) {
        if (checked) {
          next.add(sticker.id);
        } else {
          next.delete(sticker.id);
        }
      }
      return next;
    });
  };

  const runManagement = async (
    action: StickerManagementAction,
    stickerIds: readonly string[]
  ) => {
    const uniqueIds = [...new Set(stickerIds)];
    if (uniqueIds.length === 0 || managementAction) {
      return;
    }
    setManagementAction(action);
    setManagementNotice(undefined);
    try {
      const response = await fetch("/api/live/stickers/manage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, stickerIds: uniqueIds }),
      });
      const payload = (await response.json()) as StickerManagementResponse & {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error || `Sticker ${action} failed with ${response.status}`);
      }
      const succeededIds = new Set(
        payload.results.filter((result) => result.ok).map((result) => result.stickerId)
      );
      if (action === "delete" && succeededIds.size > 0) {
        setCheckedStickerIds((current) => {
          const next = new Set(current);
          for (const stickerId of succeededIds) {
            next.delete(stickerId);
          }
          return next;
        });
        setSelection((current) =>
          current?.kind === "sticker" && succeededIds.has(current.id)
            ? undefined
            : current
        );
        setSelectedStickerCache((current) =>
          current && succeededIds.has(current.id) ? undefined : current
        );
        setMobileDetailOpen(false);
      }
      const firstFailure = payload.results.find((result) => !result.ok);
      const verb = action === "delete" ? "Deleted" : "Rebuilt";
      setManagementNotice({
        tone: payload.failed > 0 ? "error" : "ok",
        message:
          payload.failed > 0
            ? `${verb} ${payload.succeeded} of ${payload.requested}. ${payload.failed} failed${firstFailure?.error ? `: ${firstFailure.error}` : "."}`
            : `${verb} ${payload.succeeded} ${payload.succeeded === 1 ? "sticker" : "stickers"}.`,
      });
      await loadSnapshot();
    } catch (managementError) {
      setManagementNotice({
        tone: "error",
        message:
          managementError instanceof Error
            ? managementError.message
            : String(managementError),
      });
    } finally {
      setManagementAction(undefined);
      setDeleteCandidateIds([]);
    }
  };

  return (
    <TooltipProvider>
      <main className="grid h-screen grid-rows-[auto_minmax(0,1fr)] bg-[var(--trace-bg)] text-neutral-950">
        <AppHeader
          current="stickers"
          actions={
            <>
              <StatusPill
                tone={liveState === "live" ? "ok" : liveState === "offline" ? "error" : "info"}
              >
                <Radio aria-hidden="true" className="mr-1" size={12} />
                {liveState}
              </StatusPill>
              {snapshot ? (
                <span
                  className="hidden text-xs text-neutral-500 lg:inline"
                  title={formatDateTime(snapshot.generatedAt)}
                >
                  synced {formatRelativeTime(snapshot.generatedAt)}
                </span>
              ) : null}
              <Tooltip label="Refresh sticker snapshot">
                <IconButton
                  aria-label="Refresh sticker snapshot"
                  disabled={refreshing}
                  onClick={() => void loadSnapshot()}
                >
                  {refreshing ? <Loader2 size={16} /> : <RefreshCw size={16} />}
                </IconButton>
              </Tooltip>
            </>
          }
        />

        <div className="min-h-0 min-w-0 overflow-x-hidden overflow-y-auto">
          {snapshot?.available ? (
            <>
              <Overview snapshot={snapshot} />
              {error ? <RefreshWarning error={error} onRetry={() => void loadSnapshot()} /> : null}
              <div className="mx-auto grid min-w-0 w-full max-w-[1600px] grid-cols-[minmax(0,1fr)] items-start xl:grid-cols-[minmax(0,1fr)_380px]">
                <div className="min-w-0 space-y-4 p-3 sm:p-5 lg:p-6">
                  <RecallTestPanel embedding={snapshot.embedding} />
                  <JobsPanel
                    jobs={sortedJobs}
                    selectedId={selection?.kind === "job" ? selection.id : undefined}
                    onSelect={(id) =>
                      selectForInspection({ kind: "job", id })
                    }
                  />
                  <CatalogPanel
                    catalog={snapshot.catalog}
                    filtersActive={filtersActive}
                    query={query}
                    sourceFilter={sourceFilter}
                    statusFilter={statusFilter}
                    stickers={visibleStickers}
                    selectedId={selection?.kind === "sticker" ? selection.id : undefined}
                    checkedIds={checkedStickerIds}
                    managementAction={managementAction}
                    managementNotice={managementNotice}
                    onQueryChange={setQuery}
                    onSourceFilterChange={setSourceFilter}
                    onStatusFilterChange={setStatusFilter}
                    onReset={() => {
                      setQuery("");
                      setStatusFilter("all");
                      setSourceFilter("all");
                    }}
                    onPageChange={setCatalogPage}
                    onClearChecked={() => setCheckedStickerIds(new Set())}
                    onDeleteChecked={() =>
                      setDeleteCandidateIds([...checkedStickerIds])
                    }
                    onRebuildChecked={() =>
                      void runManagement("rebuild", [...checkedStickerIds])
                    }
                    onToggleChecked={toggleStickerChecked}
                    onToggleVisible={toggleVisibleStickers}
                    page={catalogPage}
                    onSelect={(id) =>
                      selectForInspection({ kind: "sticker", id })
                    }
                  />
                </div>
                <DetailPanel
                  sticker={selectedSticker}
                  job={selectedJob}
                  managementAction={managementAction}
                  onDelete={(stickerId) => setDeleteCandidateIds([stickerId])}
                  onRebuild={(stickerId) =>
                    void runManagement("rebuild", [stickerId])
                  }
                />
              </div>
              <MobileDetailDrawer
                job={selectedJob}
                managementAction={managementAction}
                open={mobileDetailOpen}
                sticker={selectedSticker}
                onDelete={(stickerId) => setDeleteCandidateIds([stickerId])}
                onOpenChange={setMobileDetailOpen}
                onRebuild={(stickerId) =>
                  void runManagement("rebuild", [stickerId])
                }
              />
              <DeleteConfirmationDialog
                busy={managementAction === "delete"}
                count={deleteCandidateIds.length}
                open={deleteCandidateIds.length > 0}
                onCancel={() => setDeleteCandidateIds([])}
                onConfirm={() =>
                  void runManagement("delete", deleteCandidateIds)
                }
              />
            </>
          ) : snapshot ? (
            <SubsystemUnavailable
              error={error}
              reason={snapshot.unavailableReason}
              onRetry={() => void loadSnapshot()}
            />
          ) : loadState === "error" ? (
            <LoadError error={error} onRetry={() => void loadSnapshot()} />
          ) : (
            <LoadingWorkspace />
          )}
        </div>
      </main>
    </TooltipProvider>
  );
}

function Overview({ snapshot }: { snapshot: StickerSnapshot }) {
  const { embedding, processing, scraping } = snapshot;
  return (
    <section className="border-b border-neutral-200 bg-white">
      <div className="mx-auto w-full max-w-[1600px]">
        <div className="flex flex-wrap items-start justify-between gap-4 px-4 py-5 sm:px-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-lg font-semibold tracking-[-0.02em]">Stickers</h1>
              <StatusPill tone={scraping.effectiveEnabled ? "ok" : "neutral"}>
                collection {scraping.effectiveEnabled ? "on" : "off"}
              </StatusPill>
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-neutral-600">
              {scraping.effectiveEnabled
                ? "New QQ stickers are accepted while queued analysis continues in the background."
                : "New observations are paused. Already collected stickers continue through analysis and indexing."}
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs text-neutral-600">
            <span>
              Default <strong className="font-medium text-neutral-900">{scraping.configuredEnabled ? "on" : "off"}</strong>
            </span>
            <span aria-hidden="true" className="h-4 w-px bg-neutral-200" />
            <span>
              Override{" "}
              <strong className="font-medium text-neutral-900">
                {scraping.runtimeOverride === undefined ? "none" : scraping.runtimeOverride ? "on" : "off"}
              </strong>
            </span>
          </div>
        </div>

        <dl className="grid grid-cols-2 border-t border-neutral-200 sm:grid-cols-3 xl:grid-cols-6">
          <Metric label="Ready" value={processing.ready} tone="ok" />
          <Metric label="Processing" value={processing.running} tone={processing.running > 0 ? "info" : "neutral"} />
          <Metric label="Queued" value={processing.queued} tone={processing.queued > 0 ? "warning" : "neutral"} />
          <Metric label="Failed" value={processing.failed} tone={processing.failed > 0 ? "error" : "neutral"} />
          <Metric label="Duplicates" value={processing.duplicates} tone="neutral" />
          <Metric label="Vector rows" value={embedding.rowCount} tone={indexTone(embedding.indexState)} />
        </dl>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-neutral-200 px-4 py-3 text-xs text-neutral-600 sm:px-6">
          <span className="flex items-center gap-2 font-medium text-neutral-900">
            <Database aria-hidden="true" size={14} />
            Vector index
          </span>
          <StatusPill tone={indexTone(embedding.indexState)}>{embedding.indexState}</StatusPill>
          <span className="min-w-0 truncate">
            {[embedding.provider, embedding.model].filter(Boolean).join(" / ") || "model not reported"}
          </span>
          <span>{embedding.dimensions ? `${embedding.dimensions} dimensions` : "dimensions unknown"}</span>
          <span>{embedding.distanceMetric} distance</span>
          {embedding.id ? (
            <span className="font-mono" title={embedding.id}>
              space {shortId(embedding.id)}
            </span>
          ) : null}
        </div>
        {embedding.error ? (
          <div className="flex items-start gap-2 border-t border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-800 sm:px-6">
            <AlertCircle aria-hidden="true" className="mt-0.5 shrink-0" size={14} />
            <span>{embedding.error}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "neutral" | "ok" | "warning" | "error" | "info";
}) {
  return (
    <div className="border-b border-r border-neutral-200 px-4 py-3 last:border-r-0 sm:px-6 xl:border-b-0">
      <dt className="text-xs text-neutral-500">{label}</dt>
      <dd
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "ok" && "text-emerald-700",
          tone === "info" && "text-[var(--trace-accent)]",
          tone === "warning" && "text-amber-700",
          tone === "error" && "text-red-700",
          tone === "neutral" && "text-neutral-950"
        )}
      >
        {formatCount(value)}
      </dd>
    </div>
  );
}

function RecallTestPanel({
  embedding,
}: {
  embedding: StickerSnapshot["embedding"];
}) {
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(3);
  const [state, setState] = useState<RecallState>("idle");
  const [response, setResponse] = useState<StickerRecallResponse>();
  const [error, setError] = useState<string>();
  const controllerRef = useRef<AbortController | undefined>(undefined);

  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    []
  );

  const runRecall = async () => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || state === "loading") {
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState("loading");
    setResponse(undefined);
    setError(undefined);
    try {
      const recallResponse = await fetch("/api/live/stickers/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: normalizedQuery, limit }),
        signal: controller.signal,
      });
      const payload = (await recallResponse.json()) as
        | StickerRecallResponse
        | { error?: string };
      if (!recallResponse.ok) {
        throw new Error(
          "error" in payload && payload.error
            ? payload.error
            : `Sticker recall request failed with ${recallResponse.status}`
        );
      }
      setResponse(payload as StickerRecallResponse);
      setState("ready");
    } catch (recallError) {
      if (controller.signal.aborted) {
        return;
      }
      setError(
        recallError instanceof Error ? recallError.message : String(recallError)
      );
      setState("error");
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = undefined;
      }
    }
  };

  return (
    <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Recall test</h2>
          <p className="mt-0.5 text-xs leading-5 text-neutral-500">
            Embed text against the live LanceDB catalog. This test never sends a sticker.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={indexTone(embedding.indexState)}>
            index {embedding.indexState}
          </StatusPill>
          {embedding.dimensions ? (
            <span className="text-xs text-neutral-500">
              {embedding.distanceMetric} · {embedding.dimensions}d
            </span>
          ) : null}
        </div>
      </header>

      <form
        className="grid items-end gap-3 p-4 sm:grid-cols-[minmax(0,1fr)_104px_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          void runRecall();
        }}
      >
        <label className="min-w-0">
          <span className="mb-1.5 block text-xs font-medium text-neutral-700">
            Query text
          </span>
          <textarea
            className={cn(
              "min-h-20 w-full resize-y rounded-md bg-white px-3 py-2 text-sm leading-5 text-neutral-900 ring-1 ring-inset ring-neutral-300 outline-none placeholder:text-neutral-500 hover:ring-neutral-400 focus:ring-2 focus:ring-[var(--trace-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            )}
            disabled={state === "loading"}
            maxLength={1000}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="e.g. celebrate a small win"
            rows={2}
            value={query}
          />
          <span className="mt-1 block text-[11px] text-neutral-500">
            Ctrl/⌘ + Enter to run
          </span>
        </label>
        <label>
          <span className="mb-1.5 block text-xs font-medium text-neutral-700">
            Results
          </span>
          <select
            className={cn(fieldClass, "w-full")}
            disabled={state === "loading"}
            onChange={(event) => setLimit(Number(event.currentTarget.value))}
            value={limit}
          >
            {[3, 5, 10, 20].map((value) => (
              <option key={value} value={value}>
                Top {value}
              </option>
            ))}
          </select>
        </label>
        <button
          className={cn(
            "inline-flex h-9 items-center justify-center gap-2 rounded-md bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40",
            focusClass
          )}
          disabled={!query.trim() || state === "loading"}
          type="submit"
        >
          {state === "loading" ? (
            <Loader2
              aria-hidden="true"
              className="animate-spin motion-reduce:animate-none"
              size={15}
            />
          ) : (
            <Search aria-hidden="true" size={15} />
          )}
          {state === "loading" ? "Embedding…" : "Run recall"}
        </button>
      </form>

      <div aria-live="polite">
        {state === "loading" ? <RecallLoadingRows /> : null}
        {state === "error" && error ? (
          <div className="border-t border-red-200 bg-red-50 px-4 py-3 text-xs text-red-800" role="alert">
            <span className="flex items-center gap-2 font-semibold">
              <AlertCircle aria-hidden="true" size={14} />
              Recall failed
            </span>
            <p className="mt-1.5 leading-5">{error}</p>
          </div>
        ) : null}
        {state === "ready" && response ? (
          <RecallResults response={response} />
        ) : null}
      </div>
    </section>
  );
}

function RecallLoadingRows() {
  return (
    <div className="border-t border-neutral-200" role="status">
      <span className="sr-only">Generating embedding and searching stickers</span>
      {[0, 1, 2].map((row) => (
        <div
          className="grid grid-cols-[24px_56px_minmax(0,1fr)] gap-3 border-b border-neutral-100 px-4 py-3 last:border-b-0"
          key={row}
        >
          <div className="mt-1 h-3 rounded bg-neutral-100" />
          <div className="h-14 rounded-md bg-neutral-100" />
          <div className="space-y-2 py-1">
            <div className="h-3 w-2/3 rounded bg-neutral-200" />
            <div className="h-3 w-full rounded bg-neutral-100" />
            <div className="h-3 w-1/3 rounded bg-neutral-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecallResults({ response }: { response: StickerRecallResponse }) {
  return (
    <div className="border-t border-neutral-200">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-neutral-50 px-4 py-2 text-xs text-neutral-600">
        <span>
          <strong className="font-medium text-neutral-900">
            {formatCount(response.returned)}
          </strong>{" "}
          {response.returned === 1 ? "match" : "matches"} for “{response.query}”
        </span>
        <span title="Cosine similarity is vector similarity, not calibrated model confidence.">
          Cosine similarity = 1 − distance
        </span>
      </div>
      {response.results.length ? (
        <ol className="divide-y divide-neutral-100">
          {response.results.map((result) => (
            <li
              className="grid grid-cols-[24px_56px_minmax(0,1fr)] items-start gap-3 px-4 py-3 sm:grid-cols-[24px_64px_minmax(0,1fr)_160px]"
              key={result.stickerId}
            >
              <span className="pt-1 text-xs font-semibold tabular-nums text-neutral-500">
                {result.rank}
              </span>
              <StickerMedia
                alt="Retrieved sticker preview"
                className="h-14 w-14 sm:h-16 sm:w-16"
                src={result.contactSheetUrl ?? result.thumbnailUrl}
              />
              <div className="min-w-0">
                <p className="text-sm leading-5 text-neutral-900">{result.desc}</p>
                <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-neutral-500">
                  <span className="truncate font-mono" title={result.stickerId}>
                    {shortId(result.stickerId)}
                  </span>
                  <CopyButton value={result.stickerId} />
                  {result.contactSheetUrl ? (
                    <StatusPill tone="info">animated</StatusPill>
                  ) : null}
                </div>
              </div>
              <div className="col-span-2 col-start-2 min-w-0 sm:col-span-1 sm:col-start-auto sm:text-right">
                {result.similarity !== undefined ? (
                  <div className="flex items-baseline justify-between gap-2 sm:justify-end">
                    <span className="text-xs text-neutral-500">
                      Cosine similarity
                    </span>
                    <strong className="text-sm font-semibold tabular-nums text-neutral-900">
                      {formatCosineSimilarity(result.similarity)}
                    </strong>
                  </div>
                ) : (
                  <span className="text-xs text-neutral-500">
                    Similarity unavailable
                  </span>
                )}
                <p className="mt-1.5 text-[11px] tabular-nums text-neutral-500">
                  {result.distance !== undefined
                    ? `cosine distance ${formatDistance(result.distance)} · lower is closer`
                    : `${response.metric} distance not reported`}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <CompactEmpty
          icon={<Search />}
          title="No ready stickers recalled"
          body="The index returned no catalog-valid matches for this query."
        />
      )}
    </div>
  );
}

function JobsPanel({
  jobs,
  selectedId,
  onSelect,
}: {
  jobs: StickerJobView[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
      <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold">Analysis queue</h2>
          <p className="mt-0.5 text-xs text-neutral-500">Media resolution through LanceDB indexing</p>
        </div>
        <StatusPill tone={jobs.some(isActiveJob) ? "info" : "neutral"}>
          {jobs.filter(isActiveJob).length} active
        </StatusPill>
      </header>
      {jobs.length ? (
        <div className="max-h-[310px] overflow-y-auto">
          <div className="hidden grid-cols-[48px_minmax(220px,1fr)_minmax(150px,0.55fr)_110px] gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-medium text-neutral-500 md:grid">
            <span aria-hidden="true" />
            <span>Job</span>
            <span>Progress</span>
            <span className="text-right">Updated</span>
          </div>
          {jobs.map((job) => (
            <button
              key={job.id}
              aria-pressed={selectedId === job.id}
              className={cn(
                "grid w-full grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-3 border-b border-neutral-100 px-3 py-2.5 text-left last:border-b-0 hover:bg-neutral-50 md:grid-cols-[48px_minmax(220px,1fr)_minmax(150px,0.55fr)_110px]",
                focusClass,
                selectedId === job.id && "bg-[var(--trace-accent-soft)] hover:bg-[var(--trace-accent-soft)]"
              )}
              onClick={() => onSelect(job.id)}
              type="button"
            >
              <StickerMedia
                alt=""
                className="h-10 w-10"
                src={staticJobPreview(job)}
              />
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-xs text-neutral-900" title={job.id}>
                    {shortId(job.stickerId ?? job.id)}
                  </span>
                  <StatusPill tone={statusTone(job.status)}>{statusLabel(job.status)}</StatusPill>
                </div>
                <p className="mt-1 truncate text-xs text-neutral-500">
                  {job.desc || `${sourceLabel(job.sourceKind)} · ${job.conversationId}`}
                </p>
              </div>
              <div className="hidden min-w-0 md:block">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-medium text-neutral-700">{stageLabel(job.stage)}</span>
                  <span className="tabular-nums text-neutral-500">{stagePercent(job)}%</span>
                </div>
                <ProgressBar value={stagePercent(job)} tone={statusTone(job.status)} />
                {job.lastFailedStage && job.status === "queued" ? (
                  <p className="mt-1 truncate text-[11px] text-amber-700">
                    Retry after {stageLabel(job.lastFailedStage)} failed
                  </p>
                ) : null}
              </div>
              <time className="text-right text-xs text-neutral-500" dateTime={job.updatedAt}>
                {formatRelativeTime(job.updatedAt)}
              </time>
            </button>
          ))}
        </div>
      ) : (
        <CompactEmpty
          icon={<Layers3 />}
          title="No analysis jobs"
          body="New mface and image.sub_type=1 observations will appear here when collection is enabled."
        />
      )}
    </section>
  );
}

function CatalogPanel({
  catalog,
  checkedIds,
  filtersActive,
  managementAction,
  managementNotice,
  page,
  query,
  sourceFilter,
  statusFilter,
  stickers,
  selectedId,
  onQueryChange,
  onSourceFilterChange,
  onStatusFilterChange,
  onReset,
  onPageChange,
  onClearChecked,
  onDeleteChecked,
  onRebuildChecked,
  onSelect,
  onToggleChecked,
  onToggleVisible,
}: {
  catalog: StickerSnapshot["catalog"];
  checkedIds: ReadonlySet<string>;
  filtersActive: boolean;
  managementAction: StickerManagementAction | undefined;
  managementNotice: { tone: "ok" | "error"; message: string } | undefined;
  page: number;
  query: string;
  sourceFilter: SourceFilter;
  statusFilter: StatusFilter;
  stickers: StickerCatalogItemView[];
  selectedId: string | undefined;
  onQueryChange: (value: string) => void;
  onSourceFilterChange: (value: SourceFilter) => void;
  onStatusFilterChange: (value: StatusFilter) => void;
  onReset: () => void;
  onPageChange: (page: number) => void;
  onClearChecked: () => void;
  onDeleteChecked: () => void;
  onRebuildChecked: () => void;
  onSelect: (id: string) => void;
  onToggleChecked: (id: string, checked: boolean) => void;
  onToggleVisible: (checked: boolean) => void;
}) {
  const firstItem = catalog.total === 0 ? 0 : catalog.offset + 1;
  const lastItem = Math.min(catalog.total, catalog.offset + stickers.length);
  const pageCount = Math.max(1, Math.ceil(catalog.total / catalog.limit));
  const visibleCheckedCount = stickers.filter((sticker) =>
    checkedIds.has(sticker.id)
  ).length;
  const allVisibleChecked =
    stickers.length > 0 && visibleCheckedCount === stickers.length;
  return (
    <section className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
      <header className="border-b border-neutral-200 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Catalog</h2>
            <p className="mt-0.5 text-xs text-neutral-500">
              {catalog.total === 0
                ? filtersActive
                  ? "No matching stickers"
                  : "No stored stickers"
                : `${formatCount(firstItem)}–${formatCount(lastItem)} of ${formatCount(catalog.total)}${filtersActive ? " matching" : " stored"}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[190px] flex-1 sm:flex-none">
              <span className="sr-only">Search stickers</span>
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" size={14} />
              <input
                className={cn(fieldClass, "w-full pl-9 placeholder:text-neutral-500 sm:w-64")}
                onChange={(event) => onQueryChange(event.currentTarget.value)}
                placeholder="Search ID, description, chat"
                type="search"
                value={query}
              />
            </label>
            <label>
              <span className="sr-only">Source type</span>
              <select
                className={fieldClass}
                onChange={(event) => onSourceFilterChange(event.currentTarget.value as SourceFilter)}
                value={sourceFilter}
              >
                <option value="all">All sources</option>
                <option value="mface">Marketplace</option>
                <option value="image-sticker">Custom image</option>
              </select>
            </label>
          </div>
        </div>
        <div aria-label="Filter by status" className="mt-3 flex flex-wrap gap-1" role="group">
          {(["all", "ready", "processing", "failed"] as const).map((status) => (
            <button
              key={status}
              aria-pressed={statusFilter === status}
              className={cn(
                "h-8 rounded-md px-3 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950",
                focusClass,
                statusFilter === status && "bg-neutral-900 text-white hover:bg-neutral-900 hover:text-white"
              )}
              onClick={() => onStatusFilterChange(status)}
              type="button"
            >
              {status === "all" ? "All" : statusLabel(status)}
            </button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-neutral-200 pt-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <SelectionCheckbox
              checked={allVisibleChecked}
              indeterminate={visibleCheckedCount > 0 && !allVisibleChecked}
              disabled={stickers.length === 0 || Boolean(managementAction)}
              label="Select this page"
              onChange={onToggleVisible}
            />
            {checkedIds.size > 0 ? (
              <span className="text-xs font-medium tabular-nums text-neutral-700">
                {formatCount(checkedIds.size)} selected
              </span>
            ) : (
              <span className="text-xs text-neutral-500">
                Select one or more stickers to manage them
              </span>
            )}
          </div>
          {checkedIds.size > 0 ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                className={cn(
                  "h-8 rounded-md px-2.5 text-xs font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-950 disabled:cursor-not-allowed disabled:opacity-40",
                  focusClass
                )}
                disabled={Boolean(managementAction)}
                onClick={onClearChecked}
                type="button"
              >
                Clear
              </button>
              <button
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40",
                  focusClass
                )}
                disabled={Boolean(managementAction)}
                onClick={onRebuildChecked}
                type="button"
              >
                <RefreshCw
                  aria-hidden="true"
                  className={managementAction === "rebuild" ? "animate-spin" : undefined}
                  size={13}
                />
                Rebuild desc + index
              </button>
              <button
                className={cn(
                  "inline-flex h-8 items-center gap-1.5 rounded-md bg-red-600 px-3 text-xs font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-40",
                  focusClass
                )}
                disabled={Boolean(managementAction)}
                onClick={onDeleteChecked}
                type="button"
              >
                <Trash2 aria-hidden="true" size={13} />
                Delete
              </button>
            </div>
          ) : null}
        </div>
        {managementNotice ? (
          <div
            aria-live="polite"
            className={cn(
              "mt-3 rounded-md px-3 py-2 text-xs leading-5 ring-1 ring-inset",
              managementNotice.tone === "ok" &&
                "bg-emerald-50 text-emerald-800 ring-emerald-200",
              managementNotice.tone === "error" &&
                "bg-red-50 text-red-800 ring-red-200"
            )}
            role={managementNotice.tone === "error" ? "alert" : "status"}
          >
            {managementNotice.message}
          </div>
        ) : null}
      </header>

      {stickers.length ? (
        <>
          <div>
            {stickers.map((sticker) => (
              <StickerRow
                checked={checkedIds.has(sticker.id)}
                key={sticker.id}
                inspected={selectedId === sticker.id}
                sticker={sticker}
                onSelect={() => onSelect(sticker.id)}
                onToggleChecked={(checked) =>
                  onToggleChecked(sticker.id, checked)
                }
                selectionDisabled={Boolean(managementAction)}
              />
            ))}
          </div>
          <nav
            aria-label="Sticker catalog pages"
            className="flex items-center justify-between gap-3 border-t border-neutral-200 px-3 py-2.5 sm:px-4"
          >
            <span className="text-xs tabular-nums text-neutral-600">
              Page {page + 1} of {pageCount}
            </span>
            <div className="flex items-center gap-1.5">
              <button
                aria-label="Previous sticker page"
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40",
                  focusClass
                )}
                disabled={catalog.offset === 0}
                onClick={() => onPageChange(Math.max(0, page - 1))}
                type="button"
              >
                <ChevronLeft aria-hidden="true" size={14} />
                Previous
              </button>
              <button
                aria-label="Next sticker page"
                className={cn(
                  "inline-flex h-8 items-center gap-1 rounded-md px-2.5 text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40",
                  focusClass
                )}
                disabled={catalog.offset + stickers.length >= catalog.total}
                onClick={() => onPageChange(Math.min(pageCount - 1, page + 1))}
                type="button"
              >
                Next
                <ChevronRight aria-hidden="true" size={14} />
              </button>
            </div>
          </nav>
        </>
      ) : (
        <div className="px-4 py-10 text-center">
          <div className="mx-auto grid h-10 w-10 place-items-center rounded-md bg-neutral-100 text-neutral-500">
            <Images aria-hidden="true" size={19} />
          </div>
          <h3 className="mt-3 text-sm font-semibold">
            {filtersActive ? "No stickers match" : "The catalog is empty"}
          </h3>
          <p className="mx-auto mt-1 max-w-md text-sm leading-5 text-neutral-600">
            {filtersActive
              ? "Try another description, source, or processing status."
              : "Collected QQ stickers appear here after description, embedding, and LanceDB indexing finish."}
          </p>
          {filtersActive ? (
            <button
              className={cn(
                "mt-4 h-9 rounded-md bg-white px-3 text-sm font-medium text-neutral-800 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50",
                focusClass
              )}
              onClick={onReset}
              type="button"
            >
              Reset filters
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}

function SelectionCheckbox({
  checked,
  disabled,
  indeterminate,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  indeterminate: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate;
    }
  }, [indeterminate]);
  return (
    <label className="inline-flex min-h-8 cursor-pointer items-center gap-2 text-xs font-medium text-neutral-700 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50">
      <input
        ref={inputRef}
        checked={checked}
        className="h-4 w-4 rounded border-neutral-300 accent-[var(--trace-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

function StickerRow({
  checked,
  sticker,
  inspected,
  onSelect,
  onToggleChecked,
  selectionDisabled,
}: {
  checked: boolean;
  sticker: StickerCatalogItemView;
  inspected: boolean;
  onSelect: () => void;
  onToggleChecked: (checked: boolean) => void;
  selectionDisabled: boolean;
}) {
  return (
    <div
      className={cn(
        "grid w-full grid-cols-[32px_minmax(0,1fr)] border-b border-neutral-100 last:border-b-0",
        checked && "bg-neutral-50",
        inspected && "bg-[var(--trace-accent-soft)]"
      )}
    >
      <div className="grid place-items-center pl-3 sm:pl-4">
        <input
          aria-label={`Select sticker ${sticker.id}`}
          checked={checked}
          className="h-4 w-4 rounded border-neutral-300 accent-[var(--trace-accent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] focus-visible:ring-offset-1"
          disabled={selectionDisabled}
          onChange={(event) => onToggleChecked(event.currentTarget.checked)}
          type="checkbox"
        />
      </div>
      <button
        aria-current={inspected ? "true" : undefined}
        className={cn(
          "grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-3 px-3 py-3 text-left hover:bg-neutral-50 sm:grid-cols-[64px_minmax(0,1fr)_160px] sm:px-4",
          focusClass,
          inspected && "hover:bg-[var(--trace-accent-soft)]"
        )}
        onClick={onSelect}
        type="button"
      >
        <div className="relative">
          <StickerMedia
            alt={sticker.desc ? `Preview: ${sticker.desc}` : "Sticker preview"}
            className="h-16 w-16"
            src={staticStickerPreview(sticker)}
          />
          {sticker.animated ? (
            <span className="absolute bottom-1 right-1 rounded bg-neutral-950/80 px-1 py-0.5 text-[9px] font-semibold text-white">
              GIF
            </span>
          ) : null}
        </div>
        <div className="min-w-0 self-center">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-neutral-600">{shortId(sticker.id)}</span>
            <StatusPill tone={statusTone(sticker.status)}>{statusLabel(sticker.status)}</StatusPill>
            <StatusPill tone={statusTone(sticker.embeddingStatus)}>
              vector {statusLabel(sticker.embeddingStatus)}
            </StatusPill>
          </div>
          <p className="mt-1.5 line-clamp-2 text-sm leading-5 text-neutral-900">
            {sticker.desc || "Description pending"}
          </p>
          <p className="mt-1 truncate text-xs text-neutral-500 sm:hidden">
            {sourceLabel(sticker.sourceKind)} · {formatRelativeTime(sticker.updatedAt)}
          </p>
        </div>
        <div className="hidden self-center text-right text-xs text-neutral-500 sm:block">
          <p className="font-medium text-neutral-700">{sourceLabel(sticker.sourceKind)}</p>
          <time className="mt-1 block" dateTime={sticker.updatedAt}>
            {formatRelativeTime(sticker.updatedAt)}
          </time>
        </div>
      </button>
    </div>
  );
}

function DetailPanel({
  sticker,
  job,
  managementAction,
  onDelete,
  onRebuild,
}: {
  sticker: StickerCatalogItemView | undefined;
  job: StickerJobView | undefined;
  managementAction: StickerManagementAction | undefined;
  onDelete: (stickerId: string) => void;
  onRebuild: (stickerId: string) => void;
}) {
  return (
    <aside className="hidden min-h-[420px] border-l border-neutral-200 bg-white xl:sticky xl:top-0 xl:block xl:min-h-[calc(100vh-4rem)]">
      {sticker ? (
        <StickerDetail
          managementAction={managementAction}
          sticker={sticker}
          onDelete={onDelete}
          onRebuild={onRebuild}
        />
      ) : job ? (
        <JobDetail job={job} />
      ) : (
        <DetailEmpty />
      )}
    </aside>
  );
}

function MobileDetailDrawer({
  sticker,
  job,
  managementAction,
  open,
  onDelete,
  onOpenChange,
  onRebuild,
}: {
  sticker: StickerCatalogItemView | undefined;
  job: StickerJobView | undefined;
  managementAction: StickerManagementAction | undefined;
  open: boolean;
  onDelete: (stickerId: string) => void;
  onOpenChange: (open: boolean) => void;
  onRebuild: (stickerId: string) => void;
}) {
  const title = sticker ? `Sticker ${shortId(sticker.id)}` : job ? `Job ${shortId(job.id)}` : "Sticker details";
  return (
    <DialogPrimitive.Root open={open && Boolean(sticker || job)} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-neutral-950/35 xl:hidden" />
        <DialogPrimitive.Content className="fixed inset-x-0 bottom-0 z-50 grid max-h-[88dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-t-xl bg-white shadow-[var(--trace-shadow-md)] focus:outline-none xl:hidden">
          <header className="flex items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
            <div className="min-w-0">
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-neutral-950">
                {title}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-0.5 text-xs text-neutral-600">
                Media, analysis, indexing, and source details
              </DialogPrimitive.Description>
            </div>
            <DialogPrimitive.Close asChild>
              <IconButton aria-label="Close sticker details">
                <X aria-hidden="true" size={16} />
              </IconButton>
            </DialogPrimitive.Close>
          </header>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {sticker ? (
              <StickerDetail
                managementAction={managementAction}
                sticker={sticker}
                onDelete={onDelete}
                onRebuild={onRebuild}
              />
            ) : job ? (
              <JobDetail job={job} />
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function DeleteConfirmationDialog({
  busy,
  count,
  open,
  onCancel,
  onConfirm,
}: {
  busy: boolean;
  count: number;
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) {
          onCancel();
        }
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-neutral-950/35" />
        <DialogPrimitive.Content
          className="fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-5 shadow-[var(--trace-shadow-md)] focus:outline-none"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-red-50 text-red-700">
              <Trash2 aria-hidden="true" size={17} />
            </span>
            <div className="min-w-0">
              <DialogPrimitive.Title className="text-sm font-semibold text-neutral-950">
                Delete {formatCount(count)} {count === 1 ? "sticker" : "stickers"}?
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="mt-1.5 text-sm leading-6 text-neutral-600">
                This removes the catalog record, vector index row, and unreferenced media.
                Processing history and logs remain available for audit.
              </DialogPrimitive.Description>
            </div>
          </div>
          <div className="mt-5 flex justify-end gap-2">
            <button
              className={cn(
                "h-9 rounded-md bg-white px-3 text-sm font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40",
                focusClass
              )}
              disabled={busy}
              onClick={onCancel}
              type="button"
            >
              Cancel
            </button>
            <button
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-md bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50",
                focusClass
              )}
              disabled={busy}
              onClick={onConfirm}
              type="button"
            >
              {busy ? <Loader2 aria-hidden="true" className="animate-spin" size={14} /> : null}
              {busy ? "Deleting…" : "Delete"}
            </button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function StickerDetail({
  managementAction,
  sticker,
  onDelete,
  onRebuild,
}: {
  managementAction: StickerManagementAction | undefined;
  sticker: StickerCatalogItemView;
  onDelete: (stickerId: string) => void;
  onRebuild: (stickerId: string) => void;
}) {
  const busy = Boolean(managementAction);
  const processing = normalizeStatus(sticker.status) === "processing";
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={statusTone(sticker.status)}>{statusLabel(sticker.status)}</StatusPill>
            <StatusPill tone="neutral">{sourceLabel(sticker.sourceKind)}</StatusPill>
          </div>
          <h2 className="mt-2 truncate font-mono text-sm font-semibold" title={sticker.id}>
            {sticker.id}
          </h2>
        </div>
        <CopyButton value={sticker.id} />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          className={cn(
            "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40",
            focusClass
          )}
          disabled={busy || processing}
          onClick={() => onRebuild(sticker.id)}
          type="button"
        >
          <RefreshCw
            aria-hidden="true"
            className={managementAction === "rebuild" ? "animate-spin" : undefined}
            size={13}
          />
          Rebuild desc + index
        </button>
        <button
          className={cn(
            "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md bg-white px-3 text-xs font-medium text-red-700 ring-1 ring-inset ring-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40",
            focusClass
          )}
          disabled={busy || processing}
          onClick={() => onDelete(sticker.id)}
          type="button"
        >
          <Trash2 aria-hidden="true" size={13} />
          Delete
        </button>
      </div>

      <div className="mt-5">
        {sticker.animated ? (
          <AnimatedMediaFigure
            animatedSrc={sticker.thumbnailUrl}
            id={sticker.id}
            staticSrc={sticker.contactSheetUrl}
          />
        ) : (
          <MediaFigure label="Original" src={sticker.thumbnailUrl} />
        )}
      </div>

      <DetailSection title="Description">
        <p className="text-sm leading-6 text-neutral-800">
          {sticker.desc || "The sub model has not produced a description yet."}
        </p>
      </DetailSection>

      <DetailSection title="Indexing">
        <DefinitionList
          items={[
            ["Embedding", <StatusPill tone={statusTone(sticker.embeddingStatus)}>{statusLabel(sticker.embeddingStatus)}</StatusPill>],
            ["Format", sticker.animated ? "Animated · 16-frame analysis" : "Static image"],
          ]}
        />
      </DetailSection>

      <DetailSection title="Availability">
        <p className="text-sm text-neutral-700">Available bot-wide in every conversation.</p>
      </DetailSection>

      <DetailSection title="Record">
        <DefinitionList
          items={[
            ["Created", formatDateTime(sticker.createdAt)],
            ["Updated", formatDateTime(sticker.updatedAt)],
          ]}
        />
      </DetailSection>

      {sticker.lastError ? <ErrorNotice title="Latest error" message={sticker.lastError} /> : null}
    </div>
  );
}

function JobDetail({ job }: { job: StickerJobView }) {
  const progress = stagePercent(job);
  return (
    <div className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone={statusTone(job.status)}>{statusLabel(job.status)}</StatusPill>
            <StatusPill tone="neutral">{sourceLabel(job.sourceKind)}</StatusPill>
          </div>
          <h2 className="mt-2 truncate font-mono text-sm font-semibold" title={job.id}>
            {job.id}
          </h2>
        </div>
        <CopyButton value={job.id} />
      </div>

      <div className="mt-5 rounded-md bg-neutral-50 p-3 ring-1 ring-inset ring-neutral-200">
        <div className="flex items-center justify-between gap-3 text-sm">
          <span className="font-medium">{stageLabel(job.stage)}</span>
          <span className="tabular-nums text-neutral-600">{progress}%</span>
        </div>
        <ProgressBar value={progress} tone={statusTone(job.status)} />
        <p className="mt-2 text-xs text-neutral-600">
          {isActiveJob(job)
            ? "This job will continue even if sticker collection is turned off."
            : statusLabel(job.status)}
        </p>
        {job.lastFailedStage ? (
          <p className="mt-1.5 text-xs text-amber-800">
            Last attempt failed during {stageLabel(job.lastFailedStage)}.
          </p>
        ) : null}
      </div>

      <div className="mt-5">
        <MediaFigure
          label={job.animated ? "16-frame sheet" : "Media"}
          src={staticJobPreview(job)}
        />
      </div>

      {job.desc ? (
        <DetailSection title="Description">
          <p className="text-sm leading-6 text-neutral-800">{job.desc}</p>
        </DetailSection>
      ) : null}

      <DetailSection title="Job context">
        <DefinitionList
          items={[
            ["Sticker", job.stickerId || "Pending content hash"],
            ["Conversation", job.conversationId],
            ["Created", formatDateTime(job.createdAt)],
            ["Updated", formatDateTime(job.updatedAt)],
          ]}
        />
      </DetailSection>

      {job.error ? <ErrorNotice title="Job failed" message={job.error} /> : null}
    </div>
  );
}

function MediaFigure({ label, src }: { label: string; src?: string | undefined }) {
  return (
    <figure className="min-w-0">
      {src ? (
        <a
          className={cn("block rounded-md", focusClass)}
          href={src}
          rel="noreferrer"
          target="_blank"
          title={`Open ${label.toLowerCase()}`}
        >
          <StickerMedia alt={label} className="aspect-square w-full" src={src} />
        </a>
      ) : (
        <StickerMedia alt="" className="aspect-square w-full" />
      )}
      <figcaption className="mt-1.5 text-xs text-neutral-500">{label}</figcaption>
    </figure>
  );
}

function AnimatedMediaFigure({
  id,
  animatedSrc,
  staticSrc,
}: {
  id: string;
  animatedSrc: string | undefined;
  staticSrc: string | undefined;
}) {
  const [playing, setPlaying] = useState(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    setPlaying(false);
  }, [id, prefersReducedMotion]);

  return (
    <figure className="min-w-0">
      <div className="relative">
        <StickerMedia
          alt={playing ? "Playing animated sticker" : "Paused animation contact sheet"}
          className="aspect-square w-full"
          src={playing ? animatedSrc : staticSrc}
        />
        <button
          aria-pressed={playing}
          className={cn(
            "absolute bottom-2 right-2 inline-flex h-9 items-center gap-2 rounded-md bg-neutral-950 px-3 text-xs font-medium text-white shadow-sm hover:bg-neutral-800",
            focusClass
          )}
          disabled={!animatedSrc}
          onClick={() => setPlaying((current) => !current)}
          type="button"
        >
          {playing ? <Pause aria-hidden="true" size={14} /> : <Play aria-hidden="true" size={14} />}
          {playing ? "Pause" : "Play"}
        </button>
      </div>
      <figcaption className="mt-1.5 flex flex-wrap items-center justify-between gap-1 text-xs text-neutral-500">
        <span>{playing ? "Animation playing" : "Paused on 16-frame analysis sheet"}</span>
        {prefersReducedMotion ? <span>Reduced motion preference detected</span> : null}
      </figcaption>
    </figure>
  );
}

function StickerMedia({
  alt,
  className,
  src,
}: {
  alt: string;
  className?: string | undefined;
  src?: string | undefined;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [src]);

  if (!src || failed) {
    return (
      <span
        aria-label={alt || undefined}
        className={cn(
          "grid shrink-0 place-items-center overflow-hidden rounded-md bg-neutral-100 text-neutral-400 ring-1 ring-inset ring-neutral-200",
          className
        )}
        role={alt ? "img" : undefined}
      >
        <ImageOff aria-hidden="true" size={18} />
      </span>
    );
  }

  return (
    <img
      alt={alt}
      className={cn(
        "shrink-0 rounded-md bg-neutral-100 object-contain ring-1 ring-inset ring-neutral-200",
        className
      )}
      decoding="async"
      loading="lazy"
      onError={() => setFailed(true)}
      src={src}
    />
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | undefined>(undefined);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== undefined) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    []
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (resetTimerRef.current !== undefined) {
        window.clearTimeout(resetTimerRef.current);
      }
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Tooltip label={copied ? "Copied" : "Copy ID"}>
      <IconButton aria-label={copied ? "ID copied" : "Copy ID"} onClick={() => void copy()}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </IconButton>
    </Tooltip>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-6 border-t border-neutral-200 pt-4">
      <h3 className="mb-3 text-xs font-semibold text-neutral-900">{title}</h3>
      {children}
    </section>
  );
}

function DefinitionList({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="space-y-2.5 text-xs">
      {items.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[88px_minmax(0,1fr)] gap-3">
          <dt className="text-neutral-500">{label}</dt>
          <dd className="min-w-0 break-words text-right text-neutral-800">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProgressBar({
  value,
  tone,
}: {
  value: number;
  tone: "neutral" | "ok" | "warning" | "error" | "info";
}) {
  return (
    <div
      aria-label={`${value}% complete`}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={value}
      className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-200"
      role="progressbar"
    >
      <div
        className={cn(
          "h-full rounded-full",
          tone === "error" && "bg-red-600",
          tone === "warning" && "bg-amber-500",
          tone === "ok" && "bg-emerald-600",
          tone === "info" && "bg-[var(--trace-accent)]",
          tone === "neutral" && "bg-neutral-500"
        )}
        style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function ErrorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="mt-5 rounded-md bg-red-50 p-3 text-red-800 ring-1 ring-inset ring-red-200">
      <div className="flex items-center gap-2 text-xs font-semibold">
        <AlertCircle aria-hidden="true" size={14} />
        {title}
      </div>
      <p className="mt-1.5 break-words text-xs leading-5">{message}</p>
    </div>
  );
}

function CompactEmpty({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-6">
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-500 [&>svg]:h-4 [&>svg]:w-4">
        {icon}
      </span>
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-1 max-w-xl text-xs leading-5 text-neutral-600">{body}</p>
      </div>
    </div>
  );
}

function DetailEmpty() {
  return (
    <div className="grid min-h-[420px] place-items-center p-8 text-center">
      <div>
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-md bg-neutral-100 text-neutral-500">
          <FileImage aria-hidden="true" size={20} />
        </span>
        <h2 className="mt-3 text-sm font-semibold">Select a sticker or job</h2>
        <p className="mt-1 max-w-xs text-sm leading-5 text-neutral-600">
          Inspect its media, contact sheet, description, embedding, and processing history.
        </p>
      </div>
    </div>
  );
}

function RefreshWarning({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="border-b border-amber-200 bg-amber-50" role="alert">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 text-sm text-amber-900 sm:px-6">
        <span className="flex min-w-0 items-center gap-2">
          <AlertCircle aria-hidden="true" className="shrink-0" size={15} />
          <span className="truncate">Showing the last snapshot. {error}</span>
        </span>
        <button className={cn("font-medium underline underline-offset-4", focusClass)} onClick={onRetry} type="button">
          Retry
        </button>
      </div>
    </div>
  );
}

function SubsystemUnavailable({
  error,
  reason,
  onRetry,
}: {
  error: string | undefined;
  reason: string | undefined;
  onRetry: () => void;
}) {
  return (
    <section className="grid min-h-[calc(100vh-4rem)] place-items-center p-6" role="status">
      <div className="max-w-lg text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-md bg-neutral-100 text-neutral-600 ring-1 ring-inset ring-neutral-200">
          <Database aria-hidden="true" size={20} />
        </span>
        <h1 className="mt-4 text-base font-semibold">Sticker subsystem unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          {reason || "This runtime did not configure sticker collection and retrieval."}
        </p>
        <p className="mt-1 text-sm leading-6 text-neutral-600">
          Existing trace inspection remains available from the Traces page.
        </p>
        {error ? (
          <p className="mt-3 rounded-md bg-red-50 px-3 py-2 text-left text-xs text-red-800 ring-1 ring-inset ring-red-200" role="alert">
            Refresh failed: {error}
          </p>
        ) : null}
        <button
          className={cn(
            "mt-5 h-9 rounded-md bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800",
            focusClass
          )}
          onClick={onRetry}
          type="button"
        >
          Check again
        </button>
      </div>
    </section>
  );
}

function LoadError({ error, onRetry }: { error: string | undefined; onRetry: () => void }) {
  return (
    <section className="grid min-h-[calc(100vh-4rem)] place-items-center p-6">
      <div className="max-w-md text-center">
        <span className="mx-auto grid h-11 w-11 place-items-center rounded-md bg-red-50 text-red-700 ring-1 ring-inset ring-red-200">
          <AlertCircle aria-hidden="true" size={20} />
        </span>
        <h1 className="mt-4 text-base font-semibold">Sticker data is unavailable</h1>
        <p className="mt-2 text-sm leading-6 text-neutral-600">
          {error || "The live snapshot could not be loaded."}
        </p>
        <button
          className={cn("mt-5 h-9 rounded-md bg-neutral-950 px-4 text-sm font-medium text-white hover:bg-neutral-800", focusClass)}
          onClick={onRetry}
          type="button"
        >
          Try again
        </button>
      </div>
    </section>
  );
}

function LoadingWorkspace() {
  return (
    <div aria-label="Loading sticker workspace" className="mx-auto w-full max-w-[1600px]" role="status">
      <div className="border-b border-neutral-200 bg-white px-4 py-6 sm:px-6">
        <div className="h-5 w-36 rounded bg-neutral-200" />
        <div className="mt-3 h-4 w-full max-w-xl rounded bg-neutral-100" />
      </div>
      <div className="grid grid-cols-2 border-b border-neutral-200 bg-white sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="border-r border-neutral-200 px-4 py-4 sm:px-6">
            <div className="h-3 w-16 rounded bg-neutral-100" />
            <div className="mt-2 h-6 w-12 rounded bg-neutral-200" />
          </div>
        ))}
      </div>
      <div className="grid gap-5 p-4 sm:p-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {[0, 1].map((panel) => (
            <div key={panel} className="overflow-hidden rounded-lg bg-white ring-1 ring-neutral-200">
              <div className="h-12 border-b border-neutral-200 p-4"><div className="h-3 w-28 rounded bg-neutral-200" /></div>
              {Array.from({ length: 3 }, (_, row) => (
                <div key={row} className="flex gap-3 border-b border-neutral-100 p-3 last:border-0">
                  <div className="h-12 w-12 rounded bg-neutral-100" />
                  <div className="min-w-0 flex-1 space-y-2 py-1">
                    <div className="h-3 w-1/3 rounded bg-neutral-200" />
                    <div className="h-3 w-4/5 rounded bg-neutral-100" />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
        <div className="h-[480px] rounded-lg bg-white ring-1 ring-neutral-200" />
      </div>
    </div>
  );
}

function staticStickerPreview(sticker: StickerCatalogItemView): string | undefined {
  return sticker.animated ? sticker.contactSheetUrl : sticker.thumbnailUrl;
}

function staticJobPreview(job: StickerJobView): string | undefined {
  return job.animated ? job.contactSheetUrl : job.thumbnailUrl;
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

function usePrefersReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

function compareUpdatedAt<T extends { updatedAt: string }>(left: T, right: T) {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

function isActiveJob(job: StickerJobView) {
  const status = normalizeStatus(job.status);
  return status !== "ready" && status !== "failed";
}

function normalizeSource(value: string): Exclude<SourceFilter, "all"> | string {
  const normalized = value.toLowerCase();
  if (normalized === "mface" || normalized.includes("market")) {
    return "mface";
  }
  if (normalized === "image-sticker" || normalized.includes("image")) {
    return "image-sticker";
  }
  return normalized;
}

function sourceLabel(value: string) {
  const normalized = normalizeSource(value);
  if (normalized === "mface") {
    return "QQ marketplace";
  }
  if (normalized === "image-sticker") {
    return "Custom image";
  }
  return value.replaceAll("_", " ").replaceAll("-", " ");
}

function normalizeStatus(value: string) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  if (normalized.includes("fail") || normalized.includes("error")) {
    return "failed";
  }
  if (normalized === "completed" || normalized === "indexed" || normalized === "ready") {
    return "ready";
  }
  if (normalized === "queued" || normalized === "pending") {
    return "queued";
  }
  return normalized;
}

function statusLabel(value: string) {
  const normalized = normalizeStatus(value);
  if (normalized === "image-sticker") {
    return "image sticker";
  }
  return normalized.replaceAll("-", " ");
}

function statusTone(value: string): "neutral" | "ok" | "warning" | "error" | "info" {
  const normalized = normalizeStatus(value);
  if (normalized === "failed") {
    return "error";
  }
  if (normalized === "ready") {
    return "ok";
  }
  if (normalized === "queued") {
    return "warning";
  }
  if (normalized === "empty") {
    return "neutral";
  }
  return "info";
}

function indexTone(value: StickerSnapshot["embedding"]["indexState"]): "neutral" | "ok" | "warning" | "error" | "info" {
  if (value === "ready") {
    return "ok";
  }
  if (value === "error") {
    return "error";
  }
  if (value === "rebuilding") {
    return "info";
  }
  return "neutral";
}

function stagePercent(job: StickerJobView) {
  const status = normalizeStatus(job.status);
  if (status === "ready") {
    return 100;
  }
  if (status === "failed") {
    return Math.max(
      5,
      stagePercentFromName(job.lastFailedStage ?? job.stage)
    );
  }
  return stagePercentFromName(job.stage);
}

function stagePercentFromName(stage: string) {
  const normalized = stage.toLowerCase().replaceAll("-", "_");
  if (normalized.includes("ready") || normalized.includes("complete")) return 100;
  if (normalized.includes("index") || normalized.includes("lancedb")) return 90;
  if (normalized.includes("embed")) return 76;
  if (normalized.includes("describ") || normalized.includes("analy")) return 60;
  if (normalized.includes("render") || normalized.includes("sheet")) return 44;
  if (normalized.includes("download")) return 30;
  if (normalized.includes("resolv")) return 18;
  if (normalized.includes("queue") || normalized.includes("pending")) return 6;
  return 10;
}

function stageLabel(stage: string) {
  return stage.replaceAll("_", " ").replaceAll("-", " ");
}

function parseLiveEvent(event: Event): RuntimeLiveEventEnvelope | undefined {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(event.data) as RuntimeLiveEventEnvelope;
    return typeof parsed.type === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function shortId(value: string) {
  return value.length > 18 ? `${value.slice(0, 14)}…` : value;
}

function formatCount(value: number) {
  return new Intl.NumberFormat().format(value);
}

function formatCosineSimilarity(value: number) {
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3,
  }).format(value);
}

function formatDistance(value: number) {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 4,
  }).format(value);
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return "Unknown";
  }
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function formatRelativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return "unknown";
  }
  const elapsedSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(elapsedSeconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) {
    return formatter.format(elapsedSeconds, "second");
  }
  if (absolute < 3_600) {
    return formatter.format(Math.round(elapsedSeconds / 60), "minute");
  }
  if (absolute < 86_400) {
    return formatter.format(Math.round(elapsedSeconds / 3_600), "hour");
  }
  return formatter.format(Math.round(elapsedSeconds / 86_400), "day");
}
