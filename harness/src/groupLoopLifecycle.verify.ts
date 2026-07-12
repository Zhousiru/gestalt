import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMockConnector,
  createMockToolKit,
  createRuntime,
  type CompiledContext,
  type ModelClient,
  type ModelSession
} from "@gestalt/app";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePaths = [
  "harness/fixtures/scenarios/group-exit-idle-timeout.json",
  "harness/fixtures/scenarios/group-exit-say-nothing.json",
  "harness/fixtures/scenarios/group-exit-leave-tool.json",
  "harness/fixtures/scenarios/group-exit-slash-leave.json"
];

const results = [];

for (const fixturePath of fixturePaths) {
  console.log(`running ${fixturePath}`);
  const result = await runScenarioFixture(fixturePath);
  assertReplayRun(result);
  results.push(result);
}

await assertActiveLoopModelSessionIsReused();

console.log(
  JSON.stringify(
    {
      ok: true,
      scenarios: results.map((result) => {
        const conversation = result.session.conversations[0];
        return {
          id: result.fixture.id,
          events: conversation?.events.length ?? 0,
          windows:
            conversation?.windows.map((window) => ({
              reason: window.reason,
              eventIds: window.eventIds
            })) ?? [],
          turns: conversation?.turns.length ?? 0,
          loopExits:
            conversation?.loopExits.map((exit) => ({
              reason: exit.reason,
              turnIds: exit.turnIds
            })) ?? [],
          toolCalls: result.mockTools.calls.map((call) => call.toolName),
          artifacts: result.artifactPaths
        };
      })
    },
    null,
    2
  )
);

async function assertActiveLoopModelSessionIsReused(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-self-history-"));
  await cp(
    path.join(repoRoot, "harness/fixtures/homes/simple-group-test"),
    tempHome,
    { recursive: true }
  );
  await appendFile(
    path.join(tempHome, "config.toml"),
    "\ncontext_recent_message_count = 4\n",
    "utf8"
  );

  try {
    const connector = createMockConnector();
    const mockTools = createMockToolKit();
    const transcripts: string[] = [];
    let modelCalls = 0;
    let sessionCreations = 0;

    const model = {
      name: "capture-active-loop-self-history",
      createSession() {
        sessionCreations += 1;
        let initialized = false;
        let running = false;
        const session: ModelSession = {
          get initialized() {
            return initialized;
          },
          get running() {
            return running;
          },
          async run(context: CompiledContext) {
            initialized = true;
            running = true;
            transcripts.push(context.transcript);
            modelCalls += 1;
            const proposedAt = new Date().toISOString();
            running = false;

            if (modelCalls === 1 && context.event.type === "MessageReceived") {
              return {
                proposedActions: [
                  {
                    id: randomUUID(),
                    proposedAt,
                    toolName: "send_group_message" as const,
                    reason: "Seed a visible self message for the next active-loop turn.",
                    params: {
                      groupId: context.event.conversation.id,
                      text: "干嘛 有屁快放"
                    }
                  }
                ]
              };
            }

            return {
              proposedActions: [
                {
                  id: randomUUID(),
                  proposedAt,
                  toolName: "say_nothing" as const,
                  reason: "Captured the follow-up context for assertion.",
                  params: {}
                }
              ]
            };
          },
          steer() {
            return false;
          }
        };
        return session;
      }
    } satisfies ModelClient;

    const runtime = await createRuntime({
      gestaltHome: tempHome,
      connector,
      model,
      toolImplementations: mockTools.implementations
    });

    const firstEvent = connector.createMessageEvent({
      conversationId: "mock-group",
      conversationName: "Mock Group",
      messageId: "self-history-first",
      senderId: "alice",
      senderName: "Alice",
      text: "小格，在吗",
      mentionsBot: true
    });
    const firstTurn = runtime.handleEvent(firstEvent);

    await delay(40);

    const secondEvent = connector.createMessageEvent({
      conversationId: "mock-group",
      conversationName: "Mock Group",
      messageId: "self-history-follow-up",
      senderId: "alice",
      senderName: "Alice",
      text: "那么烦躁干嘛",
      mentionsBot: false
    });
    const secondTurn = runtime.handleEvent(secondEvent);

    await Promise.allSettled([firstTurn, secondTurn]);
    await runtime.whenIdle();

    const followUpTranscript = transcripts.find((transcript) =>
      transcript.includes("那么烦躁干嘛")
    );
    assert.ok(
      followUpTranscript,
      "expected to capture the active-loop follow-up transcript"
    );
    assert.equal(sessionCreations, 1, "expected one model session per active loop");
    assert.equal(modelCalls, 2, "expected both turns to reuse that session");
    assert.doesNotMatch(
      followUpTranscript,
      /干嘛 有屁快放/,
      "incremental windows should not rebuild prior output into a new prompt"
    );
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
