import type {
  ConversationSummary,
  ConversationTimelineItem,
  LiveOverview,
  ModelInputResponse,
  ModelInputView,
  RolloutDetail,
  RolloutSummary,
  RolloutStatus
} from "@gestalt/live-contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_PAGE_LIMIT } from "@gestalt/live-contracts";
import { errorMessage } from "../lib/format";
import { liveApi } from "../lib/liveApi";

export type LoadState = "loading" | "ready" | "error";

export function useOverview() {
  return useResource<LiveOverview>((signal) => liveApi.overview(signal));
}

export function useRolloutDetail(rolloutId: string | undefined) {
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!rolloutId) return Promise.resolve(undefined);
      return liveApi.rollout(rolloutId, signal);
    },
    [rolloutId]
  );
  return useResource<RolloutDetail | undefined>(load, rolloutId ?? "none");
}

export function useModelInput(
  rolloutId: string,
  generationId: string | undefined,
  view: ModelInputView
) {
  const load = useCallback(
    (signal: AbortSignal) => {
      if (!generationId) return Promise.resolve(undefined);
      return liveApi.modelInput(rolloutId, generationId, view, signal);
    },
    [generationId, rolloutId, view]
  );
  return useResource<ModelInputResponse | undefined>(
    load,
    `${rolloutId}:${generationId ?? "none"}:${view}`
  );
}

export function useConversations(query: string) {
  const loadPage = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      liveApi.conversations(
        { limit: DEFAULT_PAGE_LIMIT, ...(cursor ? { cursor } : {}), ...(query ? { query } : {}) },
        signal
      ),
    [query]
  );
  return usePagedList<ConversationSummary>(query, loadPage);
}

export function useRollouts(query: string, status: RolloutStatus | undefined) {
  const loadPage = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      liveApi.rollouts(
        {
          limit: DEFAULT_PAGE_LIMIT,
          ...(cursor ? { cursor } : {}),
          ...(query ? { query } : {}),
          ...(status ? { status } : {})
        },
        signal
      ),
    [query, status]
  );
  return usePagedList<RolloutSummary>(`${query}:${status ?? "all"}`, loadPage);
}

export function useConversationTimeline(conversationKey: string | undefined) {
  const [conversation, setConversation] = useState<ConversationSummary>();
  const [items, setItems] = useState<ConversationTimelineItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const olderRequestRef = useRef<AbortController | undefined>(undefined);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  const reload = useCallback(
    async (quiet = false) => {
      requestRef.current?.abort();
      if (!conversationKey) {
        setConversation(undefined);
        setItems([]);
        setNextCursor(undefined);
        setState("ready");
        return;
      }
      const controller = new AbortController();
      requestRef.current = controller;
      if (!quiet) setState("loading");
      try {
        const page = await liveApi.conversationTimeline(
          conversationKey,
          { limit: DEFAULT_PAGE_LIMIT },
          controller.signal
        );
        if (controller.signal.aborted) return;
        setConversation(page.conversation);
        setItems((current) =>
          quiet ? mergeTimeline(current, page.items) : page.items
        );
        if (!quiet || itemsRef.current.length === 0) setNextCursor(page.nextCursor);
        setError(undefined);
        setState("ready");
      } catch (cause) {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        setState(itemsRef.current.length ? "ready" : "error");
      }
    },
    [conversationKey]
  );

  const loadMore = useCallback(async () => {
    if (!conversationKey || !nextCursor || loadingMore) return;
    olderRequestRef.current?.abort();
    const controller = new AbortController();
    olderRequestRef.current = controller;
    setLoadingMore(true);
    try {
      const page = await liveApi.conversationTimeline(
        conversationKey,
        { cursor: nextCursor, limit: DEFAULT_PAGE_LIMIT },
        controller.signal
      );
      if (controller.signal.aborted) return;
      setItems((current) => mergeTimeline(page.items, current));
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [conversationKey, loadingMore, nextCursor]);

  useEffect(() => {
    setItems([]);
    setConversation(undefined);
    setNextCursor(undefined);
    void reload(false);
    return () => {
      requestRef.current?.abort();
      olderRequestRef.current?.abort();
    };
  }, [conversationKey, reload]);

  return {
    conversation,
    items,
    nextCursor,
    state,
    error,
    loadingMore,
    reload,
    loadMore
  };
}

function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  resetKey = "resource"
) {
  const [data, setData] = useState<T>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const requestRef = useRef<AbortController | undefined>(undefined);
  const dataRef = useRef(data);
  const loadRef = useRef(load);
  dataRef.current = data;
  loadRef.current = load;

  const reload = useCallback(async (quiet = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!quiet) setState("loading");
    try {
      const next = await loadRef.current(controller.signal);
      if (controller.signal.aborted) return;
      setData(next);
      setError(undefined);
      setState("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
      setState(dataRef.current === undefined ? "error" : "ready");
    }
  }, []);

  useEffect(() => {
    setData(undefined);
    void reload(false);
    return () => requestRef.current?.abort();
  }, [reload, resetKey]);

  return { data, state, error, reload };
}

function usePagedList<T>(
  resetKey: string,
  loadPage: (
    cursor: string | undefined,
    signal: AbortSignal
  ) => Promise<{ items: T[]; nextCursor?: string | undefined }>
) {
  const [items, setItems] = useState<T[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string>();
  const [loadingMore, setLoadingMore] = useState(false);
  const requestRef = useRef<AbortController | undefined>(undefined);
  const moreRequestRef = useRef<AbortController | undefined>(undefined);
  const itemsRef = useRef(items);
  const loaderRef = useRef(loadPage);
  itemsRef.current = items;
  loaderRef.current = loadPage;

  const reload = useCallback(async (quiet = false) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    if (!quiet) setState("loading");
    try {
      const page = await loaderRef.current(undefined, controller.signal);
      if (controller.signal.aborted) return;
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setError(undefined);
      setState("ready");
    } catch (cause) {
      if (controller.signal.aborted) return;
      setError(errorMessage(cause));
      setState(itemsRef.current.length ? "ready" : "error");
    }
  }, []);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    moreRequestRef.current?.abort();
    const controller = new AbortController();
    moreRequestRef.current = controller;
    setLoadingMore(true);
    try {
      const page = await loaderRef.current(nextCursor, controller.signal);
      if (controller.signal.aborted) return;
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.nextCursor);
      setError(undefined);
    } catch (cause) {
      if (!controller.signal.aborted) setError(errorMessage(cause));
    } finally {
      if (!controller.signal.aborted) setLoadingMore(false);
    }
  }, [loadingMore, nextCursor]);

  useEffect(() => {
    setItems([]);
    setNextCursor(undefined);
    void reload(false);
    return () => {
      requestRef.current?.abort();
      moreRequestRef.current?.abort();
    };
  }, [reload, resetKey]);

  return { items, nextCursor, state, error, loadingMore, reload, loadMore };
}

function mergeTimeline(
  older: ConversationTimelineItem[],
  newer: ConversationTimelineItem[]
): ConversationTimelineItem[] {
  const byId = new Map<string, ConversationTimelineItem>();
  for (const item of [...older, ...newer]) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => {
    const delta = Date.parse(left.at) - Date.parse(right.at);
    return delta || left.id.localeCompare(right.id);
  });
}
