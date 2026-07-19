import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyStickerSegment,
  createMockConnector,
  createMockModel,
  createRuntime,
  createStickerLogger,
  createStickerService,
  createStickerStore,
  createStickerVectorIndex,
  executeActions,
  extractStickerObservations,
  prepareStickerMedia,
  readStickerRecommendationConfig,
  resolveGestaltHome,
  sampleFrameIndices,
  stickerIdFromSha256,
  stickerVectorIndexId,
  stickerVectorRowId,
  withStickerRecommendations,
  type GestaltConfig,
  type LiveEventSink,
  type MessageReceivedEvent,
  type ModelClient,
  type SendStickerInput,
  type StickerAnalyzer,
  type StickerDescriptionInput,
  type StickerEmbedder,
  type StickerEmbeddingResult,
  type StickerMediaResolver,
  type StickerLogger,
  type StickerObservation,
  type StickerService,
  type StickerStore,
  type StickerVectorIndex
} from "@gestalt/app";
import { writeArtifactJson } from "./artifactBinary";
import sharp from "sharp";

const DESCRIPTION_STATIC =
  "A red cat faces forward with one paw raised beside its head.";
const DESCRIPTION_ANIMATED =
  "A blue character repeatedly jumps with both arms raised.";
const STATIC_USAGE = [
  "你好呀", "欢迎欢迎", "来啦", "嗨", "见到你真好",
  "最近怎么样", "好久不见", "欢迎回来", "在吗", "出来聊天"
];
const ANIMATED_USAGE = [
  "太棒了", "好耶", "庆祝一下", "赢了", "值得庆祝",
  "干得漂亮", "芜湖", "成功啦", "今天真开心", "起飞"
];
const BASE_TIME = Date.parse("2026-07-11T08:00:00.000Z");
const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactDir = path.join(repoRoot, "harness", "artifacts", "stickers");
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "gestalt-stickers-"));

function fixtureDescription(animated: boolean) {
  return animated
    ? {
        visual: DESCRIPTION_ANIMATED,
        emotion: ["excited", "proud"],
        usage: ANIMATED_USAGE
      }
    : {
        visual: DESCRIPTION_STATIC,
        emotion: ["happy", "welcoming"],
        usage: STATIC_USAGE
      };
}

await rm(artifactDir, { recursive: true, force: true });
await mkdir(artifactDir, { recursive: true });

try {
  const staticFixture = await createStaticFixture();
  const animatedFixture = await createAnimatedFixture();
  await writeFile(path.join(artifactDir, "fixture-static.png"), staticFixture);
  await writeFile(path.join(artifactDir, "fixture-animated.gif"), animatedFixture);
  await assert.rejects(
    prepareStickerMedia(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>'
      )
    ),
    /Unsupported sticker image format: svg/
  );

  const classification = verifyClassification(staticFixture);
  await writeJson("classification.json", classification);
  const recommendationConfig = verifyStickerRecommendationConfiguration();
  await writeJson("recommendation-config.json", recommendationConfig);

  const preparedAnimation = await prepareStickerMedia(animatedFixture);
  assert.equal(preparedAnimation.animated, true);
  assert.equal(preparedAnimation.frameCount, 20);
  assert.equal(preparedAnimation.mime, "image/gif");
  assert.ok(preparedAnimation.contactSheet);
  const contactSheetMetadata = await sharp(
    preparedAnimation.contactSheet
  ).metadata();
  assert.equal(contactSheetMetadata.width, 1024);
  assert.equal(contactSheetMetadata.height, 1024);
  const weightedSampleIndices = sampleFrameIndices(4, [100, 200, 300, 400]);
  assert.deepEqual(weightedSampleIndices, [
    0, 0, 1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3
  ]);
  const animatedMetadata = await sharp(animatedFixture, {
    animated: true,
    pages: -1
  }).metadata();
  const animationSampleIndices = sampleFrameIndices(
    preparedAnimation.frameCount,
    animatedMetadata.delay
  );
  assert.equal(animationSampleIndices.length, 16);
  assert.ok(
    animationSampleIndices.every(
      (index) => index >= 0 && index < preparedAnimation.frameCount
    )
  );
  await writeFile(
    path.join(artifactDir, "contact-sheet-4x4.png"),
    preparedAnimation.contactSheet
  );
  await writeJson("contact-sheet.json", {
    sourceFrameCount: preparedAnimation.frameCount,
    sampledFrameCount: 16,
    sampleIndices: animationSampleIndices,
    weightedSamplingCheck: {
      frameDelays: [100, 200, 300, 400],
      sampleIndices: weightedSampleIndices
    },
    layout: "4x4",
    width: contactSheetMetadata.width,
    height: contactSheetMetadata.height
  });

  const home = await resolveGestaltHome({ homePath: tempRoot });
  const store = createStickerStore(home);
  const logger = createStickerLogger(home);
  const vectorIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId: "fixture-embedding"
  });
  const now = createClock();
  const connector = createMockConnector({ now });
  const sentStickers: SendStickerInput[] = [];
  let failNextMface = false;
  connector.sendSticker = async (input) => {
    sentStickers.push(input);
    if (failNextMface && input.sticker.startsWith("[CQ:mface,")) {
      failNextMface = false;
      return { ok: false, error: "fixture mface rejection" };
    }
    return {
      ok: true,
      externalId: `fixture-sticker-${sentStickers.length}`
    };
  };

  const preexistingStarted = deferred();
  const releasePreexisting = deferred();
  const staticEvent = createStickerEvent({
    id: "event-static-a",
    conversationId: "group-a",
    segment: imageStickerSegment(staticFixture)
  });
  const disabledEvent = createStickerEvent({
    id: "event-disabled",
    conversationId: "group-disabled",
    segment: imageStickerSegment(animatedFixture)
  });
  const duplicateMfaceEvent = createStickerEvent({
    id: "event-mface-duplicate",
    conversationId: "group-b",
    segment: mfaceSegment(staticFixture)
  });
  const ordinaryImageEvent = createStickerEvent({
    id: "event-ordinary-image",
    conversationId: "group-a",
    segment: {
      type: "image",
      data: { file: "ordinary-image-token", sub_type: 0 }
    }
  });
  const animatedEvent = createStickerEvent({
    id: "event-animated-b",
    conversationId: "group-b",
    segment: imageStickerSegment(animatedFixture)
  });
  const mediaByEvent = new Map<string, Uint8Array>([
    [staticEvent.id, staticFixture],
    [duplicateMfaceEvent.id, staticFixture],
    [animatedEvent.id, animatedFixture]
  ]);
  const mediaResolver: StickerMediaResolver = {
    async resolve(job) {
      if (job.eventId === staticEvent.id) {
        preexistingStarted.resolve();
        await releasePreexisting.promise;
      }
      const bytes = mediaByEvent.get(job.eventId);
      assert.ok(bytes, `Missing fixture media for ${job.eventId}.`);
      return bytes;
    }
  };
  const analyzerRequests: Array<Omit<StickerDescriptionInput, "image"> & {
    byteLength: number;
  }> = [];
  const analyzer: StickerAnalyzer = {
    async describe(input) {
      analyzerRequests.push({
        mime: input.mime,
        animated: input.animated,
        frameCount: input.frameCount,
        ...(input.platformSummary
          ? { platformSummary: input.platformSummary }
          : {}),
        byteLength: input.image.byteLength
      });
      return {
        description: fixtureDescription(input.animated),
        provider: "fixture-sub-provider",
        model: "fixture-sub-model",
        promptHash: "fixture-sticker-prompt"
      };
    }
  };
  const embeddingRequests: Array<{
    text: string;
    inputType: "document" | "query";
    queryPurpose?: "visual" | "tags" | "usage";
  }> = [];
  let failNextEmbedding = false;
  const embedder: StickerEmbedder = {
    provider: "fixture-embedding-provider",
    model: "fixture-embedding-model",
    id: "fixture-embedding",
    configuredDimensions: 3,
    async embed(text, options): Promise<StickerEmbeddingResult> {
      if (failNextEmbedding) {
        failNextEmbedding = false;
        throw new Error("fixture embedding search failure");
      }
      embeddingRequests.push({
        text,
        inputType: options?.inputType ?? "document",
        ...(options?.queryPurpose ? { queryPurpose: options.queryPurpose } : {})
      });
      return {
        vector: vectorFor(text)
      };
    }
  };

  const staticObservation = onlyObservation(staticEvent);
  const preexistingJob = await store.createJob(
    staticObservation,
    now().toISOString()
  );

  const service = createStickerService({
    home,
    connector,
    store,
    logger,
    mediaResolver,
    analyzer,
    embedder,
    vectorIndex,
    configuredEnabled: false,
    now
  });

  await preexistingStarted.promise;
  const inFlightSnapshot = await service.snapshot();
  assert.equal(inFlightSnapshot.scraping.configuredEnabled, false);
  assert.equal(inFlightSnapshot.scraping.effectiveEnabled, false);
  assert.equal(inFlightSnapshot.processing.running, 1);
  assert.equal(
    await service.observe(disabledEvent),
    0,
    "Disabled scraping must ignore new sticker observations."
  );
  assert.equal((await store.listJobs()).length, 1);

  releasePreexisting.resolve();
  await service.whenIdle();
  const preexistingResult = await store.readJob(preexistingJob.id);
  assert.equal(preexistingResult?.status, "ready");
  assert.equal(analyzerRequests.length, 1);
  const staticStickerId = stickerIdFor(staticFixture);
  assert.match(staticStickerId, /^stk_[a-f0-9]{16}$/);
  const searchWhileScrapingOff = await service.search({
    query: "红色小猫欢迎",
    agentTraceId: "agent-trace-search-while-off"
  });
  assert.equal(searchWhileScrapingOff[0]?.stickerId, staticStickerId);
  const sendWhileScrapingOffStart = sentStickers.length;
  const sendWhileScrapingOff = await service.send({
    conversation: { kind: "group", id: "group-a" },
    stickerId: staticStickerId,
    agentTraceId: "agent-trace-send-while-off"
  });
  assert.equal(sendWhileScrapingOff.ok, true);
  assert.match(
    sentStickers[sendWhileScrapingOffStart]?.sticker ?? "",
    /\[CQ:image,[^\]]*sub_type=1/
  );
  assert.equal(
    (await service.snapshot()).scraping.effectiveEnabled,
    false,
    "Searching and sending existing stickers must not re-enable collection."
  );

  assert.equal(
    await service.setScrapingOverride(true, {
      actorUserId: "operator",
      sourceEventId: "event-toggle-on",
      at: now().toISOString()
    }),
    true
  );
  assert.equal(await service.observe(ordinaryImageEvent), 0);
  assert.equal((await store.listJobs()).length, 1);
  assert.equal(await service.observe(duplicateMfaceEvent), 1);
  await service.whenIdle();

  const staticRecordAfterDedupe = await store.readRecord(staticStickerId);
  assert.ok(staticRecordAfterDedupe);
  assert.equal(analyzerRequests.length, 1, "Exact duplicate must not be re-described.");
  assert.deepEqual(staticRecordAfterDedupe.mface, {
    emojiId: "emoji-red-cat",
    emojiPackageId: "package-fixture",
    key: "fixture-secret-key",
    summary: "[动画表情]"
  });
  assert.equal((await store.listRecords()).length, 1);
  assert.equal(
    (await store.listJobs()).filter((job) => job.duplicate).length,
    1
  );

  assert.equal(await service.observe(animatedEvent), 1);
  await service.whenIdle();
  const animatedStickerId = stickerIdFor(animatedFixture);
  const animatedRecord = await store.readRecord(animatedStickerId);
  assert.ok(animatedRecord);
  assert.equal(animatedRecord.status, "ready");
  assert.deepEqual(animatedRecord.description, fixtureDescription(true));
  assert.equal(animatedRecord.asset.animated, true);
  assert.equal(animatedRecord.asset.frameCount, 20);
  assert.ok(animatedRecord.asset.contactSheetRelativePath);
  assert.equal(analyzerRequests.length, 2);
  assert.deepEqual(analyzerRequests.map((request) => request.animated), [
    false,
    true
  ]);
  assert.equal(analyzerRequests[1]?.mime, "image/png");
  assert.ok(
    [DESCRIPTION_STATIC, DESCRIPTION_ANIMATED].every((description) =>
      embeddingRequests.some(
        (request) =>
          request.text === description && request.inputType === "document"
      )
    ),
    "Sticker visual descriptions must be embedded unchanged as documents."
  );

  const searchBlueInB = await service.search({
    query: "蓝色跳舞庆祝",
    limit: 5,
    agentTraceId: "agent-trace-blue-b"
  });
  assert.ok(
    embeddingRequests.some(
      (request) =>
        request.text === "蓝色跳舞庆祝" && request.inputType === "query"
    ),
    "Sticker searches must identify their embedding input as a query."
  );
  assert.ok(searchBlueInB.some((result) => result.stickerId === animatedStickerId));
  assert.ok(searchBlueInB.every((result) => result.channels.length > 0));
  const searchBlueInA = await service.search({
    query: "蓝色跳舞庆祝",
    limit: 5,
    agentTraceId: "agent-trace-blue-a"
  });
  assert.deepEqual(
    new Set(searchBlueInA.map((result) => result.stickerId)),
    new Set([animatedStickerId, staticStickerId]),
    "Every conversation must search the same bot-wide sticker catalog."
  );
  const searchUnknownConversation = await service.search({
    query: "红色开心欢迎"
  });
  assert.ok(searchUnknownConversation.some((result) => result.stickerId === staticStickerId));
  const searchSameIdPrivate = await service.search({
    query: "红色开心欢迎"
  });
  assert.ok(searchSameIdPrivate.some((result) => result.stickerId === staticStickerId));
  failNextEmbedding = true;
  await assert.rejects(
    service.search({
      query: "触发检索失败",
      agentTraceId: "agent-trace-search-failed"
    }),
    /fixture embedding search failure/
  );

  const nativeStart = sentStickers.length;
  const nativeResult = await service.send({
    conversation: { kind: "group", id: "group-b" },
    stickerId: staticStickerId,
    agentTraceId: "agent-trace-native-send"
  });
  assert.equal(nativeResult.ok, true);
  assert.match(sentStickers[nativeStart]?.sticker ?? "", /^\[CQ:mface,/);

  const imageStart = sentStickers.length;
  const imageResult = await service.send({
    conversation: { kind: "group", id: "group-b" },
    stickerId: animatedStickerId,
    replyToMessageId: "reply-target",
    agentTraceId: "agent-trace-image-send"
  });
  assert.equal(imageResult.ok, true);
  assert.match(sentStickers[imageStart]?.sticker ?? "", /^\[CQ:image,/);
  assert.match(sentStickers[imageStart]?.sticker ?? "", /(?:^|,)sub_type=1(?:,|\])/);
  assert.equal(sentStickers[imageStart]?.replyToMessageId, "reply-target");

  failNextMface = true;
  const fallbackStart = sentStickers.length;
  const fallbackResult = await service.send({
    conversation: { kind: "group", id: "group-a" },
    stickerId: staticStickerId,
    agentTraceId: "agent-trace-fallback-send"
  });
  assert.equal(fallbackResult.ok, true);
  assert.equal(sentStickers.length - fallbackStart, 2);
  assert.match(sentStickers[fallbackStart]?.sticker ?? "", /^\[CQ:mface,/);
  assert.match(sentStickers[fallbackStart + 1]?.sticker ?? "", /^\[CQ:image,/);
  assert.match(
    sentStickers[fallbackStart + 1]?.sticker ?? "",
    /(?:^|,)sub_type=1(?:,|\])/
  );
  assert.deepEqual(asRecord(fallbackResult.data), {
    stickerId: staticStickerId,
    visual: DESCRIPTION_STATIC
  });
  const unknownSendResult = await service.send({
    conversation: { kind: "group", id: "group-b" },
    stickerId: "stk_missing",
    agentTraceId: "agent-trace-send-missing"
  });
  assert.equal(unknownSendResult.ok, false);
  const globalSendResult = await service.send({
    conversation: { kind: "group", id: "group-unknown" },
    stickerId: staticStickerId,
    agentTraceId: "agent-trace-global-send"
  });
  assert.equal(globalSendResult.ok, true);

  const finalSnapshot = await service.snapshot();
  assert.deepEqual(finalSnapshot.scraping, {
    configuredEnabled: false,
    runtimeOverride: true,
    effectiveEnabled: true
  });
  assert.deepEqual(finalSnapshot.processing, {
    queued: 0,
    running: 0,
    failed: 0,
    ready: 2,
    duplicates: 1
  });
  assert.equal(finalSnapshot.embedding.rowCount, 24);
  assert.equal(finalSnapshot.embedding.indexState, "ready");
  assert.equal(finalSnapshot.embedding.dimensions, 3);
  assert.equal(finalSnapshot.stickers.length, 2);
  assert.equal(finalSnapshot.jobs.length, 3);
  assert.ok(finalSnapshot.jobs.every((job) => job.status === "ready"));

  const logPath = path.join(home.stickerLogsDir, "2026-07-11.jsonl");
  const logText = await readFile(logPath, "utf8");
  const logEntries = logText
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as { type: string; data: unknown });
  const logTypes = new Set(logEntries.map((entry) => entry.type));
  for (const expectedType of [
    "sticker.ignored",
    "sticker.job_queued",
    "sticker.rendering_started",
    "sticker.media_prepared",
    "sticker.contact_sheet_created",
    "sticker.description_completed",
    "sticker.embedding_completed",
    "sticker.indexing_started",
    "sticker.lancedb_upserted",
    "sticker.duplicate_found",
    "sticker.ready",
    "sticker.scraping_state_changed",
    "sticker.search_completed",
    "sticker.search_failed",
    "sticker.send_attempted",
    "sticker.send_fallback",
    "sticker.send_completed",
    "sticker.send_failed"
  ]) {
    assert.ok(logTypes.has(expectedType), `Missing sticker log ${expectedType}.`);
  }
  assert.ok(
    logEntries.some(
      (entry) =>
        entry.type === "sticker.search_completed" &&
        asRecord(entry.data)?.distanceMetric === "cosine"
    ),
    "Sticker search logs must identify the cosine distance metric."
  );
  assert.ok(
    logEntries.some(
      (entry) =>
        entry.type === "sticker.ignored" &&
        asRecord(entry.data)?.reason === "not_collectable"
    ),
    "Ordinary images must be observably rejected without creating sticker jobs."
  );
  const firstJobLogTypes = logEntries
    .filter((entry) =>
      (entry as { jobId?: string }).jobId === preexistingJob.id
    )
    .map((entry) => entry.type);
  assert.deepEqual(firstJobLogTypes, [
    "sticker.media_resolving",
    "sticker.media_downloaded",
    "sticker.rendering_started",
    "sticker.media_prepared",
    "sticker.description_started",
    "sticker.description_completed",
    "sticker.embedding_started",
    "sticker.embedding_completed",
    "sticker.indexing_started",
    "sticker.lancedb_upserted",
    "sticker.ready"
  ]);
  assert.equal(
    logEntries.some(
      (entry) =>
        entry.type === "sticker.contact_sheet_created" &&
        (entry as { jobId?: string }).jobId === preexistingJob.id
    ),
    false,
    "Static stickers must not claim that a contact sheet was created."
  );
  assert.equal(
    logText.includes("fixture-secret-key"),
    false,
    "sticker-logs must not expose mface keys."
  );
  for (const forbidden of [
    "base64://",
    "data:image/",
    "SIGNED_",
    "fixture-main-key",
    "fixture-embedding-key",
    '"vector"'
  ]) {
    assert.equal(
      logText.includes(forbidden),
      false,
      `sticker-logs leaked forbidden payload: ${forbidden}`
    );
  }

  const records = await store.listRecords();
  const jobs = await store.listJobs();
  const homeFiles = await listFiles(home.root);
  const blobFiles = await readdir(home.stickerBlobsDir);
  assert.equal(blobFiles.length, 3, "Exact dedupe must not create another blob.");
  await writeJson("snapshot-in-flight.json", inFlightSnapshot);
  await writeJson("snapshot-final.json", finalSnapshot);
  await writeJson("records.json", records);
  await writeJson("jobs.json", jobs);
  await writeJson("analyzer-requests.json", analyzerRequests);
  await writeJson("embedding-requests.json", embeddingRequests);
  await writeJson("lancedb-search-results.json", {
    firstConversation: searchBlueInB,
    anotherConversation: searchBlueInA,
    unseenConversation: searchUnknownConversation,
    privateConversation: searchSameIdPrivate
  });
  await writeJson("connector-sticker-calls.json", sentStickers);
  await writeJson("home-files.json", homeFiles);
  await copyFile(
    store.absolutePath(animatedRecord.asset.contactSheetRelativePath),
    path.join(artifactDir, "stored-contact-sheet.png")
  );

  const runtimeCommands = await verifyRuntimeCommands(tempRoot);
  await writeJson("runtime-commands.json", runtimeCommands);
  const configuredServiceRestart = await verifyConfiguredServiceRestart(tempRoot);
  await writeJson("configured-service-restart.json", configuredServiceRestart);
  const loggerPrivacy = await verifyLoggerPrivacy(tempRoot);
  await writeJson("logger-privacy.json", loggerPrivacy);
  const runtimeStickerTranscript = await verifyRuntimeStickerTranscript({
    root: tempRoot,
    service,
    connector,
    stickerId: animatedStickerId,
    staticStickerId
  });
  await writeJson("runtime-sticker-transcript.json", runtimeStickerTranscript);
  const workerWakeup = await verifyWorkerWakeup(tempRoot, staticFixture);
  const processingConcurrency = await verifyProcessingConcurrency(tempRoot);
  const intermediateStageRecovery = await verifyIntermediateStageRecovery(
    tempRoot,
    staticFixture
  );
  const workerResilience = await verifyWorkerResilience(
    tempRoot,
    staticFixture
  );
  const globalDuplicateReuse = await verifyGlobalDuplicateReuse(
    tempRoot,
    staticFixture
  );
  const embeddingIdRebuild = await verifyEmbeddingIdRebuild(
    tempRoot,
    staticFixture
  );
  const invalidVectorRows = await verifyInvalidVectorRowIsolation(
    tempRoot,
    staticFixture
  );
  const structuredRetrieval = await verifyStructuredRetrievalPolicy(tempRoot);
  await writeJson("worker-wakeup.json", workerWakeup);
  await writeJson("processing-concurrency.json", processingConcurrency);
  await writeJson("intermediate-stage-recovery.json", intermediateStageRecovery);
  await writeJson("worker-resilience.json", workerResilience);
  await writeJson(
    "global-duplicate-reuse.json",
    globalDuplicateReuse
  );
  await writeJson(
    "embedding-id-rebuild.json",
    embeddingIdRebuild
  );
  await writeJson("invalid-vector-rows.json", invalidVectorRows);
  await writeJson("structured-retrieval.json", structuredRetrieval);
  await copyFile(logPath, path.join(artifactDir, "sticker-logs.jsonl"));

  const summary = {
    ok: true,
    classification,
    recommendationConfig,
    contactSheet: {
      sourceFrames: preparedAnimation.frameCount,
      sampledFrames: animationSampleIndices.length,
      layout: "4x4",
      width: contactSheetMetadata.width,
      height: contactSheetMetadata.height
    },
    scrapingOff: {
      ignoredNewObservation: true,
      preexistingJobId: preexistingJob.id,
      preexistingFinalStatus: preexistingResult?.status,
      processingWhileDisabled: inFlightSnapshot.processing.running,
      existingStickerSearchable: searchWhileScrapingOff[0]?.stickerId,
      existingStickerSendable: sendWhileScrapingOff.ok
    },
    dedupe: {
      stickerId: staticStickerId,
      recordCountAfterDuplicate: 1,
      analyzerCallsAfterDuplicate: 1,
      duplicateJobs: finalSnapshot.processing.duplicates,
      blobCount: blobFiles.length
    },
    indexing: finalSnapshot.embedding,
    search: {
      firstConversationTop: searchBlueInB[0]?.stickerId,
      anotherConversationResults: searchBlueInA.map((result) => result.stickerId),
      unseenConversationTop: searchUnknownConversation[0]?.stickerId,
      privateConversationTop: searchSameIdPrivate[0]?.stickerId
    },
    send: {
      nativeMface: true,
      imageSubtypeOne: true,
      nativeFailureFallback: true,
      connectorCallCount: sentStickers.length
    },
    runtimeCommands,
    configuredServiceRestart,
    loggerPrivacy,
    runtimeStickerTranscript,
    workerWakeup,
    processingConcurrency,
    intermediateStageRecovery,
    workerResilience,
    globalDuplicateReuse,
    embeddingIdRebuild,
    invalidVectorRows,
    structuredRetrieval,
    logs: {
      count: logEntries.length,
      types: [...logTypes].sort()
    }
  };
  await writeJson("summary.json", summary);
  await writeFile(
    path.join(artifactDir, "report.md"),
    [
      "# Sticker Runtime Verification",
      "",
      "- Protocol classification: image `sub_type=1`, direct mface, and compatibility mface accepted; ordinary image ignored.",
      "- Scraping off: new observation ignored while the queued job continued through analysis and indexing.",
      "- Media analysis: 20-frame GIF sampled into a 16-cell, 4x4, 1024x1024 contact sheet.",
      "- Exact dedupe: one bot-wide stable sticker record, no second analysis, latest mface delivery metadata merged.",
      `- LanceDB: ${finalSnapshot.embedding.rowCount} global rows at ${finalSnapshot.embedding.dimensions} dimensions.`,
      "- Search: every conversation uses the same bot-wide LanceDB catalog.",
      `- Recommendations: successful text sends returned Top-${runtimeStickerTranscript.recommendationLimit} embedding candidates; probability zero made ${runtimeStickerTranscript.disabledProbabilitySearches} searches.`,
      `- Index hygiene: ${invalidVectorRows.invalidRows} orphan/failed nearest rows were bypassed during search and pruned to the exact ready catalog set.`,
      "- Sending: native mface, image `sub_type=1`, and mface failure fallback verified.",
      "- Runtime command: authorized on/off/toggle, unauthorized rejection, acknowledgement, and zero model/window/steer activity verified.",
      "- Worker resilience: partial observation persistence, failed logger/Live sinks, and transient worker faults cannot strand queued work or change send results.",
      `- Processing concurrency: ${processingConcurrency.maxActive} jobs ran simultaneously at the configured limit.`,
      `- Observability: ${logEntries.length} lifecycle entries exported from sticker-logs.`,
      ""
    ].join("\n"),
    "utf8"
  );

  console.log(JSON.stringify({ ok: true, artifactDir, summary }, null, 2));
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function verifyStructuredRetrievalPolicy(
  root: string
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "structured-retrieval-home")
  });
  const store = createStickerStore(home);
  const embeddingId = "structured-retrieval-embedding";
  const indexedAt = "2026-07-11T08:00:00.000Z";
  const stickerIds = Array.from(
    { length: 15 },
    (_, index) => `stk_policy_${String(index).padStart(2, "0")}`
  );
  for (const [index, stickerId] of stickerIds.entries()) {
    await store.saveRecord({
      id: stickerId,
      status: "ready",
      description: {
        visual: `Objective visual ${index}`,
        emotion: index % 2 === 0 ? ["confused"] : ["suspicious"],
        usage: Array.from(
          { length: 10 },
          (_, usageIndex) => `为什么 ${index}-${usageIndex}`
        )
      },
      asset: {
        sha256: index.toString(16).padStart(64, "0"),
        mime: "image/png",
        relativePath: `stickers/blobs/policy-${index}.png`,
        byteLength: 1,
        animated: false,
        frameCount: 1
      },
      embedding: {
        id: stickerVectorIndexId(embeddingId),
        dimensions: 3,
        units: { visual: 1, tags: 1, usage: 10 },
        indexedAt
      },
      createdAt: indexedAt,
      updatedAt: indexedAt
    });
  }

  const allRows = stickerIds.flatMap((stickerId) => [
    { rowId: stickerVectorRowId(stickerId, "visual", 0), stickerId },
    { rowId: stickerVectorRowId(stickerId, "tags", 0), stickerId },
    ...Array.from({ length: 10 }, (_, unitIndex) => ({
      rowId: stickerVectorRowId(stickerId, "usage", unitIndex),
      stickerId
    }))
  ]);
  const searchCalls: Array<{
    channel: "visual" | "tags" | "usage";
    offset: number;
    limit: number;
  }> = [];
  const rowsForChannel = (channel: "visual" | "tags" | "usage") =>
    channel === "usage"
      ? stickerIds.flatMap((stickerId, stickerIndex) =>
          Array.from({ length: 10 }, (_, unitIndex) => ({
            rowId: stickerVectorRowId(stickerId, channel, unitIndex),
            stickerId,
            channel,
            unitIndex,
            text: `为什么 ${stickerIndex}-${unitIndex}`,
            distance: stickerIndex / 100 + unitIndex / 10_000
          }))
        )
      : stickerIds.map((stickerId, index) => ({
          rowId: stickerVectorRowId(stickerId, channel, 0),
          stickerId,
          channel,
          unitIndex: 0,
          text: channel === "visual" ? `Objective visual ${index}` : "confused",
          distance: index / 100
        }));
  const vectorIndex: StickerVectorIndex = {
    async upsert() {
      throw new Error("Structured retrieval fixture should not reindex current rows.");
    },
    async search(searchInput) {
      searchCalls.push({
        channel: searchInput.channel,
        offset: searchInput.offset ?? 0,
        limit: searchInput.limit
      });
      return rowsForChannel(searchInput.channel).slice(
        searchInput.offset ?? 0,
        (searchInput.offset ?? 0) + searchInput.limit
      );
    },
    async listRows() {
      return allRows;
    },
    async listStickerIds() {
      return allRows.map((row) => row.stickerId);
    },
    async deleteRowIds() {
      return 0;
    },
    async deleteStickerIds() {
      return 0;
    },
    async snapshot() {
      return {
        rowCount: allRows.length,
        indexState: "ready",
        dimensions: 3,
        id: stickerVectorIndexId(embeddingId),
        distanceMetric: "cosine"
      };
    }
  };
  const embeddingCalls: Array<{
    inputType: "document" | "query";
    queryPurpose?: "visual" | "tags" | "usage";
  }> = [];
  const embedder: StickerEmbedder = {
    provider: "fixture",
    model: "fixture",
    id: embeddingId,
    configuredDimensions: 3,
    async embed(_text, options) {
      embeddingCalls.push({
        inputType: options?.inputType ?? "document",
        ...(options?.queryPurpose ? { queryPurpose: options.queryPurpose } : {})
      });
      return { vector: [1, 0, 0] };
    }
  };
  const service = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger: createStickerLogger(home),
    mediaResolver: { async resolve() { throw new Error("unused"); } },
    analyzer: createFixtureAnalyzer(),
    embedder,
    vectorIndex,
    configuredEnabled: false,
    now: createClock()
  });
  await service.whenIdle();

  const active = await service.search({
    query: "为什么表情",
    mode: "search",
    seed: "active-seed",
    limit: 5
  });
  assert.deepEqual(
    new Set(embeddingCalls.map((call) => call.queryPurpose)),
    new Set(["tags", "visual"])
  );
  assert.deepEqual(
    new Set(searchCalls.map((call) => call.channel)),
    new Set(["tags", "visual"])
  );
  assert.equal(active.length, 5);
  assert.equal(new Set(active.map((result) => result.stickerId)).size, 5);

  embeddingCalls.length = 0;
  searchCalls.length = 0;
  const recommendation = await service.search({
    query: "为什么",
    mode: "recommendation",
    seed: "recommendation-seed",
    limit: 5
  });
  const repeated = await service.search({
    query: "为什么",
    mode: "recommendation",
    seed: "recommendation-seed",
    limit: 5
  });
  const rotated = await service.search({
    query: "为什么",
    mode: "recommendation",
    seed: "another-seed",
    limit: 5
  });
  assert.deepEqual(
    new Set(embeddingCalls.map((call) => call.queryPurpose)),
    new Set(["usage"])
  );
  assert.deepEqual(new Set(searchCalls.map((call) => call.channel)), new Set(["usage"]));
  assert.ok(searchCalls.some((call) => call.offset === 100));
  assert.equal(new Set(recommendation.map((result) => result.stickerId)).size, 5);
  assert.deepEqual(repeated, recommendation);
  assert.notDeepEqual(
    rotated.map((result) => result.stickerId),
    recommendation.map((result) => result.stickerId)
  );

  return {
    structuredFields: ["visual", "emotion", "usage"],
    activeQueryPurposes: ["tags", "visual"],
    activeChannels: ["tags", "visual"],
    recommendationQueryPurposes: ["usage"],
    recommendationChannels: ["usage"],
    usageRowsScannedAcrossSecondPage: true,
    uniqueRecommendationCount: recommendation.length,
    deterministicForSameSeed: true,
    rotatesForDifferentSeed: true,
    modelVisibleFields: ["sticker_id", "visual"]
  };
}

async function verifyWorkerWakeup(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "worker-wakeup-home")
  });
  const store = createStickerStore(home);
  const baseIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId: "worker-wakeup-config"
  });
  const auditStarted = deferred();
  const releaseAudit = deferred();
  let holdInitialAudit = true;
  const vectorIndex: StickerVectorIndex = {
    upsert: (entry) => baseIndex.upsert(entry),
    search: (input) => baseIndex.search(input),
    async listRows() {
      if (holdInitialAudit) {
        holdInitialAudit = false;
        auditStarted.resolve();
        await releaseAudit.promise;
      }
      return baseIndex.listRows();
    },
    listStickerIds: () => baseIndex.listStickerIds(),
    deleteRowIds: (rowIds) => baseIndex.deleteRowIds(rowIds),
    deleteStickerIds: (stickerIds) => baseIndex.deleteStickerIds(stickerIds),
    snapshot: () => baseIndex.snapshot()
  };
  const embedder = createFixtureEmbedder("worker-wakeup-config");
  const service = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger: createStickerLogger(home),
    mediaResolver: { async resolve() { return bytes; } },
    analyzer: createFixtureAnalyzer(),
    embedder,
    vectorIndex,
    configuredEnabled: true,
    now: createClock()
  });

  await auditStarted.promise;
  const observed = await service.observe(
    createStickerEvent({
      id: "worker-wakeup-event",
      conversationId: "worker-wakeup-group",
      segment: imageStickerSegment(bytes)
    })
  );
  assert.equal(observed, 1);
  releaseAudit.resolve();
  await service.whenIdle();
  const jobs = await store.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "ready");
  return {
    queuedWhileWorkerAuditingEmptySnapshot: true,
    finalStatus: jobs[0]?.status,
    attempts: jobs[0]?.attempts
  };
}

async function verifyProcessingConcurrency(
  root: string
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "processing-concurrency-home")
  });
  const store = createStickerStore(home);
  const variants = await Promise.all(
    Array.from({ length: 6 }, (_, index) =>
      sharp({
        create: {
          width: 8,
          height: 8,
          channels: 4,
          background: { r: index * 30, g: 80, b: 160, alpha: 1 }
        }
      })
        .png()
        .toBuffer()
    )
  );
  const bytesByEvent = new Map(
    variants.map((bytes, index) => [`concurrency-event-${index}`, bytes])
  );
  const allStarted = deferred();
  const release = deferred();
  let active = 0;
  let maxActive = 0;
  const analyzer: StickerAnalyzer = {
    async describe() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === variants.length) {
        allStarted.resolve();
      }
      await release.promise;
      active -= 1;
      return {
        description: fixtureDescription(false),
        provider: "fixture-sub-provider",
        model: "fixture-sub-model",
        promptHash: "fixture-sticker-prompt"
      };
    }
  };
  const service = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger: createStickerLogger(home),
    mediaResolver: {
      async resolve(job) {
        const bytes = bytesByEvent.get(job.eventId);
        assert.ok(bytes);
        return bytes;
      }
    },
    analyzer,
    embedder: createFixtureEmbedder("processing-concurrency-config"),
    vectorIndex: await createStickerVectorIndex({
      directory: home.stickerLanceDbDir,
      embeddingId: "processing-concurrency-config"
    }),
    configuredEnabled: true,
    processingConcurrency: 6,
    now: createClock()
  });
  await Promise.all(
    variants.map((_, index) =>
      service.observe(
        createStickerEvent({
          id: `concurrency-event-${index}`,
          conversationId: "processing-concurrency-group",
          segment: imageStickerSegment(variants[index]!)
        })
      )
    )
  );
  await Promise.race([
    allStarted.promise,
    waitForHarness(5_000).then(() => {
      throw new Error("Timed out waiting for six concurrent sticker jobs.");
    })
  ]);
  assert.equal(maxActive, 6);
  release.resolve();
  await service.whenIdle();
  const jobs = await store.listJobs();
  assert.equal(jobs.filter((job) => job.status === "ready").length, 6);
  return {
    configured: 6,
    maxActive,
    ready: jobs.filter((job) => job.status === "ready").length
  };
}

async function verifyWorkerResilience(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "worker-resilience-home")
  });
  const baseStore = createStickerStore(home);
  let createJobCalls = 0;
  let listJobsCalls = 0;
  let listJobFailuresRemaining = 3;
  const store: StickerStore = {
    ...baseStore,
    async createJob(observation, at) {
      createJobCalls += 1;
      if (createJobCalls === 1) {
        throw new Error("fixture partial job persistence failure");
      }
      return baseStore.createJob(observation, at);
    },
    async listJobs() {
      listJobsCalls += 1;
      if (listJobFailuresRemaining > 0) {
        listJobFailuresRemaining -= 1;
        throw new Error("fixture transient worker store failure");
      }
      return baseStore.listJobs();
    }
  };
  let loggerAttempts = 0;
  const logger: StickerLogger = {
    async append() {
      loggerAttempts += 1;
      throw new Error("fixture sticker logger unavailable");
    }
  };
  let livePublishAttempts = 0;
  const liveEvents: LiveEventSink = {
    publish() {
      livePublishAttempts += 1;
      throw new Error("fixture Live event sink unavailable");
    }
  };
  const connector = createMockConnector();
  let connectorSendCalls = 0;
  let rejectDelivery = false;
  connector.sendSticker = async () => {
    connectorSendCalls += 1;
    if (rejectDelivery) {
      return {
        ok: false,
        error: "fixture connector secret diagnostic",
        data: { privateConnectorPayload: "must-not-escape" }
      };
    }
    return {
      ok: true,
      externalId: `worker-resilience-${connectorSendCalls}`,
      data: { privateConnectorPayload: "must-not-escape" }
    };
  };
  const vectorIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId: "worker-resilience-config"
  });
  const unhandledRejections: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    const service = createStickerService({
      home,
      connector,
      store,
      logger,
      liveEvents,
      mediaResolver: { async resolve() { return bytes; } },
      analyzer: createFixtureAnalyzer(),
      embedder: createFixtureEmbedder("worker-resilience-config"),
      vectorIndex,
      configuredEnabled: true,
      now: createClock()
    });
    const event = createStickerEvent({
      id: "worker-resilience-event",
      conversationId: "worker-resilience-group",
      segment: imageStickerSegment(bytes)
    });
    event.message.sourceContent = {
      format: "onebot-v11",
      segments: [imageStickerSegment(bytes), imageStickerSegment(bytes)]
    };

    const queued = await service.observe(event);
    assert.equal(queued, 1, "One failed observation must not discard its sibling job.");
    await withTimeout(
      service.whenIdle(),
      5_000,
      "Sticker worker did not recover from transient top-level failures."
    );

    const jobs = await baseStore.listJobs();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]?.segmentIndex, 1);
    assert.equal(jobs[0]?.status, "ready");
    assert.equal(jobs[0]?.attempts, 1);
    assert.equal(listJobFailuresRemaining, 0);
    assert.ok(loggerAttempts > 3);
    assert.ok(livePublishAttempts > 0);

    const stickerId = stickerIdFor(bytes);
    const successfulSend = await service.send({
      conversation: { kind: "group", id: "worker-resilience-group" },
      stickerId
    });
    assert.equal(successfulSend.ok, true);
    assert.equal(connectorSendCalls, 1);
    assert.equal(
      JSON.stringify(successfulSend).includes("privateConnectorPayload"),
      false,
      "A successful send may expose only the curated sticker result."
    );

    rejectDelivery = true;
    const failedSend = await service.send({
      conversation: { kind: "group", id: "worker-resilience-group" },
      stickerId
    });
    assert.deepEqual(failedSend, {
      ok: false,
      error: "Sticker delivery failed."
    });
    assert.equal(connectorSendCalls, 2, "Observability failures must not retry sends.");

    const listCallsAtIdle = listJobsCalls;
    await waitForHarness(125);
    assert.equal(
      listJobsCalls,
      listCallsAtIdle,
      "The recovered worker must stop polling after all jobs are terminal."
    );
    await waitForHarness(0);
    assert.deepEqual(unhandledRejections, []);

    return {
      observations: 2,
      queuedJobs: queued,
      failedCreateJobCalls: 1,
      transientWorkerFailures: 3,
      finalStatus: jobs[0]?.status,
      processingAttempts: jobs[0]?.attempts,
      loggerFailuresContained: loggerAttempts,
      livePublishFailuresContained: livePublishAttempts,
      workerStoppedAfterIdle: listJobsCalls === listCallsAtIdle,
      unhandledRejections: unhandledRejections.length,
      successfulSendPreserved: successfulSend.ok,
      connectorSendCalls,
      failedSend
    };
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }
}

async function verifyIntermediateStageRecovery(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "intermediate-stage-recovery-home")
  });
  const store = createStickerStore(home);
  const event = createStickerEvent({
    id: "intermediate-stage-before-restart",
    conversationId: "intermediate-stage-group",
    segment: imageStickerSegment(bytes)
  });
  const job = await store.createJob(
    onlyObservation(event),
    "2026-07-11T08:30:00.000Z"
  );
  await store.updateJob(job.id, {
    status: "embedding",
    updatedAt: "2026-07-11T08:30:01.000Z"
  });

  const service = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger: createStickerLogger(home),
    mediaResolver: { async resolve() { return bytes; } },
    analyzer: createFixtureAnalyzer(),
    embedder: createFixtureEmbedder("intermediate-stage-config"),
    vectorIndex: await createStickerVectorIndex({
      directory: home.stickerLanceDbDir,
      embeddingId: "intermediate-stage-config"
    }),
    configuredEnabled: false
  });
  await service.whenIdle();
  const recovered = await store.readJob(job.id);
  assert.ok(recovered);
  assert.equal(
    recovered.status,
    "ready",
    recovered.error ?? "Intermediate sticker job did not recover."
  );
  assert.equal(recovered.attempts, 1);
  return {
    persistedStage: "embedding",
    scrapingEnabledAfterRestart: service.isScrapingEnabled(),
    recoveredStatus: recovered.status,
    attempts: recovered.attempts
  };
}

async function verifyGlobalDuplicateReuse(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "global-duplicate-home")
  });
  const store = createStickerStore(home);
  const vectorIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId: "global-duplicate-config"
  });
  let embeddingCalls = 0;
  const baseEmbedder = createFixtureEmbedder("global-duplicate-config");
  const embedder: StickerEmbedder = {
    ...baseEmbedder,
    async embed(text, options) {
      embeddingCalls += 1;
      return baseEmbedder.embed(text, options);
    }
  };
  const connector = createMockConnector();
  const service = createStickerService({
    home,
    connector,
    store,
    logger: createStickerLogger(home),
    mediaResolver: { async resolve() { return bytes; } },
    analyzer: createFixtureAnalyzer(),
    embedder,
    vectorIndex,
    configuredEnabled: true,
    now: createClock()
  });

  await service.observe(
    createStickerEvent({
      id: "duplicate-original",
      conversationId: "duplicate-origin-chat",
      segment: imageStickerSegment(bytes)
    })
  );
  await service.whenIdle();
  const stickerId = stickerIdFor(bytes);
  const before = await store.readRecord(stickerId);
  assert.equal(before?.status, "ready");
  assert.equal(embeddingCalls, 12);

  await service.observe(
    createStickerEvent({
      id: "duplicate-second-chat",
      conversationId: "duplicate-second-chat",
      segment: mfaceSegment(bytes)
    })
  );
  await service.whenIdle();

  const after = await store.readRecord(stickerId);
  assert.equal(after?.status, "ready");
  assert.equal(after?.mface?.emojiId, "emoji-red-cat");
  assert.equal(embeddingCalls, 12, "A duplicate must reuse all global retrieval units.");
  const duplicateJob = (await store.listJobs()).find(
    (job) => job.eventId === "duplicate-second-chat"
  );
  assert.equal(duplicateJob?.status, "ready");
  assert.equal(duplicateJob?.attempts, 1);
  assert.equal(duplicateJob?.duplicate, true);
  const embeddingCallsAfterDuplicate = embeddingCalls;
  const globalSearch = await service.search({ query: "红色小猫" });
  assert.equal(globalSearch[0]?.stickerId, stickerId);
  const thirdChatSend = await service.send({
    conversation: { kind: "private", id: "never-observed-here" },
    stickerId
  });
  assert.equal(thirdChatSend.ok, true);
  return {
    stickerId,
    recordCount: (await store.listRecords()).length,
    embeddingCallsAfterDuplicate,
    duplicateStatus: duplicateJob?.status,
    globallySearchable: globalSearch[0]?.stickerId === stickerId,
    sendableInUnseenPrivateChat: thirdChatSend.ok
  };
}

async function verifyEmbeddingIdRebuild(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "embedding-id-rebuild-home")
  });
  const store = createStickerStore(home);
  const connector = createMockConnector();
  const createServiceForId = async (
    embeddingId: string,
    onEmbed?: () => void,
    injectedFailures = 0
  ): Promise<StickerService> => {
    const baseEmbedder = createFixtureEmbedder(embeddingId);
    let failuresRemaining = injectedFailures;
    const embedder: StickerEmbedder = {
      ...baseEmbedder,
      async embed(text, options) {
        onEmbed?.();
        if (failuresRemaining > 0) {
          failuresRemaining -= 1;
          throw new Error("fixture index-audit embedding failure");
        }
        return baseEmbedder.embed(text, options);
      }
    };
    return createStickerService({
      home,
      connector,
      store,
      logger: createStickerLogger(home),
      mediaResolver: { async resolve() { return bytes; } },
      analyzer: createFixtureAnalyzer(),
      embedder,
      vectorIndex: await createStickerVectorIndex({
        directory: home.stickerLanceDbDir,
        embeddingId
      }),
      configuredEnabled: true,
      now: createClock()
    });
  };

  const firstConfiguration = await createServiceForId("index-config-a");
  await firstConfiguration.observe(
    createStickerEvent({
      id: "embedding-id-original",
      conversationId: "embedding-id-group",
      segment: imageStickerSegment(bytes)
    })
  );
  await firstConfiguration.whenIdle();
  assert.equal(
    (await store.readRecord(stickerIdFor(bytes)))?.embedding?.id,
    stickerVectorIndexId("index-config-a")
  );

  let rebuiltEmbeddings = 0;
  const secondConfiguration = await createServiceForId(
    "index-config-b",
    () => {
      rebuiltEmbeddings += 1;
    },
    2
  );
  await secondConfiguration.whenIdle();
  const rebuilt = await store.readRecord(stickerIdFor(bytes));
  const snapshot = await secondConfiguration.snapshot();
  assert.equal(rebuilt?.status, "ready");
  assert.equal(rebuilt?.embedding?.id, stickerVectorIndexId("index-config-b"));
  assert.equal(rebuiltEmbeddings, 24);
  assert.equal(snapshot.embedding.rowCount, 12);
  assert.equal(snapshot.embedding.indexState, "ready");
  return {
    fromId: "index-config-a",
    toId: rebuilt?.embedding?.id,
    rebuiltEmbeddings,
    injectedTransientFailures: 2,
    rowCount: snapshot.embedding.rowCount,
    recordStayedReady: rebuilt?.status === "ready"
  };
}

async function verifyInvalidVectorRowIsolation(
  root: string,
  bytes: Uint8Array
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "invalid-vector-rows-home")
  });
  const store = createStickerStore(home);
  const logger = createStickerLogger(home);
  const embeddingId = "invalid-vector-rows-config";
  const baseIndex = await createStickerVectorIndex({
    directory: home.stickerLanceDbDir,
    embeddingId
  });
  const embedder = createFixtureEmbedder(embeddingId);
  const conversationId = "invalid-vector-rows-group";
  const initialService = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger,
    mediaResolver: { async resolve() { return bytes; } },
    analyzer: createFixtureAnalyzer(),
    embedder,
    vectorIndex: baseIndex,
    configuredEnabled: true,
    now: createClock()
  });
  await initialService.observe(
    createStickerEvent({
      id: "invalid-vector-ready",
      conversationId,
      segment: imageStickerSegment(bytes)
    })
  );
  await initialService.whenIdle();

  const readyStickerId = stickerIdFor(bytes);
  const readyRecord = await store.readRecord(readyStickerId);
  assert.ok(readyRecord);
  assert.equal(readyRecord.status, "ready");
  assert.ok(readyRecord.description);

  const invalidRows = 48;
  const failedRows = invalidRows / 2;
  for (let index = 0; index < invalidRows; index += 1) {
    const invalidStickerId = `stk_invalid_${String(index).padStart(3, "0")}`;
    await baseIndex.upsert([{
      rowId: stickerVectorRowId(invalidStickerId, "visual", 0),
      stickerId: invalidStickerId,
      channel: "visual",
      unitIndex: 0,
      text: `无效近邻 ${index}`,
      vector: [1, 0, 0],
      createdAt: readyRecord.createdAt
    }]);
    if (index < failedRows) {
      await store.saveRecord({
        ...readyRecord,
        id: invalidStickerId,
        status: "failed",
        lastError: "fixture failed catalog record"
      });
    }
  }
  const readyUnitCount = 2 + readyRecord.description.usage.length;
  assert.equal((await baseIndex.listRows()).length, invalidRows + readyUnitCount);

  const auditStarted = deferred();
  const releaseAudit = deferred();
  let holdAudit = true;
  const vectorIndex: StickerVectorIndex = {
    upsert: (entry) => baseIndex.upsert(entry),
    search: (input) => baseIndex.search(input),
    async listRows() {
      if (holdAudit) {
        holdAudit = false;
        auditStarted.resolve();
        await releaseAudit.promise;
      }
      return baseIndex.listRows();
    },
    listStickerIds: () => baseIndex.listStickerIds(),
    deleteRowIds: (rowIds) => baseIndex.deleteRowIds(rowIds),
    deleteStickerIds: (stickerIds) => baseIndex.deleteStickerIds(stickerIds),
    snapshot: () => baseIndex.snapshot()
  };
  const service = createStickerService({
    home,
    connector: createMockConnector(),
    store,
    logger,
    mediaResolver: { async resolve() { return bytes; } },
    analyzer: createFixtureAnalyzer(),
    embedder,
    vectorIndex,
    configuredEnabled: true,
    now: createClock()
  });

  await auditStarted.promise;
  const searchWhileDirty = await service.search({
    query: "红色开心欢迎",
    limit: 1
  });
  assert.equal(
    searchWhileDirty[0]?.stickerId,
    readyStickerId,
    "Invalid nearest neighbors must not crowd a valid ready record out of search."
  );

  releaseAudit.resolve();
  await service.whenIdle();
  const remainingStickerIds = new Set(await baseIndex.listStickerIds());
  assert.deepEqual([...remainingStickerIds], [readyStickerId]);
  const snapshot = await baseIndex.snapshot();
  assert.equal(snapshot.rowCount, readyUnitCount);
  const logText = await readFile(
    path.join(home.stickerLogsDir, "2026-07-11.jsonl"),
    "utf8"
  );
  const pruneLog = logText
    .trim()
    .split(/\r?\n/)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          data?: { requestedRows?: number; deletedRows?: number };
        }
    )
    .find((entry) => entry.type === "sticker.lancedb_pruned");
  assert.deepEqual(pruneLog?.data, {
    requestedRows: invalidRows,
    deletedRows: invalidRows,
    id: stickerVectorIndexId(embeddingId)
  });
  return {
    invalidRows,
    failedRows,
    orphanRows: invalidRows - failedRows,
    dirtyRowCount: invalidRows + readyUnitCount,
    searchWhileDirty: searchWhileDirty.map((result) => result.stickerId),
    remainingStickerIds,
    prunedRows: pruneLog?.data?.deletedRows,
    finalRowCount: snapshot.rowCount
  };
}

function createFixtureAnalyzer(): StickerAnalyzer {
  return {
    async describe() {
      return {
        description: fixtureDescription(false),
        provider: "fixture-sub-provider",
        model: "fixture-sub-model",
        promptHash: "fixture-sticker-prompt"
      };
    }
  };
}

function createFixtureEmbedder(id: string): StickerEmbedder {
  return {
    provider: "fixture-embedding-provider",
    model: "fixture-embedding-model",
    id,
    configuredDimensions: 3,
    async embed(text) {
      return {
        vector: vectorFor(text)
      };
    }
  };
}

async function verifyRuntimeStickerTranscript(input: {
  root: string;
  service: StickerService;
  connector: ReturnType<typeof createMockConnector>;
  stickerId: string;
  staticStickerId: string;
}): Promise<Record<string, unknown>> {
  const runtimeHome = path.join(input.root, "runtime-sticker-home");
  await mkdir(runtimeHome, { recursive: true });
  await writeFile(
    path.join(runtimeHome, "config.toml"),
    [
      "dreaming_enabled = false",
      "trigger_enabled = true",
      "trigger_mention_enabled = true",
      "trigger_mention_probability = 1",
      "agent_loop_exit_idle_enabled = true",
      "agent_loop_exit_idle_ms = 1",
      "sticker_recommendation_probability = 1",
      "sticker_recommendation_limit = 1",
      'bot_user_id = "fixture-bot"',
      'bot_display_name = "Sticker Bot"',
      ""
    ].join("\n"),
    "utf8"
  );
  let initialized = false;
  let running = false;
  const model: ModelClient = {
    name: "fixture-sticker-model",
    createSession() {
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
          try {
            return {
              proposedActions: [
                {
                  id: randomUUID(),
                  proposedAt: "2026-07-11T10:00:00.000Z",
                  toolName: "send_group_message",
                  reason: "Fixture sends text and receives sticker recommendations.",
                  params: {
                    groupId: context.event.conversation.id,
                    text: `[CQ:reply,id=${context.event.message.id}]蓝色角色跳舞庆祝一下`
                  }
                },
                {
                  id: randomUUID(),
                  proposedAt: "2026-07-11T10:00:00.000Z",
                  toolName: "search_sticker",
                  reason: "Fixture searches the production sticker index.",
                  params: {
                    query: "蓝色跳舞庆祝",
                    limit: 3
                  }
                },
                {
                  id: randomUUID(),
                  proposedAt: "2026-07-11T10:00:00.000Z",
                  toolName: "send_sticker",
                  reason: "Fixture selects a ready sticker.",
                  params: {
                    conversation: context.event.conversation,
                    stickerId: input.stickerId
                  }
                }
              ]
            };
          } finally {
            running = false;
          }
        },
        steer() {
          return false;
        }
      };
    }
  };
  const runtimeFailures: string[] = [];
  const runtime = await createRuntime({
    gestaltHome: runtimeHome,
    connector: input.connector,
    model,
    stickerService: input.service,
    liveEvents: {
      publish(type, data, at = new Date().toISOString()) {
        const summary = asRecord(data)?.summary;
        if (typeof summary === "string" && summary.includes("failed")) {
          runtimeFailures.push(summary);
        }
        return { id: runtimeFailures.length + 1, type, at, data };
      }
    },
    now: createClock()
  });
  const event = createStickerEvent({
    id: "runtime-send-sticker",
    conversationId: "group-b",
    segment: { type: "text", data: { text: "发一个表情" } }
  });
  event.message.text = "@Sticker Bot 发一个表情";
  event.message.rawText = event.message.text;
  event.message.mentionsBot = true;
  const turnResult = await runtime.handleEvent(event);
  await runtime.whenIdle();
  const session = runtime.exportDiagnostics({
    exportedAt: "2026-07-11T10:01:00.000Z"
  });
  const conversation = session.conversations[0];
  assert.ok(conversation);
  assert.deepEqual(runtimeFailures, [], "Runtime self-event commit must succeed.");
  const rolloutId = conversation.turns[0]?.rolloutId;
  const agentTraceId = turnResult?.traceId;
  assert.ok(rolloutId, "Sticker tool execution must belong to a rollout.");
  assert.ok(
    agentTraceId,
    "Sticker tool execution must retain its in-memory agent trace correlation."
  );
  const toolResults = conversation.turns[0]?.toolResults as Array<{
    proposal: { toolName: string };
    status: string;
    result?: { data?: unknown };
  }>;
  const searchToolResult = toolResults.find(
    (result) => result.proposal.toolName === "search_sticker"
  );
  const recommendationToolResult = toolResults.find(
    (result) => result.proposal.toolName === "send_group_message"
  );
  const sendToolResult = toolResults.find(
    (result) => result.proposal.toolName === "send_sticker"
  );
  assert.equal(searchToolResult?.status, "executed");
  assert.equal(recommendationToolResult?.status, "executed");
  const recommended = asRecord(recommendationToolResult?.result?.data)
    ?.recommended_stickers as Array<{ sticker_id: string; visual: string }>;
  assert.equal(recommended.length, 1);
  assert.ok([input.stickerId, input.staticStickerId].includes(recommended[0]!.sticker_id));
  assert.ok([DESCRIPTION_ANIMATED, DESCRIPTION_STATIC].includes(recommended[0]!.visual));
  const searched = asRecord(searchToolResult?.result?.data)
    ?.stickers as Array<{ sticker_id: string; visual: string }>;
  assert.deepEqual(
    new Set(searched.map((sticker) => sticker.sticker_id)),
    new Set([input.stickerId, input.staticStickerId])
  );
  assert.ok(searched.every((sticker) => typeof sticker.visual === "string"));
  assert.equal(sendToolResult?.status, "executed");
  assert.equal(asRecord(sendToolResult?.result?.data)?.stickerId, input.stickerId);
  const selfSticker = conversation.events.find(
    (record) =>
      record.event.sender.isSelf &&
      record.event.raw &&
      (record.event.raw as { generatedBy?: unknown }).generatedBy === "send_sticker"
  );
  assert.ok(selfSticker, "Successful send_sticker must be committed to transcript history.");
  assert.match(selfSticker.event.message.text, /^\[表情包 stk_/);
  assert.match(selfSticker.event.message.text, new RegExp(input.stickerId));
  assert.ok(selfSticker.event.message.text.includes(DESCRIPTION_ANIMATED));
  assert.equal(
    (selfSticker.event.raw as { stickerId?: unknown }).stickerId,
    input.stickerId
  );
  const stickerLog = await readFile(
    path.join(input.root, "sticker-logs", "2026-07-11.jsonl"),
    "utf8"
  );
  const correlatedSend = stickerLog
    .trim()
    .split(/\r?\n/)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          stickerId?: string;
          agentTraceId?: string;
        }
    )
    .find(
      (entry) =>
        entry.type === "sticker.send_completed" &&
        entry.stickerId === input.stickerId &&
        entry.agentTraceId === agentTraceId
    );
  assert.ok(
    correlatedSend,
    "Runtime sticker logs must correlate the tool call with its agent trace."
  );
  const correlatedSearch = stickerLog
    .trim()
    .split(/\r?\n/)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          agentTraceId?: string;
        }
    )
    .find(
      (entry) =>
        entry.type === "sticker.search_completed" &&
        entry.agentTraceId === agentTraceId
    );
  assert.ok(
    correlatedSearch,
    "Runtime sticker search logs must correlate the tool call with its agent trace."
  );
  const correlatedRecommendationSearch = stickerLog
    .trim()
    .split(/\r?\n/)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          agentTraceId?: string;
          data?: { source?: string };
        }
    )
    .find(
      (entry) =>
        entry.type === "sticker.search_completed" &&
        entry.agentTraceId === agentTraceId &&
        entry.data?.source === "recommendation"
    );
  assert.ok(
    correlatedRecommendationSearch,
    "Recommendation retrieval must be distinguishable from explicit search in logs."
  );

  let disabledRecommendationSearches = 0;
  const disabledService: StickerService = {
    ...input.service,
    async search(searchInput) {
      disabledRecommendationSearches += 1;
      return input.service.search(searchInput);
    }
  };
  const disabledConnector = createMockConnector();
  const disabledResults = await executeActions({
    connector: disabledConnector,
    proposals: [
      {
        id: "disabled-sticker-recommendation",
        proposedAt: "2026-07-11T10:02:00.000Z",
        toolName: "send_group_message",
        params: {
          groupId: "group-b",
          text: "蓝色角色跳舞庆祝一下"
        }
      }
    ],
    toolImplementations: withStickerRecommendations({
      service: disabledService,
      config: { probability: 0, limit: 3 },
      implementations: {}
    })
  });
  assert.equal(disabledResults[0]?.status, "executed");
  assert.equal(disabledResults[0]?.result?.data, undefined);
  assert.equal(disabledRecommendationSearches, 0);

  let failedRecommendationSearches = 0;
  const failingService: StickerService = {
    ...input.service,
    async search() {
      failedRecommendationSearches += 1;
      throw new Error("fixture recommendation embedding unavailable");
    }
  };
  const failureResults = await executeActions({
    connector: createMockConnector(),
    proposals: [
      {
        id: "failed-sticker-recommendation",
        proposedAt: "2026-07-11T10:03:00.000Z",
        toolName: "send_dm",
        params: {
          userId: "fixture-user",
          text: "蓝色角色跳舞庆祝一下"
        }
      }
    ],
    toolImplementations: withStickerRecommendations({
      service: failingService,
      config: { probability: 1, limit: 3 },
      implementations: {}
    })
  });
  assert.equal(failureResults[0]?.status, "executed");
  assert.equal(failureResults[0]?.result?.ok, true);
  assert.equal(failureResults[0]?.result?.data, undefined);
  assert.equal(failedRecommendationSearches, 1);
  return {
    eventCount: conversation.events.length,
    turnCount: conversation.turns.length,
    rolloutId,
    agentTraceId,
    stickerLogCorrelated: true,
    recommendationSearchLogCorrelated: true,
    recommendationToolOutput: recommendationToolResult.result?.data,
    recommendationLimit: 1,
    disabledProbabilitySearches: disabledRecommendationSearches,
    failedRecommendationSearches,
    successfulSendSurvivedRecommendationFailure: true,
    searchToolOutput: searchToolResult.result?.data,
    sendToolOutput: sendToolResult?.result?.data,
    selfStickerText: selfSticker.event.message.text,
    selfStickerId: (selfSticker.event.raw as { stickerId?: unknown }).stickerId,
    generatedBy: (selfSticker.event.raw as { generatedBy?: unknown }).generatedBy
  };
}

async function verifyRuntimeCommands(root: string): Promise<Record<string, unknown>> {
  const commandHome = path.join(root, "runtime-command-home");
  await mkdir(commandHome, { recursive: true });
  await writeFile(
    path.join(commandHome, "config.toml"),
    [
      'operator_user_ids = ["operator"]',
      "sticker_scraping_enabled = false",
      "dreaming_enabled = false",
      ""
    ].join("\n"),
    "utf8"
  );

  const commandClock = createClock();
  const connector = createMockConnector({ now: commandClock });
  let enabled = false;
  let observeCalls = 0;
  let modelSessionCreates = 0;
  const transitions: Array<{
    method: "set" | "toggle";
    enabled: boolean;
    actorUserId: string;
    sourceEventId: string;
  }> = [];
  const changeState = (
    next: boolean,
    context: Parameters<StickerService["setScrapingOverride"]>[1],
    method: "set" | "toggle"
  ): boolean => {
    enabled = next;
    transitions.push({
      method,
      enabled,
      actorUserId: context.actorUserId,
      sourceEventId: context.sourceEventId
    });
    return enabled;
  };
  const commandService: StickerService = {
    configuredEnabled: false,
    isScrapingEnabled() {
      return enabled;
    },
    async setScrapingOverride(next, context) {
      return changeState(next, context, "set");
    },
    async toggleScraping(context) {
      return changeState(!enabled, context, "toggle");
    },
    async observe() {
      observeCalls += 1;
      return 0;
    },
    async search() {
      return [];
    },
    async send() {
      return { ok: false, error: "unused command fixture" };
    },
    async manage() {
      throw new Error("The command fixture does not manage stickers.");
    },
    async snapshot() {
      return {
        available: true,
        generatedAt: commandClock().toISOString(),
        scraping: {
          configuredEnabled: false,
          runtimeOverride: enabled,
          effectiveEnabled: enabled
        },
        processing: {
          queued: 0,
          running: 0,
          failed: 0,
          ready: 0,
          duplicates: 0
        },
        embedding: {
          rowCount: 0,
          indexState: "empty",
          distanceMetric: "cosine"
        },
        jobs: [],
        catalog: {
          offset: 0,
          limit: 48,
          total: 0
        },
        stickers: []
      };
    },
    async resolveAssetPath() {
      return undefined;
    },
    async whenIdle() {
      // The command stub has no worker.
    }
  };
  const forbiddenModel: ModelClient = {
    name: "forbidden-command-model",
    createSession() {
      modelSessionCreates += 1;
      throw new Error("Runtime control commands must not create a model session.");
    }
  };
  const runtime = await createRuntime({
    gestaltHome: commandHome,
    connector,
    model: forbiddenModel,
    stickerService: commandService,
    triggers: [],
    now: commandClock
  });

  const commands = [
    createControlEvent("command-on", "operator", "/scrape-sticker on"),
    createControlEvent("command-off", "operator", "/scrape-sticker off"),
    createControlEvent("command-toggle", "operator", "/scrape-sticker"),
    createControlEvent("command-unauthorized", "stranger", "/scrape-sticker off"),
    createControlEvent("command-invalid", "operator", "/scrape-sticker maybe")
  ];
  for (const command of commands) {
    assert.equal(await runtime.handleEvent(command), undefined);
  }
  await runtime.whenIdle();

  assert.equal(enabled, true);
  assert.deepEqual(
    transitions.map((transition) => ({
      method: transition.method,
      enabled: transition.enabled,
      actorUserId: transition.actorUserId
    })),
    [
      { method: "set", enabled: true, actorUserId: "operator" },
      { method: "set", enabled: false, actorUserId: "operator" },
      { method: "toggle", enabled: true, actorUserId: "operator" }
    ]
  );
  assert.equal(observeCalls, 0);
  assert.equal(modelSessionCreates, 0);

  const acknowledgements = connector.sentGroupMessages.map(
    (message) => message.input.text
  );
  assert.deepEqual(acknowledgements, [
    "表情采集已开启",
    "表情采集已关闭",
    "表情采集已开启",
    "无权执行该命令",
    "用法：/scrape-sticker [on|off]"
  ]);
  const session = runtime.exportDiagnostics({
    exportedAt: commandClock().toISOString()
  });
  assert.equal(session.conversations.length, 1);
  const conversation = session.conversations[0];
  assert.ok(conversation);
  assert.equal(conversation.events.length, commands.length * 2);
  assert.equal(conversation.windows.length, 0);
  assert.equal(conversation.turns.length, 0);
  const steerCount = conversation.turns.reduce(
    (total, turn) => total + turn.steerCount,
    0
  );
  assert.equal(steerCount, 0);
  assert.equal(conversation.loopExits.length, 0);
  assert.equal(conversation.triggerAttempts.length, 0);
  assert.equal(
    conversation.events.filter((record) => record.event.sender.isSelf).length,
    commands.length
  );
  await writeJson("runtime-command-session.json", session);
  await writeJson("runtime-command-connector-calls.json", connector.calls);

  return {
    configuredEnabled: commandService.configuredEnabled,
    finalEnabled: enabled,
    transitions,
    acknowledgements,
    authorizedOnOffToggle: true,
    unauthorizedRejected: true,
    invalidUsageRejected: true,
    modelSessionCreates,
    observeCalls,
    eventCount: conversation.events.length,
    selfAcknowledgementEvents: commands.length,
    windows: conversation.windows.length,
    turns: conversation.turns.length,
    steers: steerCount,
    triggerAttempts: conversation.triggerAttempts.length
  };
}

async function verifyConfiguredServiceRestart(
  root: string
): Promise<Record<string, unknown>> {
  const runtimeHome = path.join(root, "configured-service-restart-home");
  await mkdir(runtimeHome, { recursive: true });
  await writeFile(
    path.join(runtimeHome, "config.toml"),
    [
      "sticker_scraping_enabled = false",
      "dreaming_enabled = false",
      'main_model_base_url = "https://models.example.test/v1"',
      'main_model_name = "fixture/main"',
      'main_model_api_key_env = "STICKER_CONFIG_MAIN_KEY"',
      'embedding_model_base_url = "https://embeddings.example.test/v1"',
      'embedding_model_name = "fixture/embedding"',
      'embedding_model_id = "fixture-embedding-space"',
      'embedding_model_api_key_env = "STICKER_CONFIG_EMBEDDING_KEY"',
      "embedding_model_dimensions = 3",
      ""
    ].join("\n"),
    "utf8"
  );
  const previousMainKey = process.env.STICKER_CONFIG_MAIN_KEY;
  const previousEmbeddingKey = process.env.STICKER_CONFIG_EMBEDDING_KEY;
  process.env.STICKER_CONFIG_MAIN_KEY = "fixture-main-key";
  process.env.STICKER_CONFIG_EMBEDDING_KEY = "fixture-embedding-key";
  try {
    const first = await createRuntime({
      gestaltHome: runtimeHome,
      connector: createMockConnector(),
      model: createMockModel(),
      now: createClock()
    });
    assert.ok(first.stickers, "Configured model roles must create the sticker service.");
    await first.whenIdle();
    assert.equal(first.stickers.configuredEnabled, false);
    assert.equal(first.stickers.isScrapingEnabled(), false);
    await first.stickers.setScrapingOverride(true, {
      actorUserId: "operator",
      sourceEventId: "runtime-override-before-restart",
      at: "2026-07-11T09:30:00.000Z"
    });
    assert.equal(first.stickers.isScrapingEnabled(), true);

    const restarted = await createRuntime({
      gestaltHome: runtimeHome,
      connector: createMockConnector(),
      model: createMockModel(),
      now: createClock()
    });
    assert.ok(restarted.stickers);
    await restarted.whenIdle();
    const restartedSnapshot = await restarted.stickers.snapshot();
    assert.equal(restartedSnapshot.scraping.configuredEnabled, false);
    assert.equal(restartedSnapshot.scraping.runtimeOverride, undefined);
    assert.equal(restartedSnapshot.scraping.effectiveEnabled, false);
    return {
      serviceCreatedFromConfig: true,
      configuredEnabled: restarted.stickers.configuredEnabled,
      firstRuntimeOverride: true,
      restartedRuntimeOverride: restartedSnapshot.scraping.runtimeOverride,
      restartedEffectiveEnabled: restartedSnapshot.scraping.effectiveEnabled
    };
  } finally {
    restoreEnvironmentVariable(
      "STICKER_CONFIG_MAIN_KEY",
      previousMainKey
    );
    restoreEnvironmentVariable(
      "STICKER_CONFIG_EMBEDDING_KEY",
      previousEmbeddingKey
    );
  }
}

async function verifyLoggerPrivacy(
  root: string
): Promise<Record<string, unknown>> {
  const home = await resolveGestaltHome({
    homePath: path.join(root, "logger-privacy-home")
  });
  const privacyLogger = createStickerLogger(home);
  await privacyLogger.append({
    type: "sticker.privacy_probe",
    at: "2026-07-11T09:45:00.000Z",
    data: {
      emoji_id: "LOGGER_EMOJI_SECRET",
      emoji_package_id: "LOGGER_PACKAGE_SECRET",
      key: "LOGGER_MFACE_KEY_SECRET",
      url: "https://stickers.example.test/a.gif?signature=LOGGER_URL_SECRET",
      path: "C:\\private\\LOGGER_PATH_SECRET.gif",
      file: "base64://TE9HR0VSX0JBU0U2NF9TRUNSRVQ=",
      vector: [0.1, 0.2, 0.3],
      api_key: "LOGGER_API_KEY_SECRET",
      diagnostic:
        "failed at \\\\server\\share\\LOGGER_UNC_ONLY_SECRET.gif",
      spacedPathDiagnostic:
        "EACCES opening 'C:\\Users\\John Doe\\LOGGER_SPACE_PATH_SECRET.gif'",
      error:
        "Authorization: Bearer LOGGER_BEARER_SECRET failed at \\\\server\\share\\LOGGER_UNC_SECRET.gif\nAuthorization: token LOGGER_AUTH_SCHEME_SECRET"
    }
  });
  await privacyLogger.append({
    type: "sticker.privacy_probe_nested",
    at: "2026-07-11T09:45:01.000Z",
    data: {
      payload: {
        type: "mface",
        data: {
          key: "LOGGER_NESTED_KEY_SECRET",
          emoji_id: "LOGGER_NESTED_EMOJI_SECRET"
        }
      }
    }
  });
  await privacyLogger.append({
    type: "sticker.privacy_probe_url_only",
    at: "2026-07-11T09:45:02.000Z",
    data: {
      url: "https://stickers.example.test/LOGGER_URL_ONLY_SECRET.gif",
      query: "find https://stickers.example.test/LOGGER_QUERY_URL_SECRET.gif"
    }
  });
  const text = await readFile(
    path.join(home.stickerLogsDir, "2026-07-11.jsonl"),
    "utf8"
  );
  for (const secret of [
    "LOGGER_EMOJI_SECRET",
    "LOGGER_PACKAGE_SECRET",
    "LOGGER_MFACE_KEY_SECRET",
    "LOGGER_URL_SECRET",
    "LOGGER_PATH_SECRET",
    "LOGGER_BASE64_SECRET",
    "LOGGER_API_KEY_SECRET",
    "LOGGER_BEARER_SECRET",
    "LOGGER_UNC_SECRET",
    "LOGGER_UNC_ONLY_SECRET",
    "LOGGER_SPACE_PATH_SECRET",
    "LOGGER_AUTH_SCHEME_SECRET",
    "LOGGER_NESTED_KEY_SECRET",
    "LOGGER_NESTED_EMOJI_SECRET",
    "LOGGER_URL_ONLY_SECRET",
    "LOGGER_QUERY_URL_SECRET",
    '"vector"'
  ]) {
    assert.equal(text.includes(secret), false, `Logger leaked ${secret}.`);
  }
  return {
    transportFieldsRemoved: true,
    base64Removed: true,
    vectorRemoved: true,
    apiKeyRemoved: true,
    persistedEntries: text
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
  };
}

function createControlEvent(
  id: string,
  senderId: string,
  text: string
): MessageReceivedEvent {
  return {
    id,
    type: "MessageReceived",
    occurredAt: "2026-07-11T09:00:00.000Z",
    source: {
      platform: "qq",
      connector: "onebot-v11",
      accountId: "fixture-bot"
    },
    conversation: {
      kind: "group",
      id: "command-group"
    },
    sender: {
      id: senderId
    },
    message: {
      id: `message-${id}`,
      text,
      rawText: text,
      mentionsBot: false
    }
  };
}

function verifyClassification(staticFixture: Uint8Array): Record<string, unknown> {
  const imageSubtypeOne = classifyStickerSegment({
    type: "image",
    data: { file: dataUrl(staticFixture), sub_type: 1 }
  });
  const imageSubtypeZero = classifyStickerSegment({
    type: "image",
    data: { file: dataUrl(staticFixture), sub_type: 0 }
  });
  const directMface = classifyStickerSegment({
    type: "mface",
    data: { emoji_id: "direct", emoji_package_id: "fixture" }
  });
  const compatibilityMface = classifyStickerSegment({
    type: "image",
    data: {
      file: "marketface",
      emoji_id: "compat",
      emoji_package_id: "fixture"
    }
  });
  assert.equal(imageSubtypeOne, "image");
  assert.equal(imageSubtypeZero, undefined);
  assert.equal(directMface, "mface");
  assert.equal(compatibilityMface, "mface");
  return {
    imageSubtypeOne: imageSubtypeOne ?? null,
    imageSubtypeZero: imageSubtypeZero ?? null,
    directMface: directMface ?? null,
    compatibilityMface: compatibilityMface ?? null
  };
}

function verifyStickerRecommendationConfiguration(): Record<string, unknown> {
  const emptyConfig: GestaltConfig = {
    path: "fixture-config.toml",
    raw: "",
    flatValues: {}
  };
  const defaults = readStickerRecommendationConfig(emptyConfig);
  assert.deepEqual(defaults, { probability: 0, limit: 3 });

  const configured = readStickerRecommendationConfig({
    ...emptyConfig,
    flatValues: {
      sticker_recommendation_probability: 0.35,
      sticker_recommendation_limit: 7
    }
  });
  assert.deepEqual(configured, { probability: 0.35, limit: 7 });
  return { defaults, configured };
}

function onlyObservation(event: MessageReceivedEvent): StickerObservation {
  const observations = extractStickerObservations(event);
  assert.equal(observations.length, 1);
  return observations[0] as StickerObservation;
}

function createStickerEvent(input: {
  id: string;
  conversationId: string;
  segment: { type: string; data: Record<string, unknown> };
}): MessageReceivedEvent {
  return {
    id: input.id,
    type: "MessageReceived",
    occurredAt: "2026-07-11T08:00:00.000Z",
    source: {
      platform: "qq",
      connector: "onebot-v11"
    },
    conversation: {
      kind: "group",
      id: input.conversationId
    },
    sender: {
      id: "fixture-user"
    },
    message: {
      id: `message-${input.id}`,
      text: "[表情]",
      rawText: "[表情]",
      mentionsBot: false,
      sourceContent: {
        format: "onebot-v11",
        segments: [input.segment]
      }
    }
  };
}

function imageStickerSegment(bytes: Uint8Array): {
  type: "image";
  data: Record<string, unknown>;
} {
  return {
    type: "image",
    data: {
      file: dataUrl(bytes),
      sub_type: 1,
      summary: "[动画表情]"
    }
  };
}

function mfaceSegment(bytes: Uint8Array): {
  type: "mface";
  data: Record<string, unknown>;
} {
  return {
    type: "mface",
    data: {
      url: dataUrl(bytes),
      emoji_id: "emoji-red-cat",
      emoji_package_id: "package-fixture",
      key: "fixture-secret-key",
      summary: "[动画表情]"
    }
  };
}

function dataUrl(bytes: Uint8Array): string {
  return `base64://${Buffer.from(bytes).toString("base64")}`;
}

function stickerIdFor(bytes: Uint8Array): string {
  return stickerIdFromSha256(
    createHash("sha256").update(bytes).digest("hex")
  );
}

function vectorFor(text: string): number[] {
  if (text.includes("蓝") || /blue/i.test(text)) {
    return [0, 1, 0];
  }
  if (text.includes("红") || /red/i.test(text)) {
    return [1, 0, 0];
  }
  return [0, 0, 1];
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function waitForHarness(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function createStaticFixture(): Promise<Buffer> {
  return sharp({
    create: {
      width: 48,
      height: 32,
      channels: 4,
      background: { r: 220, g: 42, b: 54, alpha: 1 }
    }
  })
    .png()
    .toBuffer();
}

async function createAnimatedFixture(): Promise<Buffer> {
  const width = 16;
  const height = 12;
  const frameCount = 20;
  const pixels = Buffer.alloc(width * height * frameCount * 4);
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const offset = (frame * width * height + pixel) * 4;
      pixels[offset] = (frame * 7) % 255;
      pixels[offset + 1] = (pixel + frame * 3) % 96;
      pixels[offset + 2] = 220;
      pixels[offset + 3] = 255;
    }
  }
  return sharp(pixels, {
    raw: {
      width,
      height: height * frameCount,
      channels: 4,
      pageHeight: height
    }
  })
    .gif({
      loop: 0,
      delay: Array.from({ length: frameCount }, (_, index) => 40 + index * 10)
    })
    .toBuffer();
}

function createClock(): () => Date {
  let tick = 0;
  return () => new Date(BASE_TIME + tick++ * 1_000);
}

function deferred(): {
  promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise();
    }
  };
}

async function listFiles(root: string): Promise<Array<{
  path: string;
  bytes: number;
}>> {
  const output: Array<{ path: string; bytes: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        output.push({
          path: path.relative(root, absolute).split(path.sep).join("/"),
          bytes: (await stat(absolute)).size
        });
      }
    }
  };
  await visit(root);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function restoreEnvironmentVariable(
  name: string,
  previous: string | undefined
): void {
  if (previous === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previous;
  }
}

async function writeJson(fileName: string, value: unknown): Promise<void> {
  await writeArtifactJson(path.join(artifactDir, fileName), value);
}
