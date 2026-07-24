import assert from "node:assert/strict";
import { appendFileSync, existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { type RawData } from "ws";
import { createMockConnector } from "../connectors/mock/connector";
import {
  createActionBashToolScope,
  type ActionBashToolScope
} from "../tools/agentBrowser";

interface CdpMessage {
  id?: number;
  method?: string;
  sessionId?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface PageSignals {
  url: string;
  title: string;
  bodyText: string;
  resultCount: number;
  rows: Array<{
    name: string;
    result: string;
  }>;
  fingerprint: {
    webdriver: boolean | null;
    userAgent: string;
    platform: string;
    languages: string[];
    plugins: number;
    hardwareConcurrency: number | null;
    webglVendor: string | null;
    webglRenderer: string | null;
  };
}

interface LiveTarget {
  id: "google" | "bing" | "sannysoft" | "browserscan" | "creepjs";
  url: string;
  settleMs: number;
}

interface TargetSummary {
  id: LiveTarget["id"];
  requestedUrl: string;
  finalUrl: string;
  title: string;
  outcome: string;
  resultCount: number;
  failedChecks: string[];
  fingerprint: PageSignals["fingerprint"];
  diagnostics: Record<string, string | number | boolean | null>;
}

interface AgentBrowserBridgeSummary {
  opened: boolean;
  titleRead: boolean;
  cdpRead: boolean;
  cleanupReturned: boolean;
  remainingRunDirectories: string[];
}

interface OpenAgentBrowserBridge {
  cdpUrl: string;
  summary: AgentBrowserBridgeSummary;
  dispose(): Promise<void>;
}

const LIVE_TARGETS: LiveTarget[] = [
  {
    id: "google",
    url: "https://www.google.com/search?q=OpenAI%20agent%20browser%20GitHub",
    settleMs: 3_000
  },
  {
    id: "bing",
    url: "https://www.bing.com/search?q=OpenAI%20agent%20browser%20GitHub",
    settleMs: 3_000
  },
  {
    id: "sannysoft",
    url: "https://bot.sannysoft.com/",
    settleMs: 4_000
  },
  {
    id: "browserscan",
    url: "https://www.browserscan.net/bot-detection",
    settleMs: 5_000
  },
  {
    id: "creepjs",
    url: "https://abrahamjuliot.github.io/creepjs/",
    settleMs: 10_000
  }
];
let progressArtifactPath: string | undefined;

async function runLiveVerification(): Promise<void> {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "gestalt-fortress-live-")
  );
  const projectRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../.."
  );
  const artifactDirectory = path.join(
    projectRoot,
    "harness",
    "artifacts",
    "fortress-browser-live"
  );
  const artifactPath = path.join(artifactDirectory, "summary.json");
  await mkdir(artifactDirectory, { recursive: true });
  progressArtifactPath = path.join(artifactDirectory, "progress.log");
  await writeFile(progressArtifactPath, "", "utf8");
  const executable = resolveFortressExecutable();
  const strict = process.env.FORTRESS_LIVE_STRICT === "1";

  let bridge: OpenAgentBrowserBridge | undefined;
  let cdp: CdpConnection | undefined;
  let verificationError: unknown;
  const summaries: TargetSummary[] = [];

  try {
    logProgress("opening agent-browser bridge");
    bridge = await openAgentBrowserBridge({
      temporaryRoot,
      executable
    });
    logProgress("agent-browser bridge ready");
    cdp = await CdpConnection.connect(bridge.cdpUrl);
    const { targetId } = await cdp.send<{ targetId: string }>(
      "Target.createTarget",
      { url: "about:blank" }
    );
    const { sessionId } = await cdp.send<{ sessionId: string }>(
      "Target.attachToTarget",
      {
        targetId,
        flatten: true
      }
    );
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    for (const target of LIVE_TARGETS) {
      logProgress(`opening ${target.id}`);
      const navigation: { errorText?: string } =
        await cdp.send<{ errorText?: string }>(
          "Page.navigate",
          { url: target.url },
          sessionId
        );
      assert.equal(
        navigation.errorText,
        undefined,
        `${target.id} navigation failed: ${navigation.errorText}`
      );
      await delay(target.settleMs);
      await cdp.send("Page.stopLoading", {}, sessionId);
      const signals = await readPageSignals(cdp, sessionId, target.id);
      const summary = summarizeTarget(target, signals);
      assertTargetReached(target, signals, summary);
      summaries.push(summary);
      logProgress(`${target.id}: ${summary.outcome}`);
    }

    assertCommonFingerprint(summaries);
    if (strict) {
      assertStrictOutcomes(summaries);
    }
  } catch (error) {
    verificationError = error;
  } finally {
    cdp?.close();
    if (bridge) {
      try {
        logProgress("closing agent-browser bridge");
        await bridge.dispose();
        logProgress("agent-browser bridge closed");
      } catch (error) {
        if (!verificationError) {
          verificationError = error;
        }
      }
    }
  }

  const remainingRunDirectories =
    bridge?.summary.remainingRunDirectories ?? [];
  if (remainingRunDirectories.length > 0 && !verificationError) {
    verificationError = new Error(
      `Fortress left live state behind: ${remainingRunDirectories.join(", ")}`
    );
  }

  const report = {
    ok: verificationError === undefined,
    strict,
    testedAt: new Date().toISOString(),
    executable,
    provider: {
      engine: "fortress",
      session: `gestalt-live-${process.pid}`
    },
    agentBrowserBridge: bridge?.summary ?? null,
    cleanup: {
      remainingRunDirectories
    },
    targets: summaries,
    error:
      verificationError instanceof Error
        ? verificationError.message
        : verificationError
          ? String(verificationError)
          : null
  };

  await writeFile(
    artifactPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await rm(temporaryRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100
  });

  console.log(
    JSON.stringify({ ...report, artifact: artifactPath }, null, 2)
  );
  if (verificationError) {
    throw verificationError;
  }
}

async function openAgentBrowserBridge(input: {
  temporaryRoot: string;
  executable: string;
}): Promise<OpenAgentBrowserBridge> {
  const stateRoot = path.join(input.temporaryRoot, "agent-browser-state");
  const configPath = path.join(
    input.temporaryRoot,
    "agent-browser-live.json"
  );
  const providerSource = fileURLToPath(
    new URL("./fortressProvider.ts", import.meta.url)
  );
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        plugins: [
          {
            name: "fortress",
            command: process.execPath,
            args: [
              "--import",
              "tsx",
              providerSource,
              "--executable",
              input.executable,
              "--state-root",
              stateRoot,
              "--launch-timeout-ms",
              "60000",
              "--close-timeout-ms",
              "10000",
              ...(process.platform === "linux"
                ? ["--no-sandbox"]
                : [])
            ],
            capabilities: ["browser.provider"]
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  const scope = createActionBashToolScope({
    namespace: `gestalt-live-${process.pid}`,
    sessionId: `gestalt-live-${process.pid}`,
    provider: "fortress",
    configPath,
    cleanupTimeoutMs: 15_000
  });
  const now = () => new Date();
  const connector = createMockConnector({ now });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  const summary: AgentBrowserBridgeSummary = {
    opened: false,
    titleRead: false,
    cdpRead: false,
    cleanupReturned: false,
    remainingRunDirectories: []
  };

  try {
    logProgress("launching Fortress through agent-browser");
    const opened = await scope.implementation(
      {
        id: "fortress-live-open",
        proposedAt: now().toISOString(),
        toolName: "bash",
        params: {
          command: "agent-browser open --json"
        }
      },
      {
        connector,
        now,
        signal: controller.signal
      }
    );
    assert.equal(opened.status, "executed");
    summary.opened = true;
    logProgress("agent-browser launch returned");

    logProgress("reading a page title through agent-browser");
    const title = await scope.implementation(
      {
        id: "fortress-live-title",
        proposedAt: now().toISOString(),
        toolName: "bash",
        params: {
          command:
            "agent-browser eval 'document.title=\"Gestalt Live Bridge\"; document.title' --json"
        }
      },
      {
        connector,
        now,
        signal: controller.signal
      }
    );
    assert.equal(title.status, "executed");
    const titleData = title.result?.data as
      | { stdout?: string }
      | undefined;
    assert.match(titleData?.stdout ?? "", /Gestalt Live Bridge/);
    summary.titleRead = true;
    logProgress("agent-browser page evaluation returned");

    logProgress("reading CDP URL through agent-browser");
    const cdpResult = await scope.implementation(
      {
        id: "fortress-live-cdp",
        proposedAt: now().toISOString(),
        toolName: "bash",
        params: {
          command: "agent-browser get cdp-url --json"
        }
      },
      {
        connector,
        now,
        signal: controller.signal
      }
    );
    assert.equal(cdpResult.status, "executed");
    const cdpData = cdpResult.result?.data as
      | { stdout?: string }
      | undefined;
    const cdpPayload = JSON.parse(cdpData?.stdout ?? "") as unknown;
    const cdpUrl = findWebSocketUrl(cdpPayload);
    assert.ok(cdpUrl, "agent-browser did not return a CDP WebSocket URL.");
    summary.cdpRead = true;
    logProgress("agent-browser CDP URL returned");
    clearTimeout(timer);

    return {
      cdpUrl,
      summary,
      dispose: createBridgeDisposer(scope, stateRoot, summary)
    };
  } catch (error) {
    clearTimeout(timer);
    await scope.dispose();
    throw error;
  }
}

function createBridgeDisposer(
  scope: ActionBashToolScope,
  stateRoot: string,
  summary: AgentBrowserBridgeSummary
): () => Promise<void> {
  let disposePromise: Promise<void> | undefined;
  return () => {
    disposePromise ??= (async () => {
      const cleanup = await scope.dispose();
      assert.equal(
        cleanup.exitCode,
        0,
        `agent-browser close failed: ${cleanup.stderr}`
      );
      summary.cleanupReturned = true;
      summary.remainingRunDirectories = existsSync(stateRoot)
        ? await readdir(stateRoot)
        : [];
      assert.deepEqual(
        summary.remainingRunDirectories,
        [],
        "agent-browser bridge left Fortress state behind."
      );
    })();
    return disposePromise;
  };
}

function findWebSocketUrl(value: unknown): string | undefined {
  if (typeof value === "string") {
    return /^wss?:\/\//.test(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findWebSocketUrl(item);
      if (found) {
        return found;
      }
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) {
      const found = findWebSocketUrl(item);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: NodeJS.Timeout;
    }
  >();
  #nextId = 1;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.on("message", (data) => this.#handleMessage(data));
    socket.on("close", () => {
      this.#rejectPending(new Error("CDP connection closed."));
    });
    socket.on("error", (error) => {
      this.#rejectPending(error);
    });
  }

  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.terminate();
        reject(new Error("Timed out connecting to Fortress CDP."));
      }, 10_000);
      socket.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new CdpConnection(socket);
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string
  ): Promise<T> {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Timed out waiting for CDP ${method}.`));
      }, 10_000);
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      this.#socket.send(
        JSON.stringify({
          id,
          method,
          params,
          ...(sessionId ? { sessionId } : {})
        })
      );
    });
  }

  close(): void {
    this.#socket.terminate();
  }

  #handleMessage(data: RawData): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(data.toString()) as CdpMessage;
    } catch {
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message ??
            `CDP command ${message.id} failed.`
        )
      );
      return;
    }
    pending.resolve(message.result ?? {});
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

async function readPageSignals(
  connection: CdpConnection,
  sessionId: string,
  targetId: LiveTarget["id"]
): Promise<PageSignals> {
  const expression = `(() => {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
    const debugInfo = gl && gl.getExtension("WEBGL_debug_renderer_info");
    const rows = Array.from(document.querySelectorAll("table tr"))
      .slice(0, 80)
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("th,td"))
          .map((cell) => (cell.textContent || "").trim().replace(/\\s+/g, " "));
        return { name: cells[0] || "", result: cells.slice(1).join(" ") };
      })
      .filter((row) => row.name || row.result);
    const selectors = ${JSON.stringify(resultSelectors(targetId))};
    const resultCount = selectors.reduce(
      (count, selector) => Math.max(count, document.querySelectorAll(selector).length),
      0
    );
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body && document.body.innerText || "").slice(0, 30000),
      resultCount,
      rows,
      fingerprint: {
        webdriver: typeof navigator.webdriver === "boolean" ? navigator.webdriver : null,
        userAgent: navigator.userAgent || "",
        platform: navigator.platform || "",
        languages: Array.from(navigator.languages || []),
        plugins: navigator.plugins ? navigator.plugins.length : 0,
        hardwareConcurrency: Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
        webglVendor: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : null,
        webglRenderer: debugInfo
          ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : null
      }
    };
  })()`;
  const evaluated = await connection.send<{
    result?: {
      value?: unknown;
      description?: string;
    };
    exceptionDetails?: unknown;
  }>(
    "Runtime.evaluate",
    {
      expression,
      returnByValue: true,
      awaitPromise: true
    },
    sessionId
  );
  assert.equal(
    evaluated.exceptionDetails,
    undefined,
    `Page evaluation failed: ${evaluated.result?.description ?? "unknown error"}`
  );
  return evaluated.result?.value as PageSignals;
}

function resultSelectors(targetId: LiveTarget["id"]): string[] {
  switch (targetId) {
    case "google":
      return ["#search a h3", "#rso a h3"];
    case "bing":
      return ["#b_results > li.b_algo", "#b_results h2 a"];
    default:
      return [];
  }
}

function summarizeTarget(
  target: LiveTarget,
  signals: PageSignals
): TargetSummary {
  const normalizedText = signals.bodyText.toLowerCase();
  const failedChecks = signals.rows
    .filter((row) => /\bfailed\b/i.test(row.result))
    .map((row) => row.name)
    .filter(Boolean);
  const diagnostics: TargetSummary["diagnostics"] = {
    bodyCharacters: signals.bodyText.length
  };
  let outcome = "loaded";

  if (target.id === "google" || target.id === "bing") {
    outcome =
      signals.resultCount > 0
        ? "results"
        : /sorry\/index|unusual traffic|异常流量|captcha|challenge/.test(
              `${signals.url.toLowerCase()} ${normalizedText}`
            )
          ? "bot_challenge"
          : /consent|before you continue|同意/.test(normalizedText)
            ? "consent"
            : "no_results";
  } else if (target.id === "sannysoft") {
    outcome =
      failedChecks.length === 0 ? "no_failed_rows" : "failed_rows";
    diagnostics.tableRows = signals.rows.length;
    diagnostics.failedRows = failedChecks.length;
  } else if (target.id === "browserscan") {
    const authenticity =
      signals.bodyText.match(/authenticity\s*:?\s*(\d+)%/i)?.[1] ??
      signals.bodyText.match(/真实性\s*:?\s*(\d+)%/i)?.[1];
    diagnostics.authenticityPercent = authenticity
      ? Number(authenticity)
      : null;
    outcome = authenticity ? "verdict_ready" : "loaded";
  } else {
    const likeHeadless =
      signals.bodyText.match(/(\d+)%\s+like headless/i)?.[1];
    const headless =
      signals.bodyText.match(/(\d+)%\s+headless/i)?.[1];
    const stealth =
      signals.bodyText.match(/(\d+)%\s+stealth/i)?.[1];
    diagnostics.likeHeadlessPercent = likeHeadless
      ? Number(likeHeadless)
      : null;
    diagnostics.headlessPercent = headless ? Number(headless) : null;
    diagnostics.stealthPercent = stealth ? Number(stealth) : null;
    outcome = headless ? "fingerprint_ready" : "loaded";
  }

  return {
    id: target.id,
    requestedUrl: target.url,
    finalUrl: signals.url,
    title: signals.title,
    outcome,
    resultCount: signals.resultCount,
    failedChecks,
    fingerprint: signals.fingerprint,
    diagnostics
  };
}

function assertTargetReached(
  target: LiveTarget,
  signals: PageSignals,
  summary: TargetSummary
): void {
  assert.ok(signals.url, `${target.id} did not expose a final URL.`);
  assert.ok(
    signals.bodyText.length >= 80,
    `${target.id} returned too little rendered text.`
  );
  const expectedHost = new URL(target.url).hostname;
  const actualHost = new URL(signals.url).hostname;
  const expectedDomain = expectedHost.replace(/^www\./, "");
  assert.ok(
    actualHost === expectedHost ||
      actualHost === expectedDomain ||
      actualHost.endsWith(`.${expectedDomain}`),
    `${target.id} navigated to unexpected host ${actualHost}.`
  );
  if (target.id === "google" || target.id === "bing") {
    assert.notEqual(
      summary.outcome,
      "no_results",
      `${target.id} rendered neither results nor a recognizable challenge.`
    );
  }
}

function assertCommonFingerprint(
  summaries: TargetSummary[]
): void {
  for (const summary of summaries) {
    assert.equal(
      summary.fingerprint.webdriver,
      false,
      `${summary.id} observed navigator.webdriver.`
    );
    assert.doesNotMatch(
      summary.fingerprint.userAgent,
      /HeadlessChrome/i,
      `${summary.id} observed a headless user agent.`
    );
    assert.ok(
      summary.fingerprint.plugins > 0,
      `${summary.id} observed no browser plugins.`
    );
    assert.ok(
      summary.fingerprint.languages.length > 0,
      `${summary.id} observed no browser languages.`
    );
  }
}

function assertStrictOutcomes(summaries: TargetSummary[]): void {
  for (const searchId of ["google", "bing"] as const) {
    const search = requireSummary(summaries, searchId);
    assert.equal(
      search.outcome,
      "results",
      `${searchId} did not return search results.`
    );
  }
  assert.equal(
    requireSummary(summaries, "sannysoft").failedChecks.length,
    0,
    "Sannysoft reported failed checks."
  );
}

function requireSummary(
  summaries: TargetSummary[],
  id: LiveTarget["id"]
): TargetSummary {
  const summary = summaries.find((candidate) => candidate.id === id);
  assert.ok(summary, `Missing ${id} live result.`);
  return summary;
}

function resolveFortressExecutable(): string {
  const configured = process.env.FORTRESS_EXECUTABLE?.trim();
  if (configured) {
    assert.ok(
      existsSync(configured),
      `FORTRESS_EXECUTABLE does not exist: ${configured}`
    );
    return path.resolve(configured);
  }
  const packaged = "/opt/fortress/tilion";
  assert.ok(
    existsSync(packaged),
    "Set FORTRESS_EXECUTABLE to a Tilion Fortress launcher before running verify:browser-live."
  );
  return packaged;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function logProgress(message: string): void {
  const line = `[verify:browser-live] ${message}\n`;
  process.stderr.write(line);
  if (progressArtifactPath) {
    appendFileSync(progressArtifactPath, line, "utf8");
  }
}

await runLiveVerification();
