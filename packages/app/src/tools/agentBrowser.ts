import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryFs,
  decodeBytesToUtf8,
  defineCommand,
  type ExecResult
} from "just-bash";
import type {
  ToolHandlerResult,
  ToolImplementation
} from "./executeActions";
import { createPhaseBash } from "./bash";

export interface NativeCommandTarget {
  executable: string;
  argsPrefix?: readonly string[];
}

export interface CreateActionBashToolOptions {
  agentBrowserTarget?: NativeCommandTarget;
}

export interface CreateActionBashToolScopeOptions
  extends CreateActionBashToolOptions {
  namespace: string;
  sessionId: string;
  provider?: string;
  configPath?: string;
  cleanupTimeoutMs?: number;
}

export interface ActionBashToolScope {
  implementation: ToolImplementation;
  dispose(): Promise<ExecResult>;
}

/**
 * Creates the active-loop bash implementation. Its VFS is private to that
 * loop, and agent-browser is the only native host command added to just-bash.
 */
export function createActionBashToolImplementation(
  options: CreateActionBashToolOptions = {}
): ToolImplementation {
  return createActionBashRuntime(options).implementation;
}

/**
 * Creates a bash implementation whose browser namespace and session are owned
 * by one active loop. dispose() is idempotent and closes only that session.
 */
export function createActionBashToolScope(
  options: CreateActionBashToolScopeOptions
): ActionBashToolScope {
  const namespace = requireRuntimeOwnedValue("namespace", options.namespace);
  const sessionId = requireRuntimeOwnedValue("session", options.sessionId);
  const runtime = createActionBashRuntime({
    ...options,
    namespace,
    sessionId
  });
  let disposePromise: Promise<ExecResult> | undefined;

  return {
    implementation: runtime.implementation,
    dispose() {
      disposePromise ??= runtime.wasAgentBrowserInvoked()
        ? closeAgentBrowserSession({
            target: runtime.agentBrowserTarget,
            namespace,
            sessionId,
            ...(options.provider
              ? { provider: options.provider }
              : {}),
            ...(options.configPath
              ? { configPath: options.configPath }
              : {}),
            timeoutMs: options.cleanupTimeoutMs ?? 10_000
          })
        : Promise.resolve({
            stdout: "",
            stderr: "",
            exitCode: 0
          });
      return disposePromise;
    }
  };
}

interface CreateActionBashRuntimeOptions extends CreateActionBashToolOptions {
  namespace?: string;
  sessionId?: string;
  provider?: string;
  configPath?: string;
}

function createActionBashRuntime(
  options: CreateActionBashRuntimeOptions
): {
  implementation: ToolImplementation;
  agentBrowserTarget: NativeCommandTarget;
  wasAgentBrowserInvoked(): boolean;
} {
  const agentBrowserTarget =
    options.agentBrowserTarget ?? resolveAgentBrowserTarget();
  let agentBrowserInvoked = false;
  const bash = createPhaseBash({
    fs: new InMemoryFs(),
    cwd: "/",
    customCommands: [
      defineCommand("agent-browser", (args, context) => {
        agentBrowserInvoked = true;
        return executeNativeCommand(
          agentBrowserTarget,
          options.namespace && options.sessionId
            ? bindRuntimeOwnedSession(
                args,
                options.namespace,
                options.sessionId,
                {
                  ...(options.provider
                    ? { provider: options.provider }
                    : {}),
                  ...(options.configPath
                    ? { configPath: options.configPath }
                    : {})
                }
              )
            : args,
          decodeBytesToUtf8(context.stdin),
          context.signal
        );
      })
    ]
  });

  return {
    agentBrowserTarget,
    wasAgentBrowserInvoked: () => agentBrowserInvoked,
    implementation: async (
      proposal,
      context
    ): Promise<ToolHandlerResult> => {
      if (proposal.toolName !== "bash") {
        return {
          status: "failed",
          reason: `bash handler received ${proposal.toolName}.`
        };
      }

      const result = await bash.exec(proposal.params.command, context.signal);
      return {
        status: result.exitCode === 0 ? "executed" : "failed",
        result: {
          ok: result.exitCode === 0,
          data: result
        }
      };
    }
  };
}

export function resolveAgentBrowserTarget(): NativeCommandTarget {
  const require = createRequire(import.meta.url);
  const wrapperPath = require.resolve(
    "agent-browser/bin/agent-browser.js"
  );
  const platform = resolveAgentBrowserPlatform();
  const architecture = resolveAgentBrowserArchitecture();
  const extension = process.platform === "win32" ? ".exe" : "";

  return {
    executable: path.join(
      path.dirname(wrapperPath),
      `agent-browser-${platform}-${architecture}${extension}`
    )
  };
}

export function resolvePackagedAgentBrowserConfigPath(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const bundledPath = path.join(
    moduleDirectory,
    "browser",
    "agent-browser.json"
  );
  if (existsSync(bundledPath)) {
    return bundledPath;
  }
  const sourcePath = path.resolve(
    moduleDirectory,
    "../../config/agent-browser.json"
  );
  return existsSync(sourcePath) ? sourcePath : bundledPath;
}

async function executeNativeCommand(
  target: NativeCommandTarget,
  args: string[],
  stdin: string,
  signal?: AbortSignal
): Promise<ExecResult> {
  if (signal?.aborted) {
    return {
      stdout: "",
      stderr: "",
      exitCode: 124
    };
  }

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let aborted = false;
    let settled = false;
    let exitDrainTimeout: NodeJS.Timeout | undefined;
    let abortSettleTimeout: NodeJS.Timeout | undefined;
    const child = spawn(
      target.executable,
      [...(target.argsPrefix ?? []), ...args],
      {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      }
    );

    const settle = (result: ExecResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(exitDrainTimeout);
      clearTimeout(abortSettleTimeout);
      signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      if (aborted || settled) {
        return;
      }
      aborted = true;
      child.kill();
      abortSettleTimeout = setTimeout(() => {
        child.kill("SIGKILL");
        settle({
          stdout,
          stderr,
          exitCode: 124
        });
      }, 1_000);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle({
        stdout,
        stderr: `${stderr}${error.message}\n`,
        exitCode: 1
      });
    });
    child.once("exit", (code) => {
      // A daemonized grandchild may inherit the CLI's stdout/stderr handles,
      // delaying Node's `close` event after the command process has exited.
      // Give buffered output a short drain window, then settle from `exit`.
      exitDrainTimeout = setTimeout(() => {
        settle({
          stdout,
          stderr,
          exitCode: aborted ? 124 : (code ?? 1)
        });
      }, 100);
    });
    child.once("close", (code) => {
      settle({
        stdout,
        stderr,
        exitCode: aborted ? 124 : (code ?? 1)
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);

    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
    }
  });
}

function bindRuntimeOwnedSession(
  args: string[],
  namespace: string,
  sessionId: string,
  routing: {
    provider?: string;
    configPath?: string;
  } = {}
): string[] {
  return [
    ...(routing.configPath
      ? ["--config", routing.configPath]
      : []),
    "--namespace",
    namespace,
    "--session",
    sessionId,
    ...(routing.provider
      ? ["--provider", routing.provider]
      : []),
    ...removeRuntimeOwnedOptions(args, routing)
  ];
}

function removeRuntimeOwnedOptions(
  args: string[],
  routing: {
    provider?: string;
    configPath?: string;
  }
): string[] {
  const filtered: string[] = [];
  let positionalOnly = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (positionalOnly) {
      filtered.push(arg);
      continue;
    }
    if (arg === "--") {
      positionalOnly = true;
      filtered.push(arg);
      continue;
    }
    if (
      arg === "--namespace" ||
      arg === "--session" ||
      (routing.provider && (arg === "--provider" || arg === "-p")) ||
      (routing.configPath && arg === "--config")
    ) {
      index += 1;
      continue;
    }
    if (
      arg.startsWith("--namespace=") ||
      arg.startsWith("--session=") ||
      (routing.provider &&
        (arg.startsWith("--provider=") ||
          (arg.startsWith("-p") && !arg.startsWith("--")))) ||
      (routing.configPath && arg.startsWith("--config="))
    ) {
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

async function closeAgentBrowserSession(input: {
  target: NativeCommandTarget;
  namespace: string;
  sessionId: string;
  provider?: string;
  configPath?: string;
  timeoutMs: number;
}): Promise<ExecResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);
  timeout.unref?.();
  try {
    return await executeNativeCommand(
      input.target,
      bindRuntimeOwnedSession([], input.namespace, input.sessionId, {
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.configPath
          ? { configPath: input.configPath }
          : {})
      }).concat("close"),
      "",
      controller.signal
    );
  } finally {
    clearTimeout(timeout);
  }
}

function requireRuntimeOwnedValue(label: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`agent-browser ${label} must not be empty.`);
  }
  return normalized;
}

function resolveAgentBrowserPlatform(): string {
  if (process.platform === "linux") {
    return isMuslRuntime() ? "linux-musl" : "linux";
  }
  if (process.platform === "darwin" || process.platform === "win32") {
    return process.platform;
  }
  throw new Error(`agent-browser does not support ${process.platform}.`);
}

function resolveAgentBrowserArchitecture(): string {
  if (process.platform === "win32" && process.arch === "arm64") {
    return "x64";
  }
  if (process.arch === "x64" || process.arch === "arm64") {
    return process.arch;
  }
  throw new Error(`agent-browser does not support ${process.arch}.`);
}

function isMuslRuntime(): boolean {
  const report = process.report?.getReport() as
    | { header?: { glibcVersionRuntime?: unknown } }
    | undefined;
  const header = report?.header;
  return typeof header?.glibcVersionRuntime !== "string";
}
