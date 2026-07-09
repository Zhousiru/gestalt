import type { Runtime } from "../../runtime/createRuntime";
import { createRuntime } from "../../runtime/createRuntime";
import { loadConfig } from "../../home/loadConfig";
import { loadEnv } from "../../home/loadEnv";
import { resolveGestaltHome } from "../../home/resolveGestaltHome";
import type { LiveEventSink } from "../../live/viewTypes";
import { createAiSdkModelFromConfig } from "../../model/aiSdkModel";
import { createOneBotConnector } from "./connector";
import {
  createOneBotForwardWsTransport,
  createOneBotReverseWsTransport,
  type OneBotTransport
} from "./transport";

export interface RunOneBotRuntimeOptions {
  gestaltHome?: string;
  transport: OneBotTransport;
  liveEvents?: LiveEventSink;
}

export async function createOneBotRuntime(
  options: RunOneBotRuntimeOptions
): Promise<Runtime> {
  const home = await resolveGestaltHome(
    options.gestaltHome ? { homePath: options.gestaltHome } : {}
  );
  loadEnv(home);
  const config = await loadConfig(home);
  const connector = createOneBotConnector({
    caller: options.transport
  });
  const runtime = await createRuntime({
    gestaltHome: home.root,
    connector,
    model: createAiSdkModelFromConfig(config),
    ...(options.liveEvents ? { liveEvents: options.liveEvents } : {})
  });

  options.transport.onEvent((rawEvent) => {
    const event = connector.normalizeEvent(rawEvent);
    if (event) {
      void runtime.handleEvent(event);
    }
  });
  await options.transport.connect();
  return runtime;
}

export function createOneBotTransportFromConfig(input: {
  mode: "forward_ws" | "reverse_ws";
  url?: string;
  host?: string;
  port?: number;
  path?: string;
  accessToken?: string;
}): OneBotTransport {
  if (input.mode === "forward_ws") {
    if (!input.url) {
      throw new Error("OneBot forward_ws mode requires a WebSocket URL.");
    }
    return createOneBotForwardWsTransport({
      url: input.url,
      ...(input.accessToken ? { accessToken: input.accessToken } : {})
    });
  }

  if (!input.port) {
    throw new Error("OneBot reverse_ws mode requires a port.");
  }
  return createOneBotReverseWsTransport({
    ...(input.host ? { host: input.host } : {}),
    port: input.port,
    ...(input.path ? { path: input.path } : {}),
    ...(input.accessToken ? { accessToken: input.accessToken } : {})
  });
}
