import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  InMemoryFs,
  decodeBytesToUtf8,
  defineCommand,
  type CommandContext,
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

/**
 * Creates the active-loop bash implementation. Its VFS is private to that
 * loop, and agent-browser is the only native host command added to just-bash.
 */
export function createActionBashToolImplementation(
  options: CreateActionBashToolOptions = {}
): ToolImplementation {
  const agentBrowserTarget =
    options.agentBrowserTarget ?? resolveAgentBrowserTarget();
  const bash = createPhaseBash({
    fs: new InMemoryFs(),
    cwd: "/",
    customCommands: [
      defineCommand("agent-browser", (args, context) =>
        executeNativeCommand(agentBrowserTarget, args, context)
      )
    ]
  });

  return async (proposal, context): Promise<ToolHandlerResult> => {
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

async function executeNativeCommand(
  target: NativeCommandTarget,
  args: string[],
  context: CommandContext
): Promise<ExecResult> {
  if (context.signal?.aborted) {
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
      context.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => {
      aborted = true;
      child.kill();
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
    child.once("close", (code) => {
      settle({
        stdout,
        stderr,
        exitCode: aborted ? 124 : (code ?? 1)
      });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(decodeBytesToUtf8(context.stdin));

    if (context.signal) {
      context.signal.addEventListener("abort", abort, { once: true });
      if (context.signal.aborted) {
        abort();
      }
    }
  });
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
