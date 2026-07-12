import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config as loadDotenvFile } from "dotenv";
import {
  createBashDreamingRunner,
  createAiSdkDreamingRunner,
  createAiSdkModelFromConfig,
  createMockConnector,
  createMockModel,
  createMockToolKit,
  createNoopDreamingRunner,
  createRuntime,
  getMemoryUserPathSegment,
  loadConfig,
  resolveGestaltHome,
  SessionJournalRecordSchema,
  type AgentTurnResult,
  type AgentTurnTrace,
  type DreamingRunner,
  type ModelRequestSnapshot,
  type ModelResponseSnapshot,
  type MockConnector,
  type MockToolKit,
  type ReconstructedInput,
  type RolloutDetail,
  type SessionJournalRecord,
  type SessionDiagnostics
} from "@gestalt/app";
import { ScenarioFixtureSchema, type ScenarioFixture } from "./fixtureSchema";
import {
  createModelExchangeCapture,
  type ModelExchangeSnapshot
} from "./modelExchangeCapture";
import { writeArtifactJson } from "./artifactBinary";
import { readAndValidateRolloutCapture } from "./rolloutCaptureValidation";

export type { ModelExchangeSnapshot } from "./modelExchangeCapture";

export interface ReplayRunResult {
  fixture: ScenarioFixture;
  session: SessionDiagnostics;
  sessionJournal: SessionJournalRecord[];
  turnTraces: AgentTurnTrace[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
  modelRequests: ModelRequestSnapshot[];
  modelExchanges: ModelExchangeSnapshot[];
  turnResults: AgentTurnResult[];
  homeBefore: HomeSnapshot;
  homeAfter: HomeSnapshot;
  connector: MockConnector;
  mockTools: MockToolKit;
  artifactDir: string;
  artifactPaths: {
    session: string;
    sessionJournal: string;
    turnTraces: string;
    rollouts: string;
    reconstructedInputs: string;
    modelRequests: string;
    modelExchanges: string;
    homeBefore: string;
    homeAfter: string;
    summary: string;
    report: string;
  };
}

export interface HomeSnapshot {
  capturedAt: string;
  files: HomeFileSnapshot[];
}

export interface HomeFileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  content?: string;
}

interface ReplayPaths {
  repoRoot: string;
  fixturePath: string;
  artifactRoot: string;
}

export async function runScenarioFixture(
  fixturePath: string
): Promise<ReplayRunResult> {
  const paths = getReplayPaths(fixturePath);
  loadLocalEnv(paths.repoRoot);

  const fixture = await readScenarioFixture(paths.fixturePath);
  const tempHome = await createScenarioHome(paths.repoRoot, fixture);

  try {
    const fixedNow = fixture.now ? new Date(fixture.now) : undefined;
    const now = fixedNow ? () => new Date(fixedNow) : () => new Date();
    const home = await resolveGestaltHome({
      homePath: tempHome,
      create: false
    });
    const config = await loadConfig(home);
    const connector = createMockConnector({ now });
    const mockTools = createMockToolKit();
    const modelCapture = createModelExchangeCapture();
    const baseModel =
      fixture.model.kind === "mock"
        ? createMockModel({ now, delayMs: fixture.model.delayMs ?? 0 })
        : createAiSdkModelFromConfig(config, {
            now,
            onRequest: () => modelCapture.notifyRequestStarted()
          });
    const model = modelCapture.wrap(baseModel);
    const dreamingRunner = createFixtureDreamingRunner(fixture, config);
    const runtime = await createRuntime({
      gestaltHome: tempHome,
      connector,
      model,
      toolImplementations: mockTools.implementations,
      dreamingRunner,
      now
    });
    const homeBefore = await snapshotHome(tempHome);

    const turnPromises: Promise<AgentTurnResult | undefined>[] = [];

    for (const eventInput of fixture.events) {
      await delay(eventInput.delayMs);
      if (eventInput.waitForModelRequestCount !== undefined) {
        await modelCapture.waitForRequestCount(
          eventInput.waitForModelRequestCount
        );
      }
      const event = connector.createMessageEvent({
        conversationId: eventInput.conversationId,
        ...(eventInput.conversationName
          ? { conversationName: eventInput.conversationName }
          : {}),
        senderId: eventInput.senderId,
        ...(eventInput.senderName ? { senderName: eventInput.senderName } : {}),
        ...(eventInput.messageId ? { messageId: eventInput.messageId } : {}),
        text: eventInput.text,
        ...(eventInput.replyToMessageId
          ? { replyToMessageId: eventInput.replyToMessageId }
          : {}),
        mentionsBot: eventInput.mentionsBot
      });
      // Harness fixtures use their explicit message identity as the stable
      // canonical event identity so eventIds assertions are deterministic.
      if (eventInput.messageId) {
        event.id = eventInput.messageId;
      }
      if (fixture.eventHandling === "runtime_triggers") {
        turnPromises.push(runtime.handleEvent(event));
        continue;
      }

      const record = await runtime.ingestEvent(event);
      turnPromises.push(
        runtime.handleMessageWindow({
          conversation: event.conversation,
          eventIds: [record.event.id],
          reason: eventInput.windowReason
        })
      );
    }

    const turnResults = dedupeTurnResults(await Promise.all(turnPromises));
    await runtime.whenIdle();

    const session = runtime.exportDiagnostics({
      exportedAt: new Date().toISOString()
    });
    const sessionJournal = await readSessionJournal(home.sessionsDir);
    const turnTraces = turnResults.map((result) => result.trace);
    const modelExchanges = modelCapture.exchanges;
    const modelRequests = modelExchanges.map((exchange) => exchange.request);
    const { rollouts, reconstructedInputs } =
      await readAndValidateRolloutCapture(home.tracesDir, modelExchanges);
    const homeAfter = await snapshotHome(tempHome);
    const artifactDir = path.join(paths.artifactRoot, fixture.id);
    const artifactPaths = await writeArtifacts({
      artifactDir,
      fixture,
      session,
      sessionJournal,
      turnTraces,
      rollouts,
      reconstructedInputs,
      modelRequests,
      modelExchanges,
      turnResults,
      homeBefore,
      homeAfter,
      mockTools,
      connector
    });

    return {
      fixture,
      session,
      sessionJournal,
      turnTraces,
      rollouts,
      reconstructedInputs,
      modelRequests,
      modelExchanges,
      turnResults,
      homeBefore,
      homeAfter,
      connector,
      mockTools,
      artifactDir,
      artifactPaths
    };
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

function createFixtureDreamingRunner(
  fixture: ScenarioFixture,
  config: Awaited<ReturnType<typeof loadConfig>>
): DreamingRunner {
  if (fixture.dreaming.kind === "configured_bash_memory") {
    return createAiSdkDreamingRunner(config);
  }

  if (fixture.dreaming.kind === "mock_bash_memory") {
    return createBashDreamingRunner({
      async dream(input) {
        const participantId = getFirstMessageSenderId(input);
        const participantSegment = getMemoryUserPathSegment(participantId);
        const userDirectory = `users/${participantSegment}`;

        await input.bash.exec(`cat self/index.md || true`);
        await input.bash.exec(`cat ${userDirectory}/index.md || true`);
        await input.bash.exec(`mkdir -p self ${userDirectory}`);
        await input.bash.exec(
          `printf ${shellQuote(
            "- Dreamed self memory write: verified memory dreaming can update self memory.\\n"
          )} >> self/index.md`
        );
        await input.bash.exec(
          `printf ${shellQuote(
            "Self subject note: memory dreaming wrote a self subject file.\\n"
          )} > self/memory-system.md`
        );
        await input.bash.exec(
          `printf ${shellQuote(
            "- Dreamed user memory write: verified memory dreaming can update participant memory.\\n"
          )} >> ${userDirectory}/index.md`
        );
        await input.bash.exec(
          `printf ${shellQuote(
            "User subject note: memory dreaming wrote a participant subject file.\\n"
          )} > ${userDirectory}/memory-system.md`
        );
      }
    });
  }

  return createNoopDreamingRunner();
}

function getFirstMessageSenderId(input: {
  eventRecords: AgentTurnResult["eventRecords"];
}): string {
  const record = input.eventRecords.find(
    (candidate) => candidate.event.type === "MessageReceived"
  );
  if (record?.event.type === "MessageReceived") {
    return record.event.sender.id;
  }
  return "unknown";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function readScenarioFixture(fixturePath: string): Promise<ScenarioFixture> {
  const raw = await readFile(fixturePath, "utf8");
  return ScenarioFixtureSchema.parse(JSON.parse(raw));
}

function getReplayPaths(fixturePath: string): ReplayPaths {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  return {
    repoRoot,
    fixturePath: path.resolve(repoRoot, fixturePath),
    artifactRoot: path.join(repoRoot, "harness", "artifacts")
  };
}

async function createScenarioHome(
  repoRoot: string,
  fixture: ScenarioFixture
): Promise<string> {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-replay-"));

  if (fixture.homeFixture) {
    await cp(path.join(repoRoot, fixture.homeFixture), tempHome, {
      recursive: true
    });
  }

  const configFixture =
    fixture.configFixture ??
    (fixture.homeFixture ? undefined : ".gestalt/config.toml");
  if (configFixture) {
    await cp(
      path.join(repoRoot, configFixture),
      path.join(tempHome, "config.toml")
    );
  }

  if (fixture.personaFixture) {
    await rm(path.join(tempHome, "persona"), { recursive: true, force: true });
    await cp(
      path.join(repoRoot, fixture.personaFixture),
      path.join(tempHome, "persona"),
      { recursive: true }
    );
  }

  if (fixture.memoriesFixture) {
    await rm(path.join(tempHome, "memories"), { recursive: true, force: true });
    await cp(
      path.join(repoRoot, fixture.memoriesFixture),
      path.join(tempHome, "memories"),
      { recursive: true }
    );
  }

  if (fixture.sessionJournalFixture) {
    await installSessionJournalFixture(
      path.join(repoRoot, fixture.sessionJournalFixture),
      tempHome
    );
  }

  return tempHome;
}

async function installSessionJournalFixture(
  fixturePath: string,
  homeRoot: string
): Promise<void> {
  const raw = await readFile(fixturePath, "utf8");
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) {
    throw new Error(`Session journal fixture is empty: ${fixturePath}`);
  }
  const firstRecord = JSON.parse(firstLine) as { recordedAt?: unknown };
  if (typeof firstRecord.recordedAt !== "string") {
    throw new Error(
      `Session journal fixture has no recordedAt timestamp: ${fixturePath}`
    );
  }
  const timestamp = new Date(firstRecord.recordedAt);
  if (Number.isNaN(timestamp.valueOf())) {
    throw new Error(
      `Session journal fixture has an invalid recordedAt timestamp: ${fixturePath}`
    );
  }
  const targetDir = path.join(
    homeRoot,
    "sessions",
    "journal",
    timestamp.toISOString().slice(0, 10)
  );
  await mkdir(targetDir, { recursive: true });
  await cp(fixturePath, path.join(targetDir, "000001.jsonl"));
}

async function readSessionJournal(
  sessionsDir: string
): Promise<SessionJournalRecord[]> {
  const journalDir = path.join(sessionsDir, "journal");
  const files = await collectJsonlFiles(journalDir);
  const records: SessionJournalRecord[] = [];
  for (const filePath of files) {
    const raw = await readFile(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      if (line.trim()) {
        records.push(SessionJournalRecordSchema.parse(JSON.parse(line)));
      }
    }
  }
  return records;
}

async function collectJsonlFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJsonlFiles(absolutePath)));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(absolutePath);
    }
  }
  return files.sort();
}

async function snapshotHome(homeRoot: string): Promise<HomeSnapshot> {
  const files = await collectHomeFiles(homeRoot, homeRoot);
  return {
    capturedAt: new Date().toISOString(),
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
}

async function collectHomeFiles(
  root: string,
  directory: string
): Promise<HomeFileSnapshot[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: HomeFileSnapshot[] = [];
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = normalizeRelativePath(
      path.relative(root, absolutePath)
    );
    if (isSecretPath(relativePath)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...(await collectHomeFiles(root, absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const content = await readFile(absolutePath);
    const fileStat = await stat(absolutePath);
    const snapshot: HomeFileSnapshot = {
      path: relativePath,
      bytes: fileStat.size,
      sha256: createHash("sha256").update(content).digest("hex")
    };
    const text = captureTextContent(relativePath, content);
    if (text !== undefined) {
      snapshot.content = text;
    }
    files.push(snapshot);
  }

  return files;
}

async function writeArtifacts(input: {
  artifactDir: string;
  fixture: ScenarioFixture;
  session: SessionDiagnostics;
  sessionJournal: SessionJournalRecord[];
  turnTraces: AgentTurnTrace[];
  rollouts: RolloutDetail[];
  reconstructedInputs: ReconstructedInput[];
  modelRequests: ModelRequestSnapshot[];
  modelExchanges: ModelExchangeSnapshot[];
  turnResults: AgentTurnResult[];
  homeBefore: HomeSnapshot;
  homeAfter: HomeSnapshot;
  mockTools: MockToolKit;
  connector: MockConnector;
}): Promise<ReplayRunResult["artifactPaths"]> {
  await rm(input.artifactDir, { recursive: true, force: true });
  await mkdir(input.artifactDir, { recursive: true });

  const artifactPaths = {
    session: path.join(input.artifactDir, "session.json"),
    sessionJournal: path.join(input.artifactDir, "session-journal.json"),
    turnTraces: path.join(input.artifactDir, "turn-traces.json"),
    rollouts: path.join(input.artifactDir, "rollouts.json"),
    reconstructedInputs: path.join(
      input.artifactDir,
      "reconstructed-inputs.json"
    ),
    modelRequests: path.join(input.artifactDir, "model-requests.json"),
    modelExchanges: path.join(input.artifactDir, "model-exchanges.json"),
    homeBefore: path.join(input.artifactDir, "home-before.json"),
    homeAfter: path.join(input.artifactDir, "home-after.json"),
    summary: path.join(input.artifactDir, "summary.json"),
    report: path.join(input.artifactDir, "report.md")
  };

  const summary = {
    id: input.fixture.id,
    description: input.fixture.description,
    modelKind: input.fixture.model.kind,
    conversations: input.session.conversations.length,
    sessionJournalRecords: input.sessionJournal.length,
    turnTraces: input.turnTraces.length,
    rollouts: input.rollouts.length,
    reconstructedInputs: input.reconstructedInputs.length,
    modelRequests: input.modelRequests.length,
    modelExchanges: input.modelExchanges.length,
    modelResponses: input.modelExchanges.filter((exchange) => exchange.response)
      .length,
    modelSessionIds: Array.from(
      new Set(
        input.modelRequests
          .map((request) => request.sessionId)
          .filter((value): value is string => Boolean(value))
      )
    ),
    cacheHitResponses: input.modelExchanges.filter(
      (exchange) => (exchange.response?.cacheUsage?.readTokens ?? 0) > 0
    ).length,
    cacheReadTokens: input.modelExchanges.reduce(
      (total, exchange) =>
        total + (exchange.response?.cacheUsage?.readTokens ?? 0),
      0
    ),
    promptContentHashes: Array.from(
      new Set(
        input.modelRequests
          .map((request) => request.prompt?.contentHash)
          .filter((value): value is string => Boolean(value))
      )
    ),
    toolPromptHashes: Array.from(
      new Set(
        input.modelRequests
          .map((request) => request.prompt?.toolPromptHash)
          .filter((value): value is string => Boolean(value))
      )
    ),
    turnResults: input.turnResults.length,
    toolCalls: input.mockTools.calls.map((call) => call.toolName),
    connectorSideEffects: input.connector.sentGroupMessages.length,
    homeFilesBefore: input.homeBefore.files.length,
    homeFilesAfter: input.homeAfter.files.length
  };

  await Promise.all([
    writeArtifactJson(artifactPaths.session, input.session),
    writeArtifactJson(artifactPaths.sessionJournal, input.sessionJournal),
    writeArtifactJson(artifactPaths.turnTraces, input.turnTraces),
    writeArtifactJson(artifactPaths.rollouts, input.rollouts),
    writeArtifactJson(artifactPaths.reconstructedInputs, input.reconstructedInputs),
    writeArtifactJson(artifactPaths.modelRequests, input.modelRequests),
    writeArtifactJson(artifactPaths.modelExchanges, input.modelExchanges),
    writeArtifactJson(artifactPaths.homeBefore, input.homeBefore),
    writeArtifactJson(artifactPaths.homeAfter, input.homeAfter),
    writeArtifactJson(artifactPaths.summary, summary),
    writeFile(artifactPaths.report, renderReport(input, summary), "utf8")
  ]);

  return artifactPaths;
}

function renderReport(
  input: {
    fixture: ScenarioFixture;
    session: SessionDiagnostics;
    sessionJournal: SessionJournalRecord[];
    turnTraces: AgentTurnTrace[];
    rollouts: RolloutDetail[];
    reconstructedInputs: ReconstructedInput[];
    modelRequests: ModelRequestSnapshot[];
    modelExchanges: ModelExchangeSnapshot[];
    turnResults: AgentTurnResult[];
    homeBefore: HomeSnapshot;
    homeAfter: HomeSnapshot;
    mockTools: MockToolKit;
    connector: MockConnector;
  },
  summary: Record<string, unknown>
): string {
  const conversation = input.session.conversations[0];
  const turn = conversation?.turns[0];
  const homeChanges = describeHomeChanges(input.homeBefore, input.homeAfter);

  return [
    `# Replay Report: ${input.fixture.id}`,
    "",
    input.fixture.description,
    "",
    "## Summary",
    "",
    `- Model: ${input.fixture.model.kind}`,
    `- Conversations: ${summary.conversations}`,
    `- Session journal records: ${input.sessionJournal.length}`,
    `- Events: ${conversation?.events.length ?? 0}`,
    `- Trigger attempts: ${conversation?.triggerAttempts.length ?? 0}`,
    `- Windows: ${conversation?.windows.length ?? 0}`,
    `- Turns: ${conversation?.turns.length ?? 0}`,
    `- Rollouts: ${input.rollouts.length}`,
    `- Reconstructed model inputs: ${input.reconstructedInputs.length}`,
    `- Model requests: ${input.modelRequests.length}`,
    `- Model exchanges: ${input.modelExchanges.length}`,
    `- Model responses: ${
      input.modelExchanges.filter((exchange) => exchange.response).length
    }`,
    `- Model sessions: ${
      (summary.modelSessionIds as string[]).join(", ") || "none"
    }`,
    `- Prompt-cache hit responses: ${summary.cacheHitResponses}`,
    `- Prompt-cache read tokens: ${summary.cacheReadTokens}`,
    `- Tool calls: ${
      input.mockTools.calls.map((call) => call.toolName).join(", ") || "none"
    }`,
    `- Connector side effects: ${input.connector.sentGroupMessages.length}`,
    "",
    "## First Turn",
    "",
    `- Status: ${turn?.status ?? "none"}`,
    `- Event IDs: ${turn?.eventIds.join(", ") || "none"}`,
    `- Steer count: ${turn?.steerCount ?? 0}`,
    `- Actions: ${
      turn?.proposedActions.map((action) => action.toolName).join(", ") ??
      "none"
    }`,
    "",
    "## GestaltHome",
    "",
    `- Files before: ${input.homeBefore.files.length}`,
    `- Files after: ${input.homeAfter.files.length}`,
    `- Added files: ${homeChanges.added.join(", ") || "none"}`,
    `- Removed files: ${homeChanges.removed.join(", ") || "none"}`,
    `- Changed files: ${homeChanges.changed.join(", ") || "none"}`,
    ""
  ].join("\n");
}

function describeHomeChanges(before: HomeSnapshot, after: HomeSnapshot): {
  added: string[];
  removed: string[];
  changed: string[];
} {
  const beforeByPath = new Map(before.files.map((file) => [file.path, file]));
  const afterByPath = new Map(after.files.map((file) => [file.path, file]));
  const added = after.files
    .filter((file) => !beforeByPath.has(file.path))
    .map((file) => file.path);
  const removed = before.files
    .filter((file) => !afterByPath.has(file.path))
    .map((file) => file.path);
  const changed = after.files
    .filter((file) => {
      const beforeFile = beforeByPath.get(file.path);
      return beforeFile !== undefined && beforeFile.sha256 !== file.sha256;
    })
    .map((file) => file.path);

  return { added, removed, changed };
}

function captureTextContent(
  relativePath: string,
  content: Buffer
): string | undefined {
  if (content.length > 64 * 1024 || !isTextSnapshotPath(relativePath)) {
    return undefined;
  }

  return content.toString("utf8");
}

function isTextSnapshotPath(relativePath: string): boolean {
  const extension = path.extname(relativePath).toLowerCase();
  return [".json", ".jsonl", ".md", ".txt", ".toml"].includes(extension);
}

function isSecretPath(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return (
    normalized === ".env" ||
    normalized.startsWith(".env.") ||
    normalized.includes("secret")
  );
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

function dedupeTurnResults(
  results: Array<AgentTurnResult | undefined>
): AgentTurnResult[] {
  const byTraceId = new Map<string, AgentTurnResult>();
  for (const result of results) {
    if (!result) {
      continue;
    }
    byTraceId.set(result.traceId, result);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
