import assert from "node:assert/strict";
import path from "node:path";
import {
  appendFile,
  mkdtemp,
  readFile,
  rm,
  stat
} from "node:fs/promises";
import { tmpdir } from "node:os";
import type { CanonicalEvent, Conversation } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import { resolveGestaltHome } from "../home/resolveGestaltHome";
import { readSessionRecentHistoryHours } from "./config";
import {
  createRecentSessionEventAppender,
  createSessionHistoryReader,
  hydrateRecentSessionMessages
} from "./history";
import {
  createSessionRecorder,
  SESSION_JOURNAL_BUFFER_BYTES,
  resolveSessionJournalFile
} from "./recorder";
import type { SessionJournalRecord } from "./schemas";
import { createInMemorySessionStore } from "./store";

const NOW = new Date("2026-07-12T12:00:00.000Z");

async function main(): Promise<void> {
  await verifyBoundedStore();
  await verifyJournalAndHistory();
  await verifyInterleavedStartupHydration();
  await verifyOnDemandRehydrationAfterEviction();
  await verifyGlobalAdmissionOrderAcrossSlowRehydration();
  await verifyHighVolumeBounds();
  verifyConfig();
}

async function verifyInterleavedStartupHydration(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-session-interleaved-")
  );
  try {
    const home = await resolveGestaltHome({ homePath: temporaryDirectory });
    const recorder = createSessionRecorder(home);
    const repeated = conversation("repeated-at-tail");
    const seedRecords = [
      sessionEventRecord(
        repeated,
        "repeated-early",
        new Date(NOW.valueOf() - 2_000)
      ),
      ...Array.from({ length: 64 }, (_, index) =>
        sessionEventRecord(
          conversation(`interleaved-${index}`),
          `interleaved-${index}`,
          new Date(NOW.valueOf() - 1_000)
        )
      ),
      sessionEventRecord(repeated, "repeated-late", NOW)
    ];
    for (const record of seedRecords) {
      await recorder.enqueue({
        type: "event",
        recordedAt: record.receivedAt,
        record
      });
    }
    await recorder.flush({ durable: true });

    const store = createInMemorySessionStore({ now: () => NOW });
    const hydration = await hydrateRecentSessionMessages({
      home,
      config: emptyConfig(home.configPath),
      store,
      reader: createSessionHistoryReader(home),
      now: () => NOW
    });

    assert.equal(hydration.hydratedCount, 65);
    assert.equal(store.listConversationStates().length, 64);
    assert.equal(store.hasConversation(conversation("interleaved-0")), false);
    assert.deepEqual(
      store.getEvents(repeated).map((record) => record.event.message.id),
      ["repeated-early", "repeated-late"]
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyBoundedStore(): Promise<void> {
  let id = 0;
  const journal: SessionJournalRecord[] = [];
  const store = createInMemorySessionStore({
    now: () => NOW,
    createId: () => `record-${++id}`,
    limits: {
      eventsPerConversation: 3,
      lifecycleRecordsPerConversation: 2,
      inactiveConversations: 2
    },
    onJournalRecord: (record) => {
      journal.push(record);
    }
  });
  const pinned = conversation("pinned");
  store.pinConversation(pinned);
  for (let index = 1; index <= 5; index += 1) {
    await store.appendEvent(event(pinned, `pinned-${index}`));
  }
  const retained = store.getEvents(pinned);
  assert.deepEqual(
    retained.map((record) => record.event.id),
    ["event-pinned-3", "event-pinned-4", "event-pinned-5"]
  );

  const requestedOrder = ["event-pinned-5", "event-pinned-3"];
  const created = await store.createMessageWindow({
    conversation: pinned,
    eventIds: requestedOrder
  });
  assert.deepEqual(created.window.eventIds, requestedOrder);
  assert.deepEqual(
    created.eventRecords.map((record) => record.event.id),
    requestedOrder
  );

  const journalCountBeforeDuplicate = journal.length;
  const duplicate = await store.appendEvent(event(pinned, "pinned-5"), {
    recordId: "different-journal-record-id"
  });
  assert.equal(duplicate.event.id, "event-pinned-5");
  assert.notEqual(duplicate.id, "different-journal-record-id");
  assert.equal(journal.length, journalCountBeforeDuplicate);

  for (const key of ["inactive-1", "inactive-2", "inactive-3"]) {
    const target = conversation(key);
    await store.appendEvent(event(target, key));
  }
  assert.equal(store.listConversationStates().length, 3);
  assert.ok(store.getConversationState(pinned));
  assert.equal(store.getConversationState(conversation("inactive-1")), undefined);

  const canonicalIdStore = createInMemorySessionStore();
  const canonicalRecord = sessionEventRecord(
    conversation("canonical-id"),
    "same-event",
    NOW
  );
  assert.equal(canonicalIdStore.hydrateEvent(canonicalRecord), true);
  assert.equal(
    canonicalIdStore.hydrateEvent({
      ...canonicalRecord,
      id: "different-journal-row-id"
    }),
    false
  );
  assert.equal(canonicalIdStore.getEvents(conversation("canonical-id")).length, 1);

  const referenceCountedStore = createInMemorySessionStore({
    limits: { inactiveConversations: 1 }
  });
  const protectedConversation = conversation("reference-counted-pin");
  referenceCountedStore.pinConversation(protectedConversation);
  referenceCountedStore.pinConversation(protectedConversation);
  await referenceCountedStore.appendEvent(
    event(protectedConversation, "protected")
  );
  await referenceCountedStore.appendEvent(
    event(conversation("pin-other-1"), "pin-other-1")
  );
  referenceCountedStore.unpinConversation(protectedConversation);
  await referenceCountedStore.appendEvent(
    event(conversation("pin-other-2"), "pin-other-2")
  );
  assert.equal(referenceCountedStore.hasConversation(protectedConversation), true);
  referenceCountedStore.unpinConversation(protectedConversation);
  assert.equal(referenceCountedStore.hasConversation(protectedConversation), false);

  const diagnostics = store.exportDiagnostics({ exportedAt: NOW.toISOString() });
  assert.equal("version" in diagnostics, false);
  assert.equal(JSON.stringify(diagnostics).includes("nextSeq"), false);
  assert.equal(journal.length, 9);

  const privateStore = createInMemorySessionStore({ now: () => NOW });
  const unsafeEvent = event(conversation("binary"), "binary-message");
  unsafeEvent.raw = {
    bytes: Buffer.from([1, 2, 3, 4]),
    privatePath: "C:\\private\\image.png"
  };
  unsafeEvent.message.rawText =
    "[CQ:image,file=base64://AQIDBA==,path=C:\\private\\image.png]";
  const safeRecord = await privateStore.appendEvent(unsafeEvent);
  const retainedText = JSON.stringify(safeRecord);
  assert.equal(retainedText.includes('"raw"'), false);
  assert.equal(retainedText.includes('"type":"Buffer"'), false);
  assert.equal(retainedText.includes("base64://AQIDBA=="), false);
  assert.equal(retainedText.includes("availability=not_captured"), true);
  // The active loop may still use an authorized transient locator. It must be
  // removed from every diagnostic/persistent representation.
  assert.equal(
    safeRecord.event.message.rawText?.includes("C:\\private\\image.png"),
    true
  );
  assert.equal(
    JSON.stringify(privateStore.exportDiagnostics()).includes("private"),
    false
  );
}

async function verifyOnDemandRehydrationAfterEviction(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-session-rehydrate-")
  );
  try {
    const home = await resolveGestaltHome({ homePath: temporaryDirectory });
    const recorder = createSessionRecorder(home);
    const target = conversation("evicted-target");
    const seedRecords = [
      sessionEventRecord(
        target,
        "history-1",
        new Date(NOW.valueOf() - 2_000)
      ),
      sessionEventRecord(
        target,
        "history-2",
        new Date(NOW.valueOf() - 1_000)
      ),
      ...Array.from({ length: 64 }, (_, index) =>
        sessionEventRecord(
          conversation(`working-${index}`),
          `working-${index}`,
          NOW
        )
      )
    ];
    for (const record of seedRecords) {
      await recorder.enqueue({
        type: "event",
        recordedAt: record.receivedAt,
        record
      });
    }
    await recorder.flush({ durable: true });

    const config: GestaltConfig = {
      ...emptyConfig(home.configPath),
      flatValues: { session_recent_history_hours: 6 }
    };
    const store = createInMemorySessionStore({
      now: () => NOW,
      onJournalRecord: (record) => recorder.enqueue(record)
    });
    const reader = createSessionHistoryReader(home);
    await hydrateRecentSessionMessages({
      home,
      config,
      store,
      reader,
      now: () => NOW
    });
    assert.equal(store.hasConversation(target), false);
    assert.equal(store.listConversationStates().length, 64);

    let historyReadCount = 0;
    let requestedLimit = 0;
    let requestedSince = "";
    const appender = createRecentSessionEventAppender({
      config,
      store,
      reader: {
        ...reader,
        async recentMessages(conversation, since, limit) {
          historyReadCount += 1;
          requestedLimit = limit;
          requestedSince = new Date(since).toISOString();
          return reader.recentMessages(conversation, since, limit);
        }
      },
      now: () => NOW
    });
    await Promise.all([
      appender.appendEvent(event(target, "new-1")),
      appender.appendEvent(event(target, "new-2"))
    ]);
    await recorder.flush({ durable: true });

    assert.equal(historyReadCount, 1);
    assert.equal(requestedLimit, 2_048);
    assert.equal(
      requestedSince,
      new Date(NOW.valueOf() - 6 * 60 * 60 * 1_000).toISOString()
    );
    assert.deepEqual(
      store.getEvents(target).map((record) => record.event.message.id),
      ["history-1", "history-2", "new-1", "new-2"]
    );
    assert.equal(store.listConversationStates().length, 64);

    const journalFile = resolveSessionJournalFile(
      home.sessionsDir,
      NOW.toISOString()
    );
    const targetEventIds = (await readFile(journalFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionJournalRecord)
      .filter(
        (record) =>
          record.type === "event" &&
          record.record.event.conversation.id === target.id
      )
      .map((record) =>
        record.type === "event" ? record.record.event.id : "unreachable"
      );
    assert.deepEqual(targetEventIds, [
      "event-history-1",
      "event-history-2",
      "event-new-1",
      "event-new-2"
    ]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyGlobalAdmissionOrderAcrossSlowRehydration(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-session-global-admission-")
  );
  try {
    const home = await resolveGestaltHome({ homePath: temporaryDirectory });
    const recorder = createSessionRecorder(home);
    const firstConversation = conversation("slow-rehydrate-first");
    const secondConversation = conversation("cached-second");
    const overflowConversation = conversation("overflow-third");
    const store = createInMemorySessionStore({
      now: () => NOW,
      onJournalRecord: (record) => recorder.enqueue(record)
    });
    store.hydrateEvent(
      sessionEventRecord(
        secondConversation,
        "cached-prefix",
        new Date(NOW.valueOf() - 1_000)
      )
    );

    let releaseRehydration!: () => void;
    let markRehydrationStarted!: () => void;
    const rehydrationStarted = new Promise<void>((resolve) => {
      markRehydrationStarted = resolve;
    });
    const rehydrationRelease = new Promise<void>((resolve) => {
      releaseRehydration = resolve;
    });
    const baseReader = createSessionHistoryReader(home);
    const appender = createRecentSessionEventAppender({
      config: emptyConfig(home.configPath),
      store,
      reader: {
        ...baseReader,
        async recentMessages(target, since, limit) {
          if (target.id === firstConversation.id) {
            markRehydrationStarted();
            await rehydrationRelease;
            return [];
          }
          return baseReader.recentMessages(target, since, limit);
        }
      },
      now: () => NOW,
      maxPendingAppends: 2
    });

    const first = appender.appendEvent(event(firstConversation, "arrival-first"));
    await rehydrationStarted;
    const second = appender.appendEvent(
      event(secondConversation, "arrival-second")
    );
    await assert.rejects(
      appender.appendEvent(event(overflowConversation, "arrival-overflow")),
      /admission queue is full/
    );

    await Promise.resolve();
    assert.equal(
      recorder.getStats().pendingRecords,
      0,
      "a later cached conversation must not overtake the earlier slow rehydrate"
    );

    releaseRehydration();
    await Promise.all([first, second]);
    await recorder.flush({ durable: true });

    const journalFile = resolveSessionJournalFile(
      home.sessionsDir,
      NOW.toISOString()
    );
    const arrivalIds = (await readFile(journalFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as SessionJournalRecord)
      .flatMap((record) =>
        record.type === "event" &&
        record.record.event.message.id.startsWith("arrival-")
          ? [record.record.event.message.id]
          : []
      );
    assert.deepEqual(arrivalIds, ["arrival-first", "arrival-second"]);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyJournalAndHistory(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-session-journal-")
  );
  try {
    const home = await resolveGestaltHome({ homePath: temporaryDirectory });
    const recorder = createSessionRecorder(home);
    const records = [
      sessionEventRecord(conversation("group"), "recent-1", NOW),
      sessionEventRecord(
        conversation("group"),
        "old",
        new Date(NOW.valueOf() - 48 * 60 * 60 * 1_000)
      ),
      sessionEventRecord(
        conversation("group"),
        "recent-2",
        new Date(NOW.valueOf() - 1_000)
      )
    ];
    const firstRecord = records[0];
    if (firstRecord) {
      firstRecord.event.raw = Buffer.from([1, 2, 3, 4]);
      firstRecord.event.message.rawText =
        "[CQ:image,file=base64://AQIDBA==]";
    }
    for (const record of records) {
      await recorder.enqueue({
        type: "event",
        recordedAt: record.receivedAt,
        record
      });
    }
    await recorder.flush({ durable: true });

    const recentFile = resolveSessionJournalFile(
      home.sessionsDir,
      NOW.toISOString()
    );
    const persisted = await readFile(recentFile, "utf8");
    assert.equal(persisted.includes('"seq"'), false);
    assert.equal(persisted.includes('"type":"Buffer"'), false);
    assert.equal(persisted.includes('"raw"'), false);
    assert.equal(persisted.includes("base64://AQIDBA=="), false);
    assert.equal(persisted.includes("availability=not_captured"), true);
    assert.equal(persisted.trim().split("\n").length, 2);

    await appendFile(recentFile, '{"incomplete":', "utf8");
    const reader = createSessionHistoryReader(home);
    const recent = await reader.recentMessages(
      conversation("group"),
      new Date(NOW.valueOf() - 24 * 60 * 60 * 1_000),
      10
    );
    assert.deepEqual(
      recent.map((record) => record.event.message.id),
      ["recent-1", "recent-2"]
    );
    const timeRange = {
      since: new Date(NOW.valueOf() - 24 * 60 * 60 * 1_000),
      until: NOW
    };
    const firstPage = await reader.searchMessages(
      "recent",
      { conversation: conversation("group") },
      timeRange,
      undefined,
      1
    );
    assert.equal(firstPage.items[0]?.event.message.id, "recent-2");
    assert.ok(firstPage.nextCursor);
    const secondPage = await reader.searchMessages(
      "recent",
      { conversation: conversation("group") },
      timeRange,
      firstPage.nextCursor,
      1
    );
    assert.equal(secondPage.items[0]?.event.message.id, "recent-1");
    assert.equal(
      (
        await reader.findRecentMessage(
          conversation("group"),
          "recent-1",
          timeRange.since
        )
      )?.event.message.id,
      "recent-1"
    );

    const restored = createInMemorySessionStore();
    const hydration = await hydrateRecentSessionMessages({
      home,
      config: emptyConfig(home.configPath),
      store: restored,
      now: () => NOW,
      reader
    });
    assert.equal(hydration.hydratedCount, 2);
    assert.equal(restored.getEvents(conversation("group")).length, 2);

    await appendFile(recentFile, "}\n", "utf8");
    await assert.rejects(
      reader.recentMessages(
        conversation("group"),
        new Date(NOW.valueOf() - 24 * 60 * 60 * 1_000),
        10
      ),
      /Invalid (JSON|session journal record)/
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function verifyHighVolumeBounds(): Promise<void> {
  const temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "gestalt-session-volume-")
  );
  try {
    const home = await resolveGestaltHome({ homePath: temporaryDirectory });
    const recorder = createSessionRecorder(home);
    const target = conversation("volume");
    const store = createInMemorySessionStore({
      now: () => NOW,
      onJournalRecord: (record) => recorder.enqueue(record)
    });
    let maxBufferedBytes = 0;
    let midpointBytes = 0;
    for (let index = 0; index < 100_000; index += 1) {
      await store.appendEvent(event(target, `volume-${index}`));
      const stats = recorder.getStats();
      maxBufferedBytes = Math.max(maxBufferedBytes, stats.bufferedBytes);
      assert.ok(stats.bufferedBytes <= SESSION_JOURNAL_BUFFER_BYTES);
      if (index === 49_999) {
        await recorder.flush();
        midpointBytes = (
          await stat(
            resolveSessionJournalFile(home.sessionsDir, NOW.toISOString())
          )
        ).size;
      }
    }
    await recorder.flush({ durable: true });
    const finalBytes = (
      await stat(resolveSessionJournalFile(home.sessionsDir, NOW.toISOString()))
    ).size;
    assert.equal(store.getEvents(target).length, 2_048);
    assert.ok(maxBufferedBytes <= SESSION_JOURNAL_BUFFER_BYTES);
    assert.ok(finalBytes > midpointBytes * 1.8);
    assert.ok(finalBytes < midpointBytes * 2.2);
    assert.equal(recorder.getStats().pendingRecords, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyConfig(): void {
  assert.equal(
    readSessionRecentHistoryHours(emptyConfig("config.toml")),
    24
  );
  assert.throws(
    () =>
      readSessionRecentHistoryHours({
        ...emptyConfig("config.toml"),
        flatValues: { session_recent_history_hours: 0 }
      }),
    /positive integer/
  );
}

function sessionEventRecord(
  target: Conversation,
  messageId: string,
  receivedAt: Date
) {
  return {
    id: `record-${messageId}`,
    receivedAt: receivedAt.toISOString(),
    event: event(target, messageId, receivedAt)
  };
}

function event(
  target: Conversation,
  messageId: string,
  occurredAt: Date = NOW
): CanonicalEvent {
  return {
    id: `event-${messageId}`,
    type: "MessageReceived",
    occurredAt: occurredAt.toISOString(),
    source: { platform: "verify" },
    conversation: target,
    sender: { id: "user-1", displayName: "Verifier" },
    message: { id: messageId, text: messageId, mentionsBot: false }
  };
}

function conversation(id: string): Conversation {
  return { kind: "group", id };
}

function emptyConfig(configPath: string): GestaltConfig {
  return { path: configPath, raw: "", flatValues: {} };
}

await main();
