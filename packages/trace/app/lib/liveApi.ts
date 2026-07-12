import {
  ConversationTimelinePageSchema,
  ConversationsPageSchema,
  LiveOverviewSchema,
  ModelInputResponseSchema,
  RolloutDetailSchema,
  RolloutsPageSchema,
  type ConversationTimelinePage,
  type ConversationsPage,
  type LiveOverview,
  type ModelInputResponse,
  type ModelInputView,
  type RolloutDetail,
  type RolloutsPage,
  type RolloutStatus
} from "@gestalt/live-contracts";

const API_ROOT = "/api/live";

export class LiveApiError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "LiveApiError";
    this.status = status;
  }
}

export const liveApi = {
  overview(signal?: AbortSignal): Promise<LiveOverview> {
    return request("/overview", LiveOverviewSchema, signal);
  },

  conversations(
    input: { cursor?: string; limit: number; query?: string },
    signal?: AbortSignal
  ): Promise<ConversationsPage> {
    return request(
      withQuery("/conversations", input),
      ConversationsPageSchema,
      signal
    );
  },

  conversationTimeline(
    conversationKey: string,
    input: { cursor?: string; limit: number },
    signal?: AbortSignal
  ): Promise<ConversationTimelinePage> {
    return request(
      withQuery(
        `/conversations/${encodeURIComponent(conversationKey)}/timeline`,
        input
      ),
      ConversationTimelinePageSchema,
      signal
    );
  },

  rollouts(
    input: {
      cursor?: string;
      limit: number;
      query?: string;
      status?: RolloutStatus;
    },
    signal?: AbortSignal
  ): Promise<RolloutsPage> {
    return request(withQuery("/rollouts", input), RolloutsPageSchema, signal);
  },

  rollout(rolloutId: string, signal?: AbortSignal): Promise<RolloutDetail> {
    return request(
      `/rollouts/${encodeURIComponent(rolloutId)}`,
      RolloutDetailSchema,
      signal
    );
  },

  modelInput(
    rolloutId: string,
    generationId: string,
    view: ModelInputView,
    signal?: AbortSignal
  ): Promise<ModelInputResponse> {
    return request(
      withQuery(`/rollouts/${encodeURIComponent(rolloutId)}/model-input`, {
        generationId,
        view
      }),
      ModelInputResponseSchema,
      signal
    );
  },

  blobUrl(sha256: string): string {
    return `${API_ROOT}/blobs/${encodeURIComponent(sha256)}`;
  }
};

async function request<Output>(
  path: string,
  schema: WireSchema<Output>,
  signal?: AbortSignal
): Promise<Output> {
  const response = await fetch(`${API_ROOT}${path}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    ...(signal ? { signal } : {})
  });
  if (!response.ok) {
    throw new LiveApiError(
      `Live API request failed (${response.status})`,
      response.status
    );
  }
  const result = schema.safeParse(await response.json());
  if (!result.success) {
    const issue = result.error.issues[0];
    const location = issue?.path.length ? ` at ${issue.path.join(".")}` : "";
    throw new LiveApiError(`Live API returned invalid data${location}`);
  }
  return result.data;
}

interface WireSchema<Output> {
  safeParse(value: unknown):
    | { success: true; data: Output }
    | {
        success: false;
        error: { issues: Array<{ path: PropertyKey[] }> };
      };
}

function withQuery(
  path: string,
  values: Record<string, string | number | undefined>
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
