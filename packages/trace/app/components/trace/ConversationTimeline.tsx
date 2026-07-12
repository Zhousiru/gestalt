import type {
  ConversationSummary,
  ConversationTimelineItem
} from "@gestalt/live-contracts";
import {
  ArrowLeft,
  Bot,
  ChevronRight,
  Clock3,
  Loader2,
  MessageSquare,
  UserRound
} from "lucide-react";
import { useEffect, useRef, type Ref } from "react";
import type { LoadState } from "../../hooks/useLiveData";
import { formatDuration, formatTime, shortId, statusTone } from "../../lib/format";
import { ScrollArea, StatusPill, cn } from "../ui";
import { EmptyState, ErrorNotice, SkeletonRows } from "./StateViews";

export function ConversationTimeline({
  backButtonRef,
  conversation,
  items,
  nextCursor,
  state,
  error,
  loadingMore,
  selectedRolloutId,
  selectedRolloutButtonRef,
  onLoadMore,
  onRetry,
  onSelectRollout,
  onBack,
  className
}: {
  backButtonRef?: Ref<HTMLButtonElement> | undefined;
  conversation: ConversationSummary | undefined;
  items: ConversationTimelineItem[];
  nextCursor: string | undefined;
  state: LoadState;
  error: string | undefined;
  loadingMore: boolean;
  selectedRolloutId: string | undefined;
  selectedRolloutButtonRef?: Ref<HTMLButtonElement> | undefined;
  onLoadMore: () => Promise<void>;
  onRetry: () => void;
  onSelectRollout: (rolloutId: string) => void;
  onBack: () => void;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const initializedConversationRef = useRef<string | undefined>(undefined);
  const followLatestRef = useRef(true);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !conversation || state !== "ready") return;
    if (initializedConversationRef.current !== conversation.key) {
      initializedConversationRef.current = conversation.key;
      followLatestRef.current = true;
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    }
  }, [conversation, state]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !followLatestRef.current) return;
    requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
  }, [items.length]);

  const loadEarlier = async () => {
    const viewport = viewportRef.current;
    const previousHeight = viewport?.scrollHeight ?? 0;
    const previousTop = viewport?.scrollTop ?? 0;
    followLatestRef.current = false;
    await onLoadMore();
    requestAnimationFrame(() => {
      if (viewport) viewport.scrollTop = previousTop + viewport.scrollHeight - previousHeight;
    });
  };

  return (
    <section
      aria-label="Conversation timeline"
      className={cn(
        "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] overflow-hidden bg-[var(--trace-bg)]",
        className
      )}
    >
      <header className="flex min-h-16 items-center gap-3 border-b border-neutral-200 bg-white px-3 py-2.5 sm:px-4">
        <button
          aria-label="Back to trace lists"
          className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-neutral-600 outline-none hover:bg-neutral-100 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] md:hidden"
          onClick={onBack}
          ref={backButtonRef}
          type="button"
        >
          <ArrowLeft aria-hidden="true" size={17} />
        </button>
        {conversation ? (
          <>
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-600 ring-1 ring-inset ring-neutral-200">
              <MessageSquare aria-hidden="true" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-semibold text-neutral-950">
                {conversation.name ?? conversation.key}
              </h2>
              <p className="mt-0.5 truncate text-xs text-neutral-600">
                {conversation.messageCount} messages · {conversation.rolloutCount} rollouts
              </p>
            </div>
          </>
        ) : (
          <div>
            <h2 className="text-sm font-semibold text-neutral-950">Conversation</h2>
            <p className="mt-0.5 text-xs text-neutral-600">Select a chat to inspect its journal.</p>
          </div>
        )}
      </header>

      {!conversation && state !== "loading" ? (
        <EmptyState
          description="Choose a chat from the left to inspect recent messages and its linked rollouts."
          title="Select a conversation"
        />
      ) : state === "loading" && !items.length ? (
        <SkeletonRows rows={7} />
      ) : state === "error" && !items.length ? (
        <ErrorNotice message={error ?? "Unknown error"} onRetry={onRetry} />
      ) : (
        <ScrollArea
          className="h-full"
          onViewportScroll={(event) => {
            const viewport = event.currentTarget;
            followLatestRef.current =
              viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80;
          }}
          viewportRef={viewportRef}
        >
          <div className="mx-auto w-full max-w-3xl px-3 py-4 sm:px-5">
            {error ? <ErrorNotice compact message={error} onRetry={onRetry} /> : null}
            {nextCursor ? (
              <div className="mb-4 flex justify-center">
                <button
                  className="inline-flex h-9 items-center gap-2 rounded-md bg-white px-3 text-xs font-medium text-neutral-700 ring-1 ring-inset ring-neutral-300 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)] disabled:cursor-not-allowed disabled:opacity-50"
                  disabled={loadingMore}
                  onClick={() => void loadEarlier()}
                  type="button"
                >
                  {loadingMore ? <Loader2 aria-hidden="true" className="animate-spin" size={14} /> : <Clock3 aria-hidden="true" size={14} />}
                  {loadingMore ? "Loading earlier activity" : "Load earlier activity"}
                </button>
              </div>
            ) : null}
            {items.length ? (
              <ol className="space-y-2">
                {items.map((item) => (
                  <li key={item.id}>
                    <TimelineItem
                      item={item}
                      onSelectRollout={onSelectRollout}
                      buttonRef={
                        item.type === "rollout" && item.rolloutId === selectedRolloutId
                          ? selectedRolloutButtonRef
                          : undefined
                      }
                      selectedRolloutId={selectedRolloutId}
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState
                description="The session journal has no recent messages in the configured history window."
                title="No recent activity"
              />
            )}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function TimelineItem({
  item,
  selectedRolloutId,
  onSelectRollout,
  buttonRef
}: {
  item: ConversationTimelineItem;
  selectedRolloutId: string | undefined;
  onSelectRollout: (rolloutId: string) => void;
  buttonRef?: Ref<HTMLButtonElement> | undefined;
}) {
  if (item.type === "message") {
    return (
      <article className={cn("flex gap-3 rounded-md px-3 py-3", item.isSelf ? "bg-[var(--trace-accent-soft)]" : "bg-white ring-1 ring-inset ring-neutral-200")}>
        <span className={cn("mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-md", item.isSelf ? "bg-white text-[var(--trace-accent)]" : "bg-neutral-100 text-neutral-600")}>
          {item.isSelf ? <Bot aria-hidden="true" size={14} /> : <UserRound aria-hidden="true" size={14} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-xs font-semibold text-neutral-950">
              {item.senderName ?? item.senderId ?? (item.isSelf ? "Agent" : "Unknown sender")}
            </span>
            <time className="ml-auto shrink-0 text-[11px] text-neutral-600" dateTime={item.at}>
              {formatTime(item.at)}
            </time>
          </div>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6 text-neutral-800">
            {item.text || <span className="italic text-neutral-500">Empty message</span>}
          </p>
          {item.source || item.mentionsBot ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {item.source ? <StatusPill>{item.source}</StatusPill> : null}
              {item.mentionsBot ? <StatusPill tone="info">mentioned agent</StatusPill> : null}
            </div>
          ) : null}
        </div>
      </article>
    );
  }

  if (item.type === "rollout") {
    const selected = item.rolloutId === selectedRolloutId;
    return (
      <button
        aria-current={selected ? "true" : undefined}
        className={cn(
          "trace-list-row flex w-full items-center gap-3 rounded-md bg-white px-3 py-3 text-left ring-1 ring-inset ring-neutral-200 outline-none hover:bg-neutral-50 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
          selected && "bg-[var(--trace-accent-soft)] ring-[var(--trace-accent-border)]"
        )}
        onClick={() => onSelectRollout(item.rolloutId)}
        ref={buttonRef}
        type="button"
      >
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-neutral-100 text-neutral-600">
          <Bot aria-hidden="true" size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-mono text-xs font-medium text-neutral-950">{shortId(item.rolloutId, 18)}</span>
            <StatusPill tone={statusTone(item.status)}>{item.status}</StatusPill>
          </div>
          <p className="mt-1 text-[11px] text-neutral-600">
            {item.phase ?? item.model ?? "Active loop"} · {formatDuration(item.durationMs)}
          </p>
        </div>
        <time className="shrink-0 text-[11px] text-neutral-600" dateTime={item.at}>{formatTime(item.at)}</time>
        <ChevronRight aria-hidden="true" className="shrink-0 text-neutral-400" size={15} />
      </button>
    );
  }

  return (
    <div className="flex items-start gap-3 px-3 py-2 text-xs text-neutral-600">
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-neutral-400" />
      <div className="min-w-0 flex-1">
        <span className="font-medium text-neutral-800">{item.label}</span>
        {item.detail ? <span className="ml-1.5">{item.detail}</span> : null}
      </div>
      <time className="shrink-0 text-[11px]" dateTime={item.at}>{formatTime(item.at)}</time>
    </div>
  );
}
