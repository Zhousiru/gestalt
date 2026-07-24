import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const PLUGIN_PROTOCOL = "agent-browser.plugin.v1";
const PROVIDER_NAME = "fortress";
const STATE_VERSION = 1;

interface PluginRequest {
  protocol?: unknown;
  type?: unknown;
  capability?: unknown;
  request?: unknown;
}

interface FortressLaunchRequest {
  session?: unknown;
  launchOptions?: {
    headed?: unknown;
  };
}

interface FortressCleanupRequest {
  runId?: unknown;
}

interface FortressRunState {
  version: 1;
  runId: string;
  pid: number;
  profileDir: string;
  session: string;
  cdpUrl?: string;
}

export interface FortressProviderOptions {
  executable: string;
  executableArgsPrefix: string[];
  stateRoot: string;
  launchTimeoutMs: number;
  closeTimeoutMs: number;
  noSandbox: boolean;
  extraArgs: string[];
}

export interface FortressPluginResponse {
  protocol: typeof PLUGIN_PROTOCOL;
  success: boolean;
  manifest?: {
    name: string;
    capabilities: string[];
    description: string;
  };
  browser?: {
    cdpUrl: string;
    directPage: boolean;
    metadata: {
      engine: string;
      session: string;
    };
    cleanup: {
      runId: string;
    };
  };
  data?: {
    closed: boolean;
  };
  error?: string;
}

export function parseFortressProviderOptions(
  args: readonly string[]
): FortressProviderOptions {
  const options: FortressProviderOptions = {
    executable:
      process.env.FORTRESS_EXECUTABLE ?? "/opt/fortress/tilion",
    executableArgsPrefix: [],
    stateRoot:
      process.env.FORTRESS_STATE_ROOT ?? "/tmp/gestalt-fortress",
    launchTimeoutMs: 40_000,
    closeTimeoutMs: 5_000,
    noSandbox: false,
    extraArgs: [
      "--enable-unsafe-swiftshader",
      "--disable-dev-shm-usage"
    ]
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const [name, inlineValue] = splitOption(arg);
    switch (name) {
      case "--executable":
        options.executable = readOptionValue(
          name,
          inlineValue,
          () => {
            index += 1;
            return args[index];
          }
        );
        break;
      case "--executable-arg":
        options.executableArgsPrefix.push(
          readOptionValue(name, inlineValue, () => {
            index += 1;
            return args[index];
          })
        );
        break;
      case "--state-root":
        options.stateRoot = readOptionValue(
          name,
          inlineValue,
          () => {
            index += 1;
            return args[index];
          }
        );
        break;
      case "--launch-timeout-ms":
        options.launchTimeoutMs = readPositiveInteger(
          name,
          readOptionValue(name, inlineValue, () => {
            index += 1;
            return args[index];
          })
        );
        break;
      case "--close-timeout-ms":
        options.closeTimeoutMs = readPositiveInteger(
          name,
          readOptionValue(name, inlineValue, () => {
            index += 1;
            return args[index];
          })
        );
        break;
      case "--extra-arg":
        options.extraArgs.push(
          readOptionValue(name, inlineValue, () => {
            index += 1;
            return args[index];
          })
        );
        break;
      case "--no-sandbox":
        options.noSandbox = true;
        break;
      default:
        throw new Error(`Unknown Fortress provider option: ${arg}`);
    }
  }

  return options;
}

export async function handleFortressPluginRequest(
  input: PluginRequest,
  options: FortressProviderOptions
): Promise<FortressPluginResponse> {
  if (input.protocol !== PLUGIN_PROTOCOL) {
    return failure("unsupported plugin protocol");
  }

  if (input.type === "plugin.manifest") {
    return {
      protocol: PLUGIN_PROTOCOL,
      success: true,
      manifest: {
        name: PROVIDER_NAME,
        capabilities: ["browser.provider"],
        description:
          "Launch an isolated Tilion Fortress browser and return its CDP endpoint."
      }
    };
  }

  if (
    input.capability !== "browser.provider" ||
    (input.type !== "browser.launch" &&
      input.type !== "browser.close")
  ) {
    return failure(`unsupported request type: ${String(input.type)}`);
  }

  try {
    if (input.type === "browser.launch") {
      return await launchFortress(
        readLaunchRequest(input.request),
        options
      );
    }

    const closed = await closeFortress(
      readCleanupRequest(input.request),
      options
    );
    return {
      protocol: PLUGIN_PROTOCOL,
      success: true,
      data: { closed }
    };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

async function launchFortress(
  request: FortressLaunchRequest,
  options: FortressProviderOptions
): Promise<FortressPluginResponse> {
  const session =
    typeof request.session === "string" && request.session.trim()
      ? request.session.trim()
      : "default";
  const runId = randomUUID();
  const runDir = resolveRunDir(options.stateRoot, runId);
  const profileDir = path.join(runDir, "profile");
  const port = await reserveLocalPort();

  await mkdir(profileDir, { recursive: true, mode: 0o700 });
  const launchArgs = [
    ...options.executableArgsPrefix,
    ...(request.launchOptions?.headed === true
      ? []
      : ["--headless=new"]),
    ...(options.noSandbox ? ["--no-sandbox"] : []),
    ...options.extraArgs,
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`
  ];

  const child = spawn(options.executable, launchArgs, {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true
  });
  await waitForSpawn(child);
  const pid = child.pid;
  if (!pid) {
    throw new Error("Fortress did not expose a process id.");
  }
  child.unref();

  const state: FortressRunState = {
    version: STATE_VERSION,
    runId,
    pid,
    profileDir,
    session
  };
  try {
    await writeRunState(runDir, state);
    const cdpUrl = await waitForCdp(
      port,
      pid,
      options.launchTimeoutMs
    );
    state.pid = await waitForBrowserProcessId(cdpUrl, pid);
    state.cdpUrl = cdpUrl;
    await writeRunState(runDir, state);
    return {
      protocol: PLUGIN_PROTOCOL,
      success: true,
      browser: {
        cdpUrl,
        directPage: false,
        metadata: {
          engine: PROVIDER_NAME,
          session
        },
        cleanup: { runId }
      }
    };
  } catch (error) {
    await stopProcessGroup(pid, options.closeTimeoutMs);
    await rm(runDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeFortress(
  request: FortressCleanupRequest,
  options: FortressProviderOptions
): Promise<boolean> {
  const runId = requireRunId(request.runId);
  return stopFortressRun(runId, options);
}

async function stopFortressRun(
  runId: string,
  options: FortressProviderOptions
): Promise<boolean> {
  const runDir = resolveRunDir(options.stateRoot, runId);
  let state: FortressRunState;
  try {
    state = parseRunState(
      JSON.parse(
        await readFile(path.join(runDir, "state.json"), "utf8")
      )
    );
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }

  if (state.runId !== runId) {
    throw new Error("Fortress cleanup state does not match its run id.");
  }

  let browserPid = state.pid;
  if (state.cdpUrl) {
    browserPid =
      (await readBrowserProcessId(state.cdpUrl)) ?? browserPid;
    await requestBrowserClose(state.cdpUrl);
  }
  await stopProcessGroup(browserPid, options.closeTimeoutMs);
  if (browserPid !== state.pid) {
    await stopProcessGroup(state.pid, options.closeTimeoutMs);
  }
  await removeFortressRunDirectory(runDir, state.profileDir);
  return true;
}

async function writeRunState(
  runDir: string,
  state: FortressRunState
): Promise<void> {
  await writeFile(
    path.join(runDir, "state.json"),
    `${JSON.stringify(state)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
}

async function readBrowserProcessId(
  cdpUrl: string
): Promise<number | undefined> {
  try {
    const result = await sendCdpCommand<{
      processInfo?: Array<{
        type?: unknown;
        id?: unknown;
      }>;
    }>(cdpUrl, "SystemInfo.getProcessInfo", 2_000);
    const browser = result.processInfo?.find(
      (processInfo) => processInfo.type === "browser"
    );
    return typeof browser?.id === "number" &&
      Number.isSafeInteger(browser.id) &&
      browser.id > 0
      ? browser.id
      : undefined;
  } catch {
    return undefined;
  }
}

async function waitForBrowserProcessId(
  cdpUrl: string,
  fallbackPid: number
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pid = await readBrowserProcessId(cdpUrl);
    if (pid) {
      return pid;
    }
    await delay(100);
  }
  return fallbackPid;
}

async function requestBrowserClose(cdpUrl: string): Promise<void> {
  try {
    await sendCdpCommand(cdpUrl, "Browser.close", 2_000);
  } catch {
    // Browser.close commonly tears down the socket before replying.
  }
  await delay(100);
}

function sendCdpCommand<T = Record<string, unknown>>(
  cdpUrl: string,
  method: string,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const socket = new WebSocket(cdpUrl);
    let settled = false;
    const finish = (
      outcome: { result: T } | { error: Error }
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      if ("error" in outcome) {
        reject(outcome.error);
      } else {
        resolve(outcome.result);
      }
    };
    const timer = setTimeout(() => {
      finish({
        error: new Error(`Timed out waiting for CDP ${method}.`)
      });
    }, timeoutMs);
    socket.once("open", () => {
      socket.send(
        JSON.stringify({
          id: 1,
          method,
          params: {}
        })
      );
    });
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as {
          id?: unknown;
          result?: T;
          error?: {
            message?: unknown;
          };
        };
        if (message.id !== 1) {
          return;
        }
        if (message.error) {
          finish({
            error: new Error(
              typeof message.error.message === "string"
                ? message.error.message
                : `CDP ${method} failed.`
            )
          });
          return;
        }
        finish({ result: message.result ?? ({} as T) });
      } catch (error) {
        finish({
          error: error instanceof Error ? error : new Error(String(error))
        });
      }
    });
    socket.once("error", (error) => {
      finish({ error });
    });
    socket.once("close", () => {
      finish({
        error: new Error(`CDP closed before ${method} replied.`)
      });
    });
  });
}

async function removeFortressRunDirectory(
  runDir: string,
  profileDir: string
): Promise<void> {
  const resolvedRunDir = path.resolve(runDir);
  const resolvedProfileDir = path.resolve(profileDir);
  if (path.dirname(resolvedProfileDir) !== resolvedRunDir) {
    throw new Error("Invalid Fortress profile cleanup path.");
  }

  // Chromium can briefly retain profile database handles after its browser
  // process exits on Windows. Delete the profile first so state.json remains
  // available for a retry if cleanup ultimately cannot complete.
  await rm(resolvedProfileDir, {
    recursive: true,
    force: true,
    maxRetries: 50,
    retryDelay: 100
  });
  await rm(resolvedRunDir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  });
}

async function stopProcessGroup(
  pid: number,
  timeoutMs: number
): Promise<void> {
  if (!isProcessGroupAlive(pid)) {
    return;
  }
  signalProcessGroup(pid, "SIGTERM");
  const stopped = await waitForProcessGroupExit(pid, timeoutMs);
  if (!stopped) {
    signalProcessGroup(pid, "SIGKILL");
    await waitForProcessGroupExit(pid, 2_000);
  }
}

async function waitForCdp(
  port: number,
  pid: number,
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) {
      throw new Error("Fortress exited before its CDP endpoint was ready.");
    }
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/version`,
        { signal: AbortSignal.timeout(1_000) }
      );
      if (response.ok) {
        const payload = (await response.json()) as {
          webSocketDebuggerUrl?: unknown;
        };
        if (
          typeof payload.webSocketDebuggerUrl === "string" &&
          payload.webSocketDebuggerUrl
        ) {
          return payload.webSocketDebuggerUrl;
        }
      }
    } catch {
      // Fortress is still starting.
    }
    await delay(250);
  }
  throw new Error("Fortress CDP endpoint did not become ready in time.");
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  server.unref();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a local CDP port."));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function resolveRunDir(stateRoot: string, runId: string): string {
  requireRunId(runId);
  const resolvedRoot = path.resolve(stateRoot);
  const runDir = path.resolve(resolvedRoot, runId);
  if (path.dirname(runDir) !== resolvedRoot) {
    throw new Error("Invalid Fortress cleanup path.");
  }
  return runDir;
}

function parseRunState(value: unknown): FortressRunState {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid Fortress cleanup state.");
  }
  const candidate = value as Partial<FortressRunState>;
  if (
    candidate.version !== STATE_VERSION ||
    typeof candidate.runId !== "string" ||
    typeof candidate.pid !== "number" ||
    !Number.isSafeInteger(candidate.pid) ||
    candidate.pid <= 0 ||
    typeof candidate.profileDir !== "string" ||
    typeof candidate.session !== "string" ||
    (candidate.cdpUrl !== undefined &&
      (typeof candidate.cdpUrl !== "string" ||
        !/^wss?:\/\//.test(candidate.cdpUrl)))
  ) {
    throw new Error("Invalid Fortress cleanup state.");
  }
  requireRunId(candidate.runId);
  return candidate as FortressRunState;
}

function readLaunchRequest(value: unknown): FortressLaunchRequest {
  return value && typeof value === "object"
    ? (value as FortressLaunchRequest)
    : {};
}

function readCleanupRequest(value: unknown): FortressCleanupRequest {
  if (!value || typeof value !== "object") {
    throw new Error("Fortress cleanup request is missing.");
  }
  return value as FortressCleanupRequest;
}

function requireRunId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  ) {
    throw new Error("Invalid Fortress run id.");
  }
  return value;
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error);
  }
}

function signalProcessGroup(
  pid: number,
  signal: NodeJS.Signals
): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch (error) {
    if (!isNoSuchProcessError(error)) {
      throw error;
    }
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessGroupAlive(pid)) {
      return true;
    }
    await delay(50);
  }
  return !isProcessGroupAlive(pid);
}

function waitForSpawn(
  child: ReturnType<typeof spawn>
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function splitOption(value: string): [string, string | undefined] {
  const separator = value.indexOf("=");
  return separator < 0
    ? [value, undefined]
    : [value.slice(0, separator), value.slice(separator + 1)];
}

function readOptionValue(
  name: string,
  inlineValue: string | undefined,
  next: () => string | undefined
): string {
  const value = inlineValue ?? next();
  if (!value) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function readPositiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isNoSuchProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ESRCH"
  );
}

function failure(error: string): FortressPluginResponse {
  return {
    protocol: PLUGIN_PROTOCOL,
    success: false,
    error
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runPlugin(): Promise<void> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const input = JSON.parse(
      Buffer.concat(chunks).toString("utf8")
    ) as PluginRequest;
    const options = parseFortressProviderOptions(
      process.argv.slice(2)
    );
    process.stdout.write(
      JSON.stringify(
        await handleFortressPluginRequest(input, options)
      )
    );
  } catch (error) {
    process.stdout.write(
      JSON.stringify(
        failure(error instanceof Error ? error.message : String(error))
      )
    );
  }
}

const entryPath = process.argv[1];
if (
  entryPath &&
  import.meta.url === pathToFileURL(path.resolve(entryPath)).href
) {
  await runPlugin();
}
