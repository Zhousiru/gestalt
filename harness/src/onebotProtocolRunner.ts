import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadDotenvFile } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentTurnTraceSchema,
  createAiSdkModelFromConfig,
  createNoopDreamingRunner,
  createOneBotConnector,
  createOneBotForwardWsTransport,
  createRuntime,
  loadConfig,
  resolveGestaltHome,
  type AgentTurnTrace,
  type AgentTurnResult,
  type MessageReceivedEvent,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot,
  type ObservationRecord,
  type SessionSnapshot
} from "@gestalt/app";

export interface OneBotProtocolRunResult {
  id: string;
  session: SessionSnapshot;
  event: MessageReceivedEvent;
  turnResults: AgentTurnResult[];
  modelRequests: ModelRequestSnapshot[];
  modelResponses: ModelResponseSnapshot[];
  onebotApiCalls: OneBotApiCall[];
  artifactPaths: {
    session: string;
    canonicalEvent: string;
    modelRequests: string;
    modelResponses: string;
    onebotApiCalls: string;
    traces: string;
    report: string;
  };
}

export interface OneBotApiCall {
  action: string;
  params?: Record<string, unknown>;
  echo?: unknown;
}

interface FakeOneBotServer {
  url: string;
  apiCalls: OneBotApiCall[];
  waitForConnection(): Promise<void>;
  sendEvent(event: unknown): void;
  waitForApiCall(action: string): Promise<OneBotApiCall>;
  close(): Promise<void>;
}

const RUN_ID = "onebot-protocol-e2e";

export async function runOneBotProtocolE2E(): Promise<OneBotProtocolRunResult> {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  loadLocalEnv(repoRoot);
  const artifactDir = path.join(repoRoot, "harness", "artifacts", RUN_ID);
  const tempHome = await createFixtureHome(repoRoot);
  const fakeOneBot = await createFakeOneBotServer();

  try {
    const home = await resolveGestaltHome({
      homePath: tempHome,
      create: false
    });
    const config = await loadConfig(home);
    const transport = createOneBotForwardWsTransport({
      url: fakeOneBot.url
    });
    const connector = createOneBotConnector({
      caller: transport
    });
    const runtime = await createRuntime({
      gestaltHome: tempHome,
      connector,
      model: createAiSdkModelFromConfig(config),
      dreamingRunner: createNoopDreamingRunner()
    });
    const turnPromises: Promise<AgentTurnResult | undefined>[] = [];
    let canonicalEvent: MessageReceivedEvent | undefined;

    transport.onEvent((rawEvent) => {
      const event = connector.normalizeEvent(rawEvent);
      if (!event) {
        return;
      }
      canonicalEvent = event;
      turnPromises.push(runtime.handleEvent(event));
    });
    await transport.connect();
    await fakeOneBot.waitForConnection();

    fakeOneBot.sendEvent(createOneBotGroupMessageEvent());
    const apiCall = await fakeOneBot.waitForApiCall("send_group_msg");
    await runtime.whenIdle();
    const turnResults = dedupeTurnResults(await Promise.all(turnPromises));
    if (!canonicalEvent) {
      throw new Error("OneBot protocol run did not produce a canonical event.");
    }

    const session = runtime.exportSession({
      exportedAt: new Date().toISOString()
    });
    const traces = await readTraces(home.tracesDir);
    const modelRequests = extractModelRequestsFromTraces(traces);
    const modelResponses = extractModelResponsesFromTraces(traces);
    const artifactPaths = await writeArtifacts({
      artifactDir,
      session,
      canonicalEvent,
      modelRequests,
      modelResponses,
      onebotApiCalls: fakeOneBot.apiCalls,
      traces
    });

    await transport[Symbol.asyncDispose]();
    return {
      id: RUN_ID,
      session,
      event: canonicalEvent,
      turnResults,
      modelRequests,
      modelResponses,
      onebotApiCalls: fakeOneBot.apiCalls,
      artifactPaths
    };
  } finally {
    await fakeOneBot.close();
    await rm(tempHome, { recursive: true, force: true });
  }
}

function createOneBotGroupMessageEvent(): Record<string, unknown> {
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: 10001,
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    message_id: 321,
    group_id: 123456,
    user_id: 424242,
    raw_message:
      "[CQ:reply,id=111][CQ:at,qq=10001] 小格看看这张图 [CQ:image,file=cat.png,url=https://example.test/cat.png] [CQ:face,id=14] [CQ:mface,emoji_id=emoji-direct-secret,emoji_package_id=package-direct-secret,key=REAL_DIRECT_MFACE_KEY,url=https://stickers.example.test/direct.gif?signature=SIGNED_DIRECT_TOKEN,file=marketface] [CQ:image,file=custom-sticker-secret.gif,path=C:\\private\\custom-sticker-secret.gif,url=https://stickers.example.test/custom.gif?signature=SIGNED_CUSTOM_TOKEN,sub_type=1] [CQ:image,file=marketface,url=https://stickers.example.test/compat.gif?signature=SIGNED_COMPAT_TOKEN,emoji_id=emoji-compat-secret,emoji_package_id=package-compat-secret,key=REAL_COMPAT_MFACE_KEY]",
    message: [
      {
        type: "reply",
        data: {
          id: "111"
        }
      },
      {
        type: "at",
        data: {
          qq: "10001",
          name: "小格"
        }
      },
      {
        type: "text",
        data: {
          text: " 小格看看这张图 "
        }
      },
      {
        type: "image",
        data: {
          file: "cat.png",
          url: "https://example.test/cat.png",
          summary: "一张测试图片"
        }
      },
      {
        type: "face",
        data: {
          id: "14",
          name: "微笑"
        }
      },
      {
        type: "mface",
        data: {
          emoji_id: "emoji-direct-secret",
          emoji_package_id: "package-direct-secret",
          key: "REAL_DIRECT_MFACE_KEY",
          url: "https://stickers.example.test/direct.gif?signature=SIGNED_DIRECT_TOKEN",
          file: "marketface"
        }
      },
      {
        type: "image",
        data: {
          file: "custom-sticker-secret.gif",
          path: "C:\\private\\custom-sticker-secret.gif",
          url: "https://stickers.example.test/custom.gif?signature=SIGNED_CUSTOM_TOKEN",
          sub_type: "1"
        }
      },
      {
        type: "image",
        data: {
          file: "marketface",
          url: "https://stickers.example.test/compat.gif?signature=SIGNED_COMPAT_TOKEN",
          emoji_id: "emoji-compat-secret",
          emoji_package_id: "package-compat-secret",
          key: "REAL_COMPAT_MFACE_KEY"
        }
      }
    ],
    font: 0,
    sender: {
      user_id: 424242,
      nickname: "Alice",
      card: "Alice",
      role: "member"
    }
  };
}

async function createFakeOneBotServer(): Promise<FakeOneBotServer> {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0
  });
  const sockets = new Set<WebSocket>();
  const apiCalls: OneBotApiCall[] = [];
  const waiters: Array<{
    action: string;
    resolve: (call: OneBotApiCall) => void;
  }> = [];
  const connectionWaiters: Array<() => void> = [];

  server.on("connection", (socket) => {
    sockets.add(socket);
    for (const resolve of connectionWaiters.splice(0)) {
      resolve();
    }
    socket.on("message", (data) => {
      const call = JSON.parse(data.toString()) as OneBotApiCall;
      apiCalls.push(call);
      socket.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: createOneBotActionResponseData(call),
          echo: call.echo
        })
      );
      for (const waiter of waiters.splice(0)) {
        if (waiter.action === call.action) {
          waiter.resolve(call);
        } else {
          waiters.push(waiter);
        }
      }
    });
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to read fake OneBot server address.");
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    apiCalls,

    waitForConnection() {
      if (sockets.size > 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        connectionWaiters.push(resolve);
      });
    },

    sendEvent(event) {
      for (const socket of sockets) {
        socket.send(JSON.stringify(event));
      }
    },

    waitForApiCall(action) {
      const existing = apiCalls.find((call) => call.action === action);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve) => {
        waiters.push({ action, resolve });
      });
    },

    async close() {
      for (const socket of sockets) {
        socket.close();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  };
}

function createOneBotActionResponseData(call: OneBotApiCall): unknown {
  if (call.action === "get_msg") {
    return {
      time: Math.floor(Date.now() / 1000),
      message_type: "group",
      message_id: call.params?.message_id ?? 111,
      real_id: call.params?.message_id ?? 111,
      sender: {
        user_id: 525252,
        nickname: "Quoted User",
        card: "Quoted User"
      },
      message: [
        {
          type: "text",
          data: {
            text: "这是被引用但不在本地 transcript 里的消息"
          }
        }
      ],
      raw_message: "这是被引用但不在本地 transcript 里的消息"
    };
  }

  if (call.action === "get_image") {
    return {
      file: "/mock/onebot/image/cat.png",
      base64:
        "base64://iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    };
  }

  if (
    call.action === "send_group_msg" ||
    call.action === "send_private_msg" ||
    call.action === "send_msg"
  ) {
    return {
      message_id: 987654
    };
  }

  return {};
}

async function createFixtureHome(repoRoot: string): Promise<string> {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-onebot-"));
  await cp(
    path.join(repoRoot, "harness/fixtures/homes/simple-group-test"),
    tempHome,
    { recursive: true }
  );
  return tempHome;
}

async function readTraces(tracesDir: string): Promise<AgentTurnTrace[]> {
  const traces: AgentTurnTrace[] = [];
  let fileNames: string[];
  try {
    fileNames = await import("node:fs/promises").then((fs) =>
      fs.readdir(tracesDir)
    );
  } catch {
    return traces;
  }
  for (const fileName of fileNames.filter((name) => name.endsWith(".jsonl"))) {
    const raw = await readFile(path.join(tracesDir, fileName), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim()) {
        traces.push(AgentTurnTraceSchema.parse(JSON.parse(line)));
      }
    }
  }
  return traces;
}

async function writeArtifacts(input: {
  artifactDir: string;
  session: SessionSnapshot;
  canonicalEvent: MessageReceivedEvent;
  modelRequests: ModelRequestSnapshot[];
  modelResponses: ModelResponseSnapshot[];
  onebotApiCalls: OneBotApiCall[];
  traces: unknown[];
}): Promise<OneBotProtocolRunResult["artifactPaths"]> {
  await rm(input.artifactDir, { recursive: true, force: true });
  await mkdir(input.artifactDir, { recursive: true });

  const artifactPaths = {
    session: path.join(input.artifactDir, "session.json"),
    canonicalEvent: path.join(input.artifactDir, "canonical-event.json"),
    modelRequests: path.join(input.artifactDir, "model-requests.json"),
    modelResponses: path.join(input.artifactDir, "model-responses.json"),
    onebotApiCalls: path.join(input.artifactDir, "onebot-api-calls.json"),
    traces: path.join(input.artifactDir, "traces.json"),
    report: path.join(input.artifactDir, "report.md")
  };

  await Promise.all([
    writeJson(artifactPaths.session, input.session),
    writeJson(artifactPaths.canonicalEvent, input.canonicalEvent),
    writeJson(artifactPaths.modelRequests, input.modelRequests),
    writeJson(artifactPaths.modelResponses, input.modelResponses),
    writeJson(artifactPaths.onebotApiCalls, input.onebotApiCalls),
    writeJson(artifactPaths.traces, input.traces),
    writeFile(artifactPaths.report, renderReport(input), "utf8")
  ]);
  return artifactPaths;
}

function renderReport(input: {
  session: SessionSnapshot;
  canonicalEvent: MessageReceivedEvent;
  modelRequests: ModelRequestSnapshot[];
  modelResponses: ModelResponseSnapshot[];
  onebotApiCalls: OneBotApiCall[];
}): string {
  return [
    "# OneBot Protocol E2E",
    "",
    "- Transport: forward WebSocket",
    `- Canonical conversation: ${input.canonicalEvent.conversation.kind}:${input.canonicalEvent.conversation.id}`,
    `- Mentions bot: ${input.canonicalEvent.message.mentionsBot}`,
    `- Reply to: ${input.canonicalEvent.message.replyToMessageId ?? "none"}`,
    `- Message text: ${input.canonicalEvent.message.text}`,
    `- Model requests: ${input.modelRequests.length}`,
    `- Model responses: ${input.modelResponses.length}`,
    `- OneBot API calls: ${input.onebotApiCalls
      .map((call) => call.action)
      .join(", ")}`,
    `- Session conversations: ${input.session.conversations.length}`,
    ""
  ].join("\n");
}

function extractModelRequestsFromTraces(
  traces: AgentTurnTrace[]
): ModelRequestSnapshot[] {
  return traces
    .flatMap((trace) => trace.observations)
    .filter((observation) => observation.type === "generation")
    .map(readModelRequestFromObservation)
    .filter((request): request is ModelRequestSnapshot => Boolean(request));
}

function extractModelResponsesFromTraces(
  traces: AgentTurnTrace[]
): ModelResponseSnapshot[] {
  return traces
    .flatMap((trace) => trace.observations)
    .filter((observation) => observation.type === "generation")
    .map(readModelResponseFromObservation)
    .filter((response): response is ModelResponseSnapshot => Boolean(response));
}

function readModelRequestFromObservation(
  observation: ObservationRecord
): ModelRequestSnapshot | undefined {
  const value = observation.input;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Partial<ModelRequestSnapshot>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.model !== "string" ||
    typeof candidate.temperature !== "number" ||
    typeof candidate.stepNumber !== "number" ||
    !Array.isArray(candidate.messages) ||
    !Array.isArray(candidate.tools)
  ) {
    return undefined;
  }
  return candidate as ModelRequestSnapshot;
}

function readModelResponseFromObservation(
  observation: ObservationRecord
): ModelResponseSnapshot | undefined {
  const value = observation.output;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as ModelResponseSnapshot;
}

function dedupeTurnResults(
  results: Array<AgentTurnResult | undefined>
): AgentTurnResult[] {
  const byTraceId = new Map<string, AgentTurnResult>();
  for (const result of results) {
    if (result) {
      byTraceId.set(result.traceId, result);
    }
  }
  return Array.from(byTraceId.values());
}

function loadLocalEnv(repoRoot: string): void {
  for (const fileName of [".env", ".env.local"]) {
    loadDotenvFile({
      path: path.join(repoRoot, fileName),
      override: false,
      quiet: true
    });
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function hashOneBotArtifacts(result: OneBotProtocolRunResult): string {
  return createHash("sha256")
    .update(JSON.stringify(result.onebotApiCalls))
    .update(result.event.message.text)
    .digest("hex");
}
