import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAiSdkInspectRunner,
  createInspectBashTool,
  createMockConnector,
  createMockModel,
  createNoopDreamingRunner,
  createRuntime,
  resolveGestaltHome,
  type GestaltConfig,
  type InspectRunInput,
  type InspectRunner,
  type MessageReceivedEvent,
  type SessionEventRecord,
  type SessionDiagnostics
} from "@gestalt/app";

const fixedNow = new Date("2026-07-08T05:00:00.000Z");
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-inspect-"));

const inspectedInputs: InspectRunInput[] = [];
const inspectedStdout: string[] = [];
const inspectedCommands: string[] = [];

const inspectRunner: InspectRunner = {
  async run(input) {
    inspectedInputs.push(input);
    const bash = createInspectBashTool(input.home);
    const command = [
      "ls /sessions",
      "ls /traces",
      "cat /sessions/journal/2026-07-08/000001.jsonl",
      "cat /traces/2026/07/08/rollout-inspect-fixture.jsonl"
    ].join("; ");
    const bashResult = await bash.exec(command);
    inspectedStdout.push(bashResult.stdout);
    inspectedCommands.push(...bash.commands.map((result) => result.command));

    const reportText = [
      `inspect ok: ${input.command.query}`,
      `conversation=${input.eventRecord.event.conversation.kind}:${input.eventRecord.event.conversation.id}`,
      `event_id=${input.eventRecord.event.id}`
    ].join(" ");

    return {
      id: "mock-inspect-run",
      status: "completed",
      startedAt: input.now().toISOString(),
      endedAt: input.now().toISOString(),
      commands: bash.commands,
      reportText
    };
  }
};

try {
  const connector = createMockConnector({ now: () => fixedNow });
  const runtime = await createRuntime({
    gestaltHome: tempHome,
    connector,
    model: createMockModel({ now: () => fixedNow }),
    dreamingRunner: createNoopDreamingRunner(),
    inspectRunner,
    now: () => fixedNow
  });

  const traceDayDir = path.join(runtime.home.tracesDir, "2026", "07", "08");
  await mkdir(traceDayDir, { recursive: true });
  await writeFile(
    path.join(traceDayDir, "rollout-inspect-fixture.jsonl"),
    [
      {
        id: "rollout-start",
        rolloutId: "inspect-fixture",
        timestamp: fixedNow.toISOString(),
        type: "rollout_started",
        activeLoopId: "inspect-fixture",
        eventId: "prior-event"
      },
      {
        id: "span-model",
        rolloutId: "inspect-fixture",
        timestamp: fixedNow.toISOString(),
        type: "span_completed",
        spanId: "span-model",
        name: "model.decide",
        startedAt: fixedNow.toISOString(),
        endedAt: fixedNow.toISOString(),
        attributes: {
          status: "ok",
          explanationFixture: "prior action evidence"
        }
      }
    ].map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8"
  );

  const inspectEvent = connector.createMessageEvent({
    conversationId: "inspect-group",
    senderId: "dev-user",
    messageId: "inspect-message-1",
    text: "/inspect 为什么刚才会发那句话",
    mentionsBot: false
  });

  const turnResult = await runtime.handleEvent(inspectEvent);
  await runtime.whenIdle();

  assert.equal(turnResult, undefined);
  assert.equal(inspectedInputs.length, 1);
  const inspectedInput = inspectedInputs[0];
  assert.ok(inspectedInput, "expected inspect runner input");
  assert.equal(inspectedInput.command.query, "为什么刚才会发那句话");
  assert.equal(inspectedInput.eventRecord.event.id, inspectEvent.id);
  assert.equal(inspectedInput.eventRecord.event.message.id, "inspect-message-1");

  assert.equal(connector.sentGroupMessages.length, 1);
  assert.match(
    connector.sentGroupMessages[0]?.input.text ?? "",
    /inspect ok: 为什么刚才会发那句话/
  );

  const session = runtime.exportDiagnostics({
    exportedAt: fixedNow.toISOString()
  });
  const conversation = session.conversations[0];
  assert.ok(conversation, "expected inspect conversation session");
  assert.equal(conversation.events.length, 2);
  assert.equal(conversation.windows.length, 0);
  assert.equal(conversation.turns.length, 0);
  assert.equal(conversation.loopExits.length, 0);
  assert.equal(conversation.events[1]?.event.sender.isSelf, true);
  assert.equal(
    readStringProperty(conversation.events[1]?.event.raw, "generatedBy"),
    "inspect"
  );
  assert.equal(
    readStringProperty(conversation.events[1]?.event.raw, "requestEventId"),
    inspectEvent.id
  );
  assert.equal(
    readStringProperty(conversation.events[1]?.event.raw, "requestMessageId"),
    "inspect-message-1"
  );

  const stdout = inspectedStdout.join("\n");
  assert.match(stdout, /inspect-message-1/);
  assert.match(stdout, /rolloutId":"inspect-fixture/);
  assert.match(stdout, /prior action evidence/);
  assert.ok(
    inspectedCommands.some((command) =>
      command.includes("/sessions/journal/2026-07-08/000001.jsonl")
    )
  );
  assert.ok(
    inspectedCommands.some((command) =>
      command.includes("/traces/2026/07/08/rollout-inspect-fixture.jsonl")
    )
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        inspectCalls: inspectedInputs.length,
        connectorMessages: connector.sentGroupMessages.length,
        events: conversation.events.length,
        windows: conversation.windows.length,
        turns: conversation.turns.length
      },
      null,
      2
    )
  );

  await verifyAiSdkInspectUsesReportToolAfterBash();
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

function readStringProperty(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

async function verifyAiSdkInspectUsesReportToolAfterBash(): Promise<void> {
  const aiHomeRoot = await mkdtemp(path.join(os.tmpdir(), "gestalt-inspect-ai-"));
  const previousApiKey = process.env.GESTALT_FAKE_INSPECT_API_KEY;
  process.env.GESTALT_FAKE_INSPECT_API_KEY = "test-key";

  try {
    const home = await resolveGestaltHome({ homePath: aiHomeRoot });
    const sessionDayDir = path.join(
      home.sessionsDir,
      "journal",
      "2026-07-08"
    );
    const traceDayDir = path.join(home.tracesDir, "2026", "07", "08");
    await mkdir(sessionDayDir, { recursive: true });
    await mkdir(traceDayDir, { recursive: true });
    await writeFile(
      path.join(sessionDayDir, "000001.jsonl"),
      `${JSON.stringify({
        type: "event",
        recordedAt: fixedNow.toISOString(),
        record: {
          id: "prior-memory-write-event",
          receivedAt: fixedNow.toISOString(),
          event: {
            id: "prior-memory-write-event",
            type: "MessageReceived",
            occurredAt: fixedNow.toISOString(),
            source: {
              platform: "mock",
              connector: "mock",
              accountId: "gestalt-bot"
            },
            conversation: { kind: "group", id: "inspect-group" },
            sender: { id: "alice", displayName: "Alice" },
            message: {
              id: "prior-message",
              text: "请记住这条测试记忆",
              rawText: "请记住这条测试记忆",
              mentionsBot: true
            }
          }
        }
      })}\n`,
      "utf8"
    );
    await writeFile(
      path.join(traceDayDir, "rollout-memory-write.jsonl"),
      `${JSON.stringify({
        id: "span-dreaming",
        rolloutId: "trace-memory-write",
        timestamp: fixedNow.toISOString(),
        type: "span_completed",
        spanId: "span-dreaming",
        name: "memory.dreaming",
        startedAt: fixedNow.toISOString(),
        endedAt: fixedNow.toISOString(),
        attributes: {
          changedFiles: ["users/alice/index.md"],
          reason: "explicit remember request"
        }
      })}\n`,
      "utf8"
    );

    const fetchBodies: unknown[] = [];
    const fakeFetch: typeof fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      fetchBodies.push(body);
      assert.match(JSON.stringify(body), /tool_choice/);
      if (fetchBodies.length === 2) {
        assert.match(JSON.stringify(body), /send_inspect_report/);
      }

      return jsonResponse(
        fetchBodies.length === 1
          ? openAiChatCompletion({
              content: null,
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call_bash_1",
                  name: "bash",
                  arguments: {
                    command:
                      "cat /sessions/journal/2026-07-08/000001.jsonl; cat /traces/2026/07/08/rollout-memory-write.jsonl"
                  }
                }
              ]
            })
          : openAiChatCompletion({
              content: null,
              finishReason: "tool_calls",
              toolCalls: [
                {
                  id: "call_report_1",
                  name: "send_inspect_report",
                  arguments: {
                    report:
                      "最终诊断：inspect 通过 send_inspect_report 提交报告。证据显示 trace-memory-write 记录了 memory.dreaming，原因是 explicit remember request，变更文件是 users/alice/index.md。"
                  }
                }
              ]
            })
      );
    };

    const config: GestaltConfig = {
      path: path.join(home.root, "config.toml"),
      raw: "",
      flatValues: {
        main_model_provider: "fake-openai-compatible",
        main_model_base_url: "https://fake.invalid/v1",
        main_model_name: "fake-inspect-model",
        main_model_api_key_env: "GESTALT_FAKE_INSPECT_API_KEY",
        main_model_tool_choice: "auto"
      }
    };
    const runner = createAiSdkInspectRunner(config, {
      apiKeyEnvOverride: "GESTALT_FAKE_INSPECT_API_KEY",
      fetch: fakeFetch,
      maxModelTurns: 2
    });
    const event: MessageReceivedEvent = {
      id: "inspect-event-tool-only",
      type: "MessageReceived",
      occurredAt: fixedNow.toISOString(),
      source: {
        platform: "mock",
        connector: "mock",
        accountId: "gestalt-bot"
      },
      conversation: { kind: "group", id: "inspect-group" },
      sender: { id: "dev-user", displayName: "Dev User" },
      message: {
        id: "inspect-message-tool-only",
        text: "/inspect 上一次memory write原因",
        rawText: "/inspect 上一次memory write原因",
        mentionsBot: true
      }
    };
    const eventRecord: SessionEventRecord = {
      id: "inspect-event-tool-only",
      receivedAt: fixedNow.toISOString(),
      event
    };
    const sessionDiagnostics: SessionDiagnostics = {
      exportedAt: fixedNow.toISOString(),
      conversations: [
        {
          conversation: event.conversation,
          events: [eventRecord],
          triggerAttempts: [],
          windows: [],
          turns: [],
          loopExits: []
        }
      ]
    };

    const result = await runner.run({
      home,
      config,
      eventRecord,
      command: { query: "上一次memory write原因" },
      sessionDiagnostics,
      now: () => fixedNow
    });

    assert.equal(result.status, "completed");
    assert.equal(result.commands.length, 1);
    assert.equal(fetchBodies.length, 2);
    assert.match(result.reportText ?? "", /最终诊断/);
    assert.match(result.reportText ?? "", /trace-memory-write/);
    assert.doesNotMatch(result.reportText ?? "", /没有调用 send_inspect_report/);

    console.log(
      JSON.stringify(
        {
          ok: true,
          aiInspectFetches: fetchBodies.length,
          aiInspectCommands: result.commands.length,
          reportTool: true
        },
        null,
        2
      )
    );
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.GESTALT_FAKE_INSPECT_API_KEY;
    } else {
      process.env.GESTALT_FAKE_INSPECT_API_KEY = previousApiKey;
    }
    await rm(aiHomeRoot, { recursive: true, force: true });
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function openAiChatCompletion({
  content,
  finishReason,
  toolCalls = []
}: {
  content: string | null;
  finishReason: string;
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
}): unknown {
  return {
    id: `chatcmpl-${finishReason}`,
    object: "chat.completion",
    created: 1783486800,
    model: "fake-inspect-model",
    choices: [
      {
        index: 0,
        finish_reason: finishReason,
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length > 0
            ? {
                tool_calls: toolCalls.map((call, index) => ({
                  type: "function",
                  index,
                  id: call.id,
                  function: {
                    name: call.name,
                    arguments: JSON.stringify(call.arguments)
                  }
                }))
              }
            : {})
        }
      }
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 10,
      total_tokens: 20
    }
  };
}
