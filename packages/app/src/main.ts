import { existsSync } from "node:fs";
import path from "node:path";
import { createMockConnector, createMockMessageEvent } from "./connectors/mock/connector";
import {
  createOneBotRuntime,
  createOneBotTransportFromConfig
} from "./connectors/onebot/live";
import { loadConfig } from "./home/loadConfig";
import { loadEnv } from "./home/loadEnv";
import {
  resolveAppHostConfig,
  type AppHostConfig
} from "./home/resolveAppHostConfig";
import { resolveGestaltHome } from "./home/resolveGestaltHome";
import {
  createLiveEventBus,
  createLiveRunStore,
  resolveDefaultTraceUiDir,
  startLiveDebugServer,
  type LiveDebugServer,
  type LiveEventBus,
  type LiveRunStore
} from "./live";
import { createRuntime } from "./runtime/createRuntime";

interface CliOptions {
  home?: string;
  message: string;
  groupId: string;
  senderId: string;
  mentionsBot: boolean;
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

  const home = await resolveGestaltHome(
    options.home ? { homePath: options.home } : {}
  );
  loadEnv(home);
  const hostConfig = resolveAppHostConfig(await loadConfig(home));

  if (hostConfig.connector !== "mock") {
    const liveSupport = hostConfig.live.enabled ? createLiveSupport() : undefined;
    const runtime = await createOneBotRuntime({
      gestaltHome: home.root,
      ...(liveSupport ? { liveEvents: liveSupport.bus } : {}),
      transport: createOneBotTransportFromConfig({
        mode:
          hostConfig.connector === "onebot-forward-ws"
            ? "forward_ws"
            : "reverse_ws",
        ...(hostConfig.onebot.wsUrl ? { url: hostConfig.onebot.wsUrl } : {}),
        ...(hostConfig.onebot.host ? { host: hostConfig.onebot.host } : {}),
        ...(hostConfig.onebot.port ? { port: hostConfig.onebot.port } : {}),
        ...(hostConfig.onebot.path ? { path: hostConfig.onebot.path } : {}),
        ...(hostConfig.onebot.accessToken
          ? { accessToken: hostConfig.onebot.accessToken }
          : {})
      })
    });
    const liveServer = await startLiveServerIfEnabled(
      options,
      hostConfig,
      liveSupport,
      runtime
    );
    console.log(
      JSON.stringify(
        {
          connector: hostConfig.connector,
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
  const liveSupport = hostConfig.live.enabled ? createLiveSupport() : undefined;
  const runtime = await createRuntime({
    gestaltHome: home.root,
    connector,
    ...(liveSupport ? { liveEvents: liveSupport.bus } : {})
  });
  const liveServer = await startLiveServerIfEnabled(
    options,
    hostConfig,
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
    message: "gestalt 在吗？",
    groupId: "mock-group",
    senderId: "mock-user",
    mentionsBot: true
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
  hostConfig: AppHostConfig,
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
    host: hostConfig.live.host,
    port: hostConfig.live.port,
    uiDir: options.liveUiDir
      ? resolveLiveUiDir(options.liveUiDir)
      : resolveDefaultTraceUiDir(import.meta.url)
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
  --message <text>     Mock message text.
  --group <id>         Mock group id.
  --sender <id>        Mock sender id.
  --no-mention         Mark the mock event as not directly mentioning the bot.
  --live-ui-dir <dir>  Override the Live UI assets included in dist.

Connector, OneBot transport, and live server settings are read from
GestaltHome/config.toml.
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
