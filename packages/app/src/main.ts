import { existsSync } from "node:fs";
import path from "node:path";
import { createMockConnector, createMockMessageEvent } from "./connectors/mock/connector";
import {
  createOneBotRuntime,
  createOneBotTransportFromConfig
} from "./connectors/onebot/live";
import {
  createLiveEventBus,
  createLiveRunStore,
  startLiveDebugServer,
  type LiveDebugServer,
  type LiveEventBus,
  type LiveRunStore
} from "./live";
import { createRuntime } from "./runtime/createRuntime";

interface CliOptions {
  home?: string;
  connector: "mock" | "onebot-forward-ws" | "onebot-reverse-ws";
  message: string;
  groupId: string;
  senderId: string;
  mentionsBot: boolean;
  onebotWsUrl?: string;
  onebotHost?: string;
  onebotPort?: number;
  onebotPath?: string;
  onebotAccessToken?: string;
  live: boolean;
  liveHost?: string;
  livePort?: number;
  liveUiDir?: string;
}

interface LiveSupport {
  bus: LiveEventBus;
  runStore: LiveRunStore;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options === "help") {
    printHelp();
    return;
  }

  if (options.connector !== "mock") {
    const liveSupport = options.live ? createLiveSupport() : undefined;
    const runtime = await createOneBotRuntime({
      ...(options.home ? { gestaltHome: options.home } : {}),
      ...(liveSupport ? { liveEvents: liveSupport.bus } : {}),
      transport: createOneBotTransportFromConfig({
        mode:
          options.connector === "onebot-forward-ws"
            ? "forward_ws"
            : "reverse_ws",
        ...(options.onebotWsUrl ? { url: options.onebotWsUrl } : {}),
        ...(options.onebotHost ? { host: options.onebotHost } : {}),
        ...(options.onebotPort ? { port: options.onebotPort } : {}),
        ...(options.onebotPath ? { path: options.onebotPath } : {}),
        ...(options.onebotAccessToken
          ? { accessToken: options.onebotAccessToken }
        : {})
      })
    });
    const liveServer = await startLiveServerIfEnabled(
      options,
      liveSupport,
      runtime
    );
    console.log(
      JSON.stringify(
        {
          connector: options.connector,
          gestaltHome: runtime.home.root,
          status: "listening",
          ...(liveServer ? { liveUrl: liveServer.url } : {})
        },
        null,
        2
      )
    );
    await waitForever();
    return;
  }

  const connector = createMockConnector();
  const liveSupport = options.live ? createLiveSupport() : undefined;
  const runtime = await createRuntime({
    ...(options.home ? { gestaltHome: options.home } : {}),
    connector,
    ...(liveSupport ? { liveEvents: liveSupport.bus } : {})
  });
  const liveServer = await startLiveServerIfEnabled(
    options,
    liveSupport,
    runtime
  );

  const event = createMockMessageEvent({
    conversationId: options.groupId,
    senderId: options.senderId,
    text: options.message,
    mentionsBot: options.mentionsBot
  });

  const result = await runtime.handleEvent(event);
  await runtime.whenIdle();

  console.log(
    JSON.stringify(
      result
        ? {
            triggered: true,
            traceId: result.traceId,
            gestaltHome: runtime.home.root,
            proposedActions: result.proposedActions.map(
              (action) => action.toolName
            ),
            tools: result.toolResults.map((toolResult) => toolResult.status),
            ...(liveServer ? { liveUrl: liveServer.url } : {})
          }
        : {
            triggered: false,
            gestaltHome: runtime.home.root,
            proposedActions: [],
            tools: [],
            ...(liveServer ? { liveUrl: liveServer.url } : {})
          },
      null,
      2
    )
  );

  if (liveServer) {
    await waitForever();
  }
}

function parseArgs(args: string[]): CliOptions | "help" {
  const options: CliOptions = {
    connector: "mock",
    message: "gestalt 在吗？",
    groupId: "mock-group",
    senderId: "mock-user",
    mentionsBot: true,
    live: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--help" || arg === "-h") {
      return "help";
    }
    if (arg === "--home") {
      options.home = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--connector") {
      const connector = readValue(args, index, arg);
      if (
        connector !== "mock" &&
        connector !== "onebot-forward-ws" &&
        connector !== "onebot-reverse-ws"
      ) {
        throw new Error(`Unsupported connector "${connector}".`);
      }
      options.connector = connector;
      index += 1;
      continue;
    }
    if (arg === "--onebot-ws-url") {
      options.onebotWsUrl = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--onebot-host") {
      options.onebotHost = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--onebot-port") {
      options.onebotPort = Number(readValue(args, index, arg));
      if (!Number.isInteger(options.onebotPort) || options.onebotPort <= 0) {
        throw new Error("--onebot-port must be a positive integer.");
      }
      index += 1;
      continue;
    }
    if (arg === "--onebot-path") {
      options.onebotPath = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--onebot-access-token") {
      options.onebotAccessToken = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--live") {
      options.live = true;
      continue;
    }
    if (arg === "--live-host") {
      options.liveHost = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--live-port") {
      options.livePort = Number(readValue(args, index, arg));
      if (!Number.isInteger(options.livePort) || options.livePort <= 0) {
        throw new Error("--live-port must be a positive integer.");
      }
      index += 1;
      continue;
    }
    if (arg === "--live-ui-dir") {
      options.liveUiDir = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--message") {
      options.message = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--group") {
      options.groupId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--sender") {
      options.senderId = readValue(args, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--no-mention") {
      options.mentionsBot = false;
      continue;
    }

    throw new Error(`Unknown argument "${arg}". Use --help for usage.`);
  }

  return options;
}

function readValue(args: string[], index: number, arg: string): string {
  const value = args[index + 1];
  if (!value) {
    throw new Error(`Missing value for ${arg}.`);
  }
  return value;
}

function createLiveSupport(): LiveSupport {
  const bus = createLiveEventBus();
  return {
    bus,
    runStore: createLiveRunStore(bus)
  };
}

async function startLiveServerIfEnabled(
  options: CliOptions,
  liveSupport: LiveSupport | undefined,
  runtime: Awaited<ReturnType<typeof createRuntime>>
): Promise<LiveDebugServer | undefined> {
  if (!liveSupport) {
    return undefined;
  }
  return startLiveDebugServer({
    runtime,
    bus: liveSupport.bus,
    runStore: liveSupport.runStore,
    ...(options.liveHost ? { host: options.liveHost } : {}),
    ...(options.livePort ? { port: options.livePort } : {}),
    ...(options.liveUiDir ? { uiDir: resolveLiveUiDir(options.liveUiDir) } : {})
  });
}

function resolveLiveUiDir(input: string): string {
  if (path.isAbsolute(input)) {
    return input;
  }

  const candidates = [
    path.resolve(input),
    path.resolve("..", input),
    path.resolve("..", "..", input)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

function printHelp(): void {
  console.log(`Usage:
  pnpm --filter @gestalt/app dev -- [options]

Options:
  --home <path>        GestaltHome path. Defaults to .gestalt or GESTALT_HOME.
  --connector <name>   mock, onebot-forward-ws, or onebot-reverse-ws.
  --message <text>     Mock message text.
  --group <id>         Mock group id.
  --sender <id>        Mock sender id.
  --no-mention         Mark the mock event as not directly mentioning the bot.
  --live               Start the local runtime live API/SSE server.
  --live-host <host>   Live server host. Defaults to 127.0.0.1.
  --live-port <port>   Live server port. Defaults to 5175.
  --live-ui-dir <dir>  Serve built trace UI assets from this directory.
  --onebot-ws-url <url>       OneBot forward WebSocket URL.
  --onebot-host <host>        Reverse WebSocket host. Defaults to 0.0.0.0.
  --onebot-port <port>        Reverse WebSocket port.
  --onebot-path <path>        Reverse WebSocket path. Defaults to /onebot/v11/ws.
  --onebot-access-token <t>   OneBot access token.
`);
}

function waitForever(): Promise<never> {
  return new Promise(() => {
    // Keep the connector process alive.
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
