import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockMessageEvent } from "../connectors/mock/connector";
import type { GestaltConfig } from "../home/loadConfig";
import { resolveGestaltHome } from "../home/resolveGestaltHome";
import {
  createRecentSessionEventAppender,
  createSessionHistoryReader
} from "../session/history";
import {
  createSessionRecorder,
  resolveSessionJournalFile
} from "../session/recorder";
import { createInMemorySessionStore } from "../session/store";
import type { ToolExecutionResult } from "../tools/executeActions";
import type { ActionProposal } from "../tools/schemas";
import { commitOutboundMessage } from "./outboundMessages";

const root = await mkdtemp(path.join(os.tmpdir(), "gestalt-outbound-messages-"));
try {
  const home = await resolveGestaltHome({ homePath: root });
  const config: GestaltConfig = {
    path: home.configPath,
    raw: "",
    flatValues: {
      bot_user_id: "bot-self",
      bot_display_name: "Gestalt Bot",
      session_recent_history_hours: 24
    }
  };
  const now = new Date("2026-07-13T08:00:00.000Z");
  const recorder = createSessionRecorder(home);
  const store = createInMemorySessionStore({
    now: () => now,
    onJournalRecord: (record) => recorder.enqueue(record)
  });
  const reader = createSessionHistoryReader(home);
  const appender = createRecentSessionEventAppender({
    config,
    store,
    reader,
    now: () => now
  });
  const sourceEvent = createMockMessageEvent({
    conversationId: "source-group",
    conversationName: "Source Group",
    senderId: "alice",
    messageId: "source-message",
    occurredAt: now.toISOString()
  });

  const cases: Array<{
    proposal: ActionProposal;
    expectedConversation: { kind: "group" | "private"; id: string };
    expectedText: string;
    expectedRaw?: Record<string, unknown>;
    resultData?: unknown;
  }> = [
    {
      proposal: proposal("send_group_message", {
        groupId: "target-group",
        text: "[CQ:reply,id=prior]group reply"
      }),
      expectedConversation: { kind: "group", id: "target-group" },
      expectedText: "[CQ:reply,id=prior]group reply"
    },
    {
      proposal: proposal("send_dm", {
        userId: "target-user",
        text: "private reply"
      }),
      expectedConversation: { kind: "private", id: "target-user" },
      expectedText: "private reply"
    },
    {
      proposal: proposal("send_image", {
        conversation: { kind: "group", id: "image-group" },
        file: "base64://AQIDBA==",
        caption: "diagram",
        summary: "architecture sketch",
        replyToMessageId: "image-parent"
      }),
      expectedConversation: { kind: "group", id: "image-group" },
      expectedText: "diagram\n[图片：architecture sketch]"
    },
    {
      proposal: proposal("send_sticker", {
        conversation: { kind: "private", id: "sticker-user" },
        stickerId: "sticker-1",
        replyToMessageId: "sticker-parent"
      }),
      expectedConversation: { kind: "private", id: "sticker-user" },
      expectedText: "[表情包 sticker-1：celebration]",
      expectedRaw: {
        generatedBy: "send_sticker",
        stickerId: "sticker-1"
      },
      resultData: { stickerId: "sticker-1", visual: "celebration" }
    }
  ];

  for (const [index, fixture] of cases.entries()) {
    const result: ToolExecutionResult = {
      proposal: fixture.proposal,
      status: "executed",
      executedAt: new Date(now.valueOf() + index).toISOString(),
      result: {
        ok: true,
        externalId: `external-${index}`,
        ...(fixture.resultData !== undefined ? { data: fixture.resultData } : {})
      }
    };
    const record = await commitOutboundMessage({
      config,
      sourceEvent,
      proposal: fixture.proposal,
      result,
      appendEvent: (event, options) => appender.appendEvent(event, options),
      flushDurable: () => recorder.flush({ durable: true })
    });
    assert.ok(record);
    assert.deepEqual(record.event.conversation, fixture.expectedConversation);
    assert.equal(record.event.message.text, fixture.expectedText);
    assert.equal(record.event.sender.isSelf, true);
    assert.equal(record.event.message.id, `external-${index}`);
    assert.deepEqual(record.event.raw, fixture.expectedRaw);
  }

  for (const fixture of cases) {
    const messages = await reader.recentMessages(
      fixture.expectedConversation,
      new Date(now.valueOf() - 60_000),
      10
    );
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.event.message.text, fixture.expectedText);
  }

  const raw = await readFile(
    resolveSessionJournalFile(home.sessionsDir, now.toISOString()),
    "utf8"
  );
  assert.equal(raw.includes("base64://AQIDBA=="), false);
  assert.equal(raw.includes('"file"'), false);
  assert.equal(recorder.getStats().bufferedBytes, 0);
} finally {
  await rm(root, { recursive: true, force: true });
}

function proposal<Name extends ActionProposal["toolName"]>(
  toolName: Name,
  params: Extract<ActionProposal, { toolName: Name }>["params"]
): Extract<ActionProposal, { toolName: Name }> {
  return {
    id: `proposal-${toolName}`,
    proposedAt: "2026-07-13T08:00:00.000Z",
    toolName,
    params
  } as Extract<ActionProposal, { toolName: Name }>;
}
