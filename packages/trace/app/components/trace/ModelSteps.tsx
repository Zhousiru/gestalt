import type {
  GenerationSummary,
  ModelInputView,
  ModelMessage,
  RolloutDetail
} from "@gestalt/live-contracts";
import { ArrowDown, Database } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type UIEvent
} from "react";
import { useModelInput } from "../../hooks/useLiveData";
import { formatCount, formatDuration, formatTime, shortId } from "../../lib/format";
import { ScrollArea, StatusPill, cn } from "../ui";
import { MessageContent } from "./BinaryContent";
import { JsonDetails } from "./JsonDetails";
import { EmptyState, ErrorNotice, SkeletonRows } from "./StateViews";

export function ModelSteps({ detail }: { detail: RolloutDetail }) {
  const [activeGenerationId, setActiveGenerationId] = useState(
    detail.generations[0]?.id
  );
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setActiveGenerationId(detail.generations[0]?.id);
    viewportRef.current?.scrollTo({ top: 0 });
  }, [detail.summary.id]);

  const syncActiveStep = useCallback(
    (viewport: HTMLDivElement) => {
      const sections = Array.from(
        viewport.querySelectorAll<HTMLElement>("[data-model-step-id]")
      );
      if (!sections.length) return;

      const viewportRect = viewport.getBoundingClientRect();
      const activationLine =
        viewportRect.top + Math.min(104, viewport.clientHeight * 0.22);
      let activeId = sections[0]?.dataset.modelStepId;

      for (const section of sections) {
        if (section.getBoundingClientRect().top > activationLine) break;
        activeId = section.dataset.modelStepId;
      }
      if (
        viewport.scrollTop + viewport.clientHeight >=
        viewport.scrollHeight - 8
      ) {
        activeId = sections.at(-1)?.dataset.modelStepId;
      }
      if (activeId) setActiveGenerationId(activeId);
    },
    []
  );

  const onViewportScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => syncActiveStep(event.currentTarget),
    [syncActiveStep]
  );

  const navigateTo = useCallback((generationId: string) => {
    const viewport = viewportRef.current;
    const section = viewport?.querySelector<HTMLElement>(
      `[data-model-step-id="${escapeAttributeValue(generationId)}"]`
    );
    if (!viewport || !section) return;

    const viewportRect = viewport.getBoundingClientRect();
    const sectionRect = section.getBoundingClientRect();
    setActiveGenerationId(generationId);
    viewport.scrollTo({
      top: Math.max(
        0,
        viewport.scrollTop + sectionRect.top - viewportRect.top - 16
      ),
      behavior: "smooth"
    });
  }, []);

  if (!detail.generations.length) {
    return (
      <EmptyState
        description="Generation metadata appears after the first committed model step."
        title="No generations recorded"
      />
    );
  }

  const outputMessages = readGenerationOutputs(detail);
  const previousOutputIds = new Set<string>();

  return (
    <div className="grid h-full min-h-0 min-w-0 grid-cols-[6.75rem_minmax(0,1fr)] sm:grid-cols-[8rem_minmax(0,1fr)]">
      <aside
        aria-label="Model steps"
        className="min-h-0 overflow-y-auto border-r border-neutral-200 bg-neutral-50 px-2 py-2.5 sm:px-3"
      >
        <div className="mb-2 px-1">
          <h3 className="text-xs font-semibold text-neutral-950">Steps</h3>
          <p className="mt-0.5 text-[11px] text-neutral-600">
            {detail.generations.length} calls
          </p>
        </div>
        <nav aria-label="Model step navigation">
          <ol className="space-y-1">
            {detail.generations.map((generation, index) => {
              const active = generation.id === activeGenerationId;
              return (
                <li key={generation.id}>
                  <button
                    aria-current={active ? "step" : undefined}
                    className={cn(
                      "trace-list-row w-full rounded-md px-2 py-1.5 text-left outline-none hover:bg-neutral-200/70 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
                      active &&
                        "bg-white text-[var(--trace-accent)] shadow-[var(--trace-shadow-xs)] ring-1 ring-inset ring-neutral-200"
                    )}
                    onClick={() => navigateTo(generation.id)}
                    type="button"
                  >
                    <span className="block text-xs font-semibold">
                      Step {index + 1}
                    </span>
                    <span
                      className={cn(
                        "mt-0.5 block text-[10px] text-neutral-500",
                        active && "text-[var(--trace-accent)]/75"
                      )}
                    >
                      {formatTime(generation.completedAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      </aside>

      <ScrollArea
        className="h-full min-h-0"
        onViewportScroll={onViewportScroll}
        viewportRef={viewportRef}
      >
        <div className="px-3 pb-6 pt-3 sm:px-4">
          <header className="pb-3">
            <h3 className="text-sm font-semibold text-neutral-950">
              Model call path
            </h3>
            <p className="mt-1 max-w-[68ch] text-xs leading-5 text-neutral-600">
              Every generation is shown in order. Step delta removes output
              already shown by the preceding call; full input is reconstructed
              only when requested.
            </p>
          </header>

          <div className="divide-y divide-neutral-200 border-y border-neutral-200">
            {detail.generations.map((generation, index) => {
              const outputs = outputMessages.get(generation.id) ?? [];
              const priorOutputs = new Set(previousOutputIds);
              for (const outputId of generation.outputMessageIds) {
                previousOutputIds.add(outputId);
              }
              return (
                <ModelStepSection
                  generation={generation}
                  index={index}
                  key={generation.id}
                  outputs={outputs}
                  priorOutputIds={priorOutputs}
                  rolloutId={detail.summary.id}
                />
              );
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}

function ModelStepSection({
  generation,
  index,
  outputs,
  priorOutputIds,
  rolloutId
}: {
  generation: GenerationSummary;
  index: number;
  outputs: ModelMessage[];
  priorOutputIds: Set<string>;
  rolloutId: string;
}) {
  const [view, setView] = useState<ModelInputView>("delta");
  const input = useModelInput(rolloutId, generation.id, view);
  const messages = useMemo(
    () =>
      view === "delta"
        ? (input.data?.messages ?? []).filter(
            (message) => !priorOutputIds.has(message.id)
          )
        : (input.data?.messages ?? []),
    [input.data?.messages, priorOutputIds, view]
  );

  return (
    <section
      aria-labelledby={`model-step-${index + 1}-heading`}
      className="scroll-mt-4 py-4 first:pt-3"
      data-model-step-id={generation.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h4
              className="text-sm font-semibold text-neutral-950"
              id={`model-step-${index + 1}-heading`}
            >
              Step {index + 1}
            </h4>
            {generation.model ? (
              <span
                className="max-w-56 truncate font-mono text-[10px] text-neutral-500"
                title={generation.model}
              >
                {generation.model}
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-neutral-600">
            <time dateTime={generation.completedAt}>
              {formatTime(generation.completedAt)}
            </time>
            <span aria-hidden="true"> · </span>
            {generation.latencyMs === undefined
              ? "Latency not reported"
              : formatDuration(generation.latencyMs)}
          </p>
        </div>
        <div
          aria-label={`Step ${index + 1} model input view`}
          className="flex rounded-md bg-neutral-100 p-1 ring-1 ring-inset ring-neutral-200"
          role="group"
        >
          <ViewButton active={view === "delta"} onClick={() => setView("delta")}>
            Step delta
          </ViewButton>
          <ViewButton active={view === "full"} onClick={() => setView("full")}>
            Full input
          </ViewButton>
        </div>
      </div>

      <GenerationMetadata generation={generation} />

      <div className="mt-3 space-y-3">
        <ExchangePart
          description={
            view === "full"
              ? `${input.data?.messageCount ?? generation.messageCount} messages in the reconstructed request`
              : index === 0
                ? "Initial committed context"
                : "New context added after the preceding call"
          }
          label={view === "full" ? "Full model input" : "Input delta"}
        >
          {input.state === "loading" ? (
            <SkeletonRows rows={4} />
          ) : input.state === "error" || !input.data ? (
            <ErrorNotice
              message={input.error ?? "Model input is unavailable"}
              onRetry={() => void input.reload()}
            />
          ) : (
            <ModelInput
              input={input.data}
              messages={messages}
              view={view}
            />
          )}
        </ExchangePart>

        <div
          aria-hidden="true"
          className="flex h-3 items-center gap-2 text-neutral-300"
        >
          <span className="h-px flex-1 bg-neutral-200" />
          <ArrowDown size={13} />
          <span className="h-px flex-1 bg-neutral-200" />
        </div>

        <ExchangePart
          description={`${outputs.length} committed message${outputs.length === 1 ? "" : "s"}`}
          label="Model output"
        >
          {outputs.length ? (
            <MessageList messages={outputs} />
          ) : (
            <div className="rounded-md bg-neutral-50 p-4 text-center text-xs text-neutral-600 ring-1 ring-inset ring-neutral-200">
              No model output was committed for this step.
            </div>
          )}
        </ExchangePart>
      </div>
    </section>
  );
}

function GenerationMetadata({ generation }: { generation: GenerationSummary }) {
  const prefixReused = generation.cache?.prefixReused;
  return (
    <dl className="mt-2 grid grid-cols-2 gap-x-3 rounded-md bg-neutral-50 px-2.5 ring-1 ring-inset ring-neutral-200">
      <Datum label="State hash">
        <span className="font-mono" title={generation.inputStateHash}>
          {shortId(generation.inputStateHash, 14)}
        </span>
      </Datum>
      <Datum label="Finish">{generation.finishReason ?? "Not reported"}</Datum>
      <Datum label="Input">
        {formatCount(generation.usage?.inputTokens)} tokens
      </Datum>
      <Datum label="Output">
        {formatCount(generation.usage?.outputTokens)} tokens
      </Datum>
      <Datum label="Cache read">
        {formatCount(generation.cache?.readInputTokens)} tokens
      </Datum>
      <Datum label="Prefix">
        <StatusPill
          tone={
            prefixReused
              ? "ok"
              : prefixReused === false
                ? "warning"
                : "neutral"
          }
        >
          {prefixReused === undefined
            ? "Unknown"
            : prefixReused
              ? "Reused"
              : "Not reused"}
        </StatusPill>
      </Datum>
    </dl>
  );
}

function ExchangePart({
  label,
  description,
  children
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
        <h5 className="text-xs font-semibold text-neutral-900">{label}</h5>
        <span className="text-[10px] text-neutral-500">{description}</span>
      </div>
      {children}
    </div>
  );
}

function ModelInput({
  input,
  messages,
  view
}: {
  input: NonNullable<ReturnType<typeof useModelInput>["data"]>;
  messages: ModelMessage[];
  view: ModelInputView;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={view === "full" ? "warning" : "info"}>
          {view === "full" ? "Full reconstructed input" : "Committed delta"}
        </StatusPill>
        <span className="text-[11px] text-neutral-600">
          {messages.length} shown · {input.messageCount} total
        </span>
        {input.unavailableBinaryCount ? (
          <StatusPill tone="warning">
            {input.unavailableBinaryCount} binaries unavailable
          </StatusPill>
        ) : null}
      </div>
      {messages.length ? (
        <MessageList messages={messages} />
      ) : (
        <div className="rounded-md bg-neutral-50 p-3 text-center text-xs text-neutral-600 ring-1 ring-inset ring-neutral-200">
          No new input remained after the preceding output was placed in its
          original step.
        </div>
      )}
      {input.tools ? (
        <JsonDetails
          className="rounded-md bg-neutral-50 ring-1 ring-inset ring-neutral-200"
          contentClassName="mx-2 mb-2"
          summary={
            <span className="inline-flex min-w-0 items-center gap-2 text-xs text-neutral-700">
              <Database aria-hidden="true" size={14} />
              {input.tools.length} tool definitions
            </span>
          }
          summaryClassName="px-2.5 py-2"
          value={input.tools}
        />
      ) : null}
    </div>
  );
}

function MessageList({ messages }: { messages: ModelMessage[] }) {
  return (
    <ol className="space-y-1.5">
      {messages.map((message) => (
        <li
          className="rounded-md bg-white p-2.5 ring-1 ring-inset ring-neutral-200"
          key={message.id}
        >
          <div className="mb-1.5 flex min-w-0 items-center gap-2">
            <StatusPill>{message.role}</StatusPill>
            {message.name ? (
              <span className="truncate text-[11px] text-neutral-600">
                {message.name}
              </span>
            ) : null}
            <span
              className="ml-auto truncate font-mono text-[10px] text-neutral-500"
              title={message.id}
            >
              {shortId(message.id, 12)}
            </span>
          </div>
          <MessageContent value={message.content} />
        </li>
      ))}
    </ol>
  );
}

function ViewButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(
        "h-7 rounded px-2.5 text-[11px] font-medium text-neutral-600 outline-none hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-[var(--trace-accent)]",
        active &&
          "bg-white text-neutral-950 shadow-[var(--trace-shadow-xs)] ring-1 ring-neutral-200"
      )}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function Datum({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-8 min-w-0 items-center justify-between gap-2 border-b border-neutral-200 py-1.5 text-[11px] last:border-b-0">
      <dt className="shrink-0 text-neutral-600">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-neutral-900">
        {children}
      </dd>
    </div>
  );
}

function readGenerationOutputs(
  detail: RolloutDetail
): Map<string, ModelMessage[]> {
  const generationByMessageId = new Map<string, string>();
  for (const generation of detail.generations) {
    for (const messageId of generation.outputMessageIds) {
      generationByMessageId.set(messageId, generation.id);
    }
  }

  const outputs = new Map<string, ModelMessage[]>();
  for (const record of detail.records) {
    if (record.type !== "message_committed" || !isRecord(record.payload)) {
      continue;
    }
    const message = readModelMessage(record.payload.message, record.at);
    if (!message) continue;
    const generationId = generationByMessageId.get(message.id);
    if (!generationId) continue;
    const messages = outputs.get(generationId) ?? [];
    messages.push(message);
    outputs.set(generationId, messages);
  }
  return outputs;
}

function readModelMessage(
  value: unknown,
  committedAt: string
): ModelMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { id, role, content, name } = value;
  if (
    typeof id !== "string" ||
    !id ||
    typeof role !== "string" ||
    !role ||
    !("content" in value)
  ) {
    return undefined;
  }
  return {
    id,
    role,
    content,
    committedAt,
    ...(typeof name === "string" && name ? { name } : {})
  };
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
