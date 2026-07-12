import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMockConnector } from "../connectors/mock/connector";
import { createMockModel } from "../model/session";
import { resolveSessionJournalFile } from "../session/recorder";
import { SessionJournalRecordSchema } from "../session/schemas";
import type { StickerService } from "../stickers/service";
import type { GroupTrigger } from "../triggers/types";
import { createRuntime } from "./createRuntime";

const CONVERSATION_COUNT = 65;
const NOW = new Date("2026-07-13T03:00:00.000Z");
const temporaryHome = await mkdtemp(
  path.join(os.tmpdir(), "gestalt-runtime-session-pin-")
);

try {
  await writeFile(
    path.join(temporaryHome, "config.toml"),
    "agent_loop_exit_idle_ms = 1\n",
    "utf8"
  );
  const connector = createMockConnector({ now: () => NOW });
  const observationBarrier = createObservationBarrier(CONVERSATION_COUNT);
  const trigger: GroupTrigger = {
    name: "verify-concurrent-session-pin",
    evaluate({ record }) {
      return {
        triggerName: "verify-concurrent-session-pin",
        reason: "mention",
        conversation: record.event.conversation,
        eventIds: [record.event.id]
      };
    }
  };
  const runtime = await createRuntime({
    gestaltHome: temporaryHome,
    connector,
    stickerService: observationBarrier.service,
    triggers: [trigger],
    now: () => NOW
  });
  const events = Array.from({ length: CONVERSATION_COUNT }, (_, index) =>
    connector.createMessageEvent({
      conversationId: `concurrent-${index}`,
      messageId: `concurrent-message-${index}`,
      text: `gestalt concurrent ${index}`,
      mentionsBot: true
    })
  );

  const outcomes = await Promise.allSettled(
    events.map((event) => runtime.handleEvent(event))
  );
  const rejected = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected"
  );
  assert.deepEqual(
    rejected.map((outcome) => String(outcome.reason)),
    [],
    "concurrent handleEvent calls must retain each new event through window creation"
  );
  assert.equal(observationBarrier.observedCount(), CONVERSATION_COUNT);
  await runtime.whenIdle();

  const journalPath = resolveSessionJournalFile(
    runtime.home.sessionsDir,
    NOW.toISOString()
  );
  const journal = (await readFile(journalPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => SessionJournalRecordSchema.parse(JSON.parse(line)));
  const windowEventIds = journal.flatMap((record) =>
    record.type === "message_window" ? record.record.eventIds : []
  );
  assert.equal(windowEventIds.length, CONVERSATION_COUNT);
  assert.deepEqual(
    new Set(windowEventIds),
    new Set(events.map((event) => event.id))
  );
  assert.ok(
    runtime.sessionStore.listConversationStates().length <= 64,
    "completed loops must return to the bounded inactive working set"
  );
} finally {
  await rm(temporaryHome, { recursive: true, force: true });
}

await verifyDispatchReceiptDoesNotAwaitActiveLoop();

async function verifyDispatchReceiptDoesNotAwaitActiveLoop(): Promise<void> {
  const home = await mkdtemp(
    path.join(os.tmpdir(), "gestalt-runtime-dispatch-receipt-")
  );
  try {
    await writeFile(
      path.join(home, "config.toml"),
      "agent_loop_exit_idle_ms = 60000\n",
      "utf8"
    );
    const now = () => new Date("2026-07-13T04:00:00.000Z");
    const connector = createMockConnector({ now });
    const runtime = await createRuntime({
      gestaltHome: home,
      connector,
      model: createMockModel({ now, delayMs: 1_000 }),
      triggers: [
        {
          name: "verify-dispatch-receipt",
          evaluate({ record }) {
            return {
              triggerName: "verify-dispatch-receipt",
              reason: "mention",
              conversation: record.event.conversation,
              eventIds: [record.event.id]
            };
          }
        }
      ],
      now
    });
    const firstEvent = connector.createMessageEvent({
      conversationId: "dispatch-group",
      messageId: "dispatch-first",
      text: "gestalt wait here",
      mentionsBot: true
    });
    const firstDispatch = await runtime.dispatchEvent(firstEvent);
    let outcomeSettled = false;
    void firstDispatch.outcome.then(
      () => {
        outcomeSettled = true;
      },
      () => {
        outcomeSettled = true;
      }
    );
    await Promise.resolve();
    assert.equal(
      outcomeSettled,
      false,
      "dispatchEvent must return while the active model loop is still pending"
    );

    const leaveEvent = connector.createMessageEvent({
      conversationId: "dispatch-group",
      messageId: "dispatch-leave",
      text: "/leave",
      mentionsBot: false
    });
    const leaveDispatch = await runtime.dispatchEvent(leaveEvent);
    assert.equal(
      leaveDispatch.outcome,
      firstDispatch.outcome,
      "follow-up dispatches must expose the existing loop outcome without awaiting it"
    );
    await firstDispatch.outcome;
    await runtime.whenIdle();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function createObservationBarrier(expected: number): {
  service: StickerService;
  observedCount(): number;
} {
  let observed = 0;
  let release!: () => void;
  const allObserved = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    observedCount: () => observed,
    service: {
      configuredEnabled: false,
      isScrapingEnabled: () => false,
      async setScrapingOverride() {
        return false;
      },
      async toggleScraping() {
        return false;
      },
      async observe() {
        observed += 1;
        if (observed === expected) {
          release();
        }
        await allObserved;
        return 0;
      },
      async search() {
        return [];
      },
      async send() {
        throw new Error("The session-pin verifier does not send stickers.");
      },
      async snapshot() {
        throw new Error("The session-pin verifier does not read stickers.");
      },
      async resolveAssetPath() {
        return undefined;
      },
      async whenIdle() {}
    }
  };
}
