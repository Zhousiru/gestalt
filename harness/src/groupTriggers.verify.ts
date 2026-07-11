import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createMockConnector,
  createRuntime,
  type ModelClient,
  type ModelSession
} from "@gestalt/app";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

const fixturePaths = [
  "harness/fixtures/scenarios/group-trigger-keyword.json",
  "harness/fixtures/scenarios/group-trigger-activity.json",
  "harness/fixtures/scenarios/group-trigger-icebreaker.json",
  "harness/fixtures/scenarios/group-active-loop-aggregation.json"
];

const results = [];

for (const fixturePath of fixturePaths) {
  const result = await runScenarioFixture(fixturePath);
  assertReplayRun(result);
  results.push(result);
}

const allowedGroups = await verifyAllowedGroups();

console.log(
  JSON.stringify(
    {
      ok: true,
      allowedGroups,
      scenarios: results.map((result) => {
        const conversation = result.session.conversations[0];
        return {
          id: result.fixture.id,
          events: conversation?.events.length ?? 0,
          windows: conversation?.windows.map((window) => ({
            reason: window.reason,
            eventSeqs: window.eventSeqs
          })) ?? [],
          turns: conversation?.turns.length ?? 0,
          modelRequests: result.modelRequests.length,
          artifacts: result.artifactPaths
        };
      })
    },
    null,
    2
  )
);

async function verifyAllowedGroups(): Promise<{
  blockedConversations: number;
  allowedConversationId: string;
  allowedEvents: number;
  visibleTools: string[];
}> {
  const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-allowed-"));
  try {
    await writeFile(
      path.join(tempHome, "config.toml"),
      [
        'allowedgroups = ["allowed-group"]',
        "trigger_activity_enabled = false",
        "trigger_icebreaker_enabled = false",
        "agent_loop_exit_idle_ms = 1"
      ].join("\n"),
      "utf8"
    );

    const connector = createMockConnector();
    let visibleTools: string[] = [];
    const model = {
      name: "capture-tools",
      createSession() {
        let initialized = false;
        let running = false;
        return {
          get initialized() {
            return initialized;
          },
          get running() {
            return running;
          },
          async run(context) {
            initialized = true;
            running = true;
            visibleTools = context.tools.map((tool) => tool.name);
            running = false;
            return {
              proposedActions: [
                {
                  id: "allowed-groups-capture-action",
                  proposedAt: new Date().toISOString(),
                  toolName: "send_group_message" as const,
                  reason: "Capture the configured visible tools.",
                  params: {
                    groupId: "allowed-group",
                    text: "[CQ:reply,id=allowed-message]在"
                  }
                }
              ]
            };
          },
          steer() {
            return false;
          }
        } satisfies ModelSession;
      }
    } satisfies ModelClient;
    const runtime = await createRuntime({
      gestaltHome: tempHome,
      connector,
      model
    });

    const blockedResult = await runtime.handleEvent(
      connector.createMessageEvent({
        conversationId: "blocked-group",
        text: "gestalt 在吗？",
        mentionsBot: true
      })
    );
    assert.equal(blockedResult, undefined);
    assert.equal(runtime.exportSession().conversations.length, 0);

    const allowedResult = await runtime.handleEvent(
      connector.createMessageEvent({
        conversationId: "allowed-group",
        messageId: "allowed-message",
        text: "gestalt 在吗？",
        mentionsBot: true
      })
    );
    assert.ok(allowedResult);
    await runtime.whenIdle();
    assert.ok(visibleTools.includes("leave"));

    const session = runtime.exportSession();
    const conversation = session.conversations[0];
    assert.ok(conversation);
    assert.equal(conversation.conversation.id, "allowed-group");
    assert.equal(conversation.events.length, 2);
    assert.equal(conversation.windows.length, 1);
    assert.equal(conversation.turns.length, 1);

    return {
      blockedConversations: 0,
      allowedConversationId: conversation.conversation.id,
      allowedEvents: conversation.events.length,
      visibleTools
    };
  } finally {
    await rm(tempHome, { recursive: true, force: true });
  }
}
