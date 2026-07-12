import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadDotenvFile } from "dotenv";
import { WebSocketServer, type WebSocket } from "ws";
import {
  createAiSdkModelFromConfig,
  createNoopDreamingRunner,
  createOneBotConnector,
  createOneBotForwardWsTransport,
  createRuntime,
  loadConfig,
  resolveGestaltHome,
  type AgentTurnResult,
  type MessageReceivedEvent,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot,
  type ReconstructedInput,
  type RolloutDetail,
  type SessionDiagnostics
} from "@gestalt/app";
import {
  createModelExchangeCapture,
  type ModelExchangeSnapshot as HarnessModelExchangeSnapshot
} from "./modelExchangeCapture";
import { readAndValidateRolloutCapture } from "./rolloutCaptureValidation";
import { writeArtifactJson } from "./artifactBinary";

export interface OneBotProtocolRunResult {
  id: string;
  session: SessionDiagnostics;
  event: MessageReceivedEvent;
  turnResults: AgentTurnResult[];
  modelRequests: ModelRequestSnapshot[];
  modelResponses: ModelResponseSnapshot[];
  modelExchanges: HarnessModelExchangeSnapshot[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
  onebotApiCalls: OneBotApiCall[];
  artifactPaths: {
    session: string;
    canonicalEvent: string;
    modelRequests: string;
    modelResponses: string;
    modelExchanges: string;
    onebotApiCalls: string;
    rollouts: string;
    reconstructedInputs: string;
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
    const modelCapture = createModelExchangeCapture();
    const runtime = await createRuntime({
      gestaltHome: tempHome,
      connector,
      model: modelCapture.wrap(createAiSdkModelFromConfig(config)),
      dreamingRunner: createNoopDreamingRunner()
    });
    const turnPromises: Promise<AgentTurnResult | undefined>[] = [];
    let canonicalEvent: MessageReceivedEvent | undefined;

    transport.onEvent(async (rawEvent) => {
      const event = connector.normalizeEvent(rawEvent);
      if (!event) {
        return;
      }
      canonicalEvent = event;
      const dispatch = await runtime.dispatchEvent(event);
      turnPromises.push(dispatch.outcome);
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

    const session = runtime.exportDiagnostics({
      exportedAt: new Date().toISOString()
    });
    const { rollouts, reconstructedInputs } =
      await readAndValidateRolloutCapture(
        home.tracesDir,
        modelCapture.exchanges
      );
    const modelRequests = modelCapture.exchanges.map((exchange) => exchange.request);
    const modelResponses = modelCapture.exchanges
      .map((exchange) => exchange.response)
      .filter((response): response is ModelResponseSnapshot => Boolean(response));
    const artifactPaths = await writeArtifacts({
      artifactDir,
      session,
      canonicalEvent,
      modelRequests,
      modelResponses,
      modelExchanges: modelCapture.exchanges,
      onebotApiCalls: fakeOneBot.apiCalls,
      rollouts,
      reconstructedInputs
    });

    await transport[Symbol.asyncDispose]();
    return {
      id: RUN_ID,
      session,
      event: canonicalEvent,
      turnResults,
      modelRequests,
      modelResponses,
      modelExchanges: modelCapture.exchanges,
      rollouts,
      reconstructedInputs,
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

async function writeArtifacts(input: {
  artifactDir: string;
  session: SessionDiagnostics;
  canonicalEvent: MessageReceivedEvent;
  modelRequests: ModelRequestSnapshot[];
  modelResponses: ModelResponseSnapshot[];
  modelExchanges: HarnessModelExchangeSnapshot[];
  onebotApiCalls: OneBotApiCall[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
}): Promise<OneBotProtocolRunResult["artifactPaths"]> {
  await rm(input.artifactDir, { recursive: true, force: true });
  await mkdir(input.artifactDir, { recursive: true });

  const artifactPaths = {
    session: path.join(input.artifactDir, "session.json"),
    canonicalEvent: path.join(input.artifactDir, "canonical-event.json"),
    modelRequests: path.join(input.artifactDir, "model-requests.json"),
    modelResponses: path.join(input.artifactDir, "model-responses.json"),
    modelExchanges: path.join(input.artifactDir, "model-exchanges.json"),
    onebotApiCalls: path.join(input.artifactDir, "onebot-api-calls.json"),
    rollouts: path.join(input.artifactDir, "rollouts.json"),
    reconstructedInputs: path.join(
      input.artifactDir,
      "reconstructed-inputs.json"
    ),
    report: path.join(input.artifactDir, "report.md")
  };

  await Promise.all([
    writeArtifactJson(artifactPaths.session, input.session),
    writeArtifactJson(artifactPaths.canonicalEvent, input.canonicalEvent),
    writeArtifactJson(artifactPaths.modelRequests, input.modelRequests),
    writeArtifactJson(artifactPaths.modelResponses, input.modelResponses),
    writeArtifactJson(artifactPaths.modelExchanges, input.modelExchanges),
    writeArtifactJson(artifactPaths.onebotApiCalls, input.onebotApiCalls),
    writeArtifactJson(artifactPaths.rollouts, input.rollouts),
    writeArtifactJson(artifactPaths.reconstructedInputs, input.reconstructedInputs),
    writeFile(artifactPaths.report, renderReport(input), "utf8")
  ]);
  return artifactPaths;
}

function renderReport(input: {
  session: SessionDiagnostics;
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

export function hashOneBotArtifacts(result: OneBotProtocolRunResult): string {
  return createHash("sha256")
    .update(JSON.stringify(result.onebotApiCalls))
    .update(result.event.message.text)
    .digest("hex");
}
