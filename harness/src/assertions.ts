import assert from "node:assert/strict";
import type { ReplayRunResult } from "./replayRunner";

export function assertReplayRun(result: ReplayRunResult): void {
  assertSession(result);
  assertAction(result);
  assertTools(result);
  assertModelInput(result);
  assertModelExchange(result);
  assertPromptCache(result);
  assertRollout(result);
  assertMemory(result);
}

function assertSession(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.session;
  if (!expected) {
    return;
  }

  assert.equal(
    result.session.conversations.length,
    expected.conversations ?? result.session.conversations.length
  );

  const conversation = result.session.conversations[0];
  assert.ok(conversation, "expected at least one conversation in session export");

  if (expected.events !== undefined) {
    assert.equal(conversation.events.length, expected.events);
  }
  if (expected.selfMessages !== undefined) {
    assert.equal(
      conversation.events.filter((record) => isSelfMessageEvent(record.event))
        .length,
      expected.selfMessages
    );
  }
  if (expected.windows !== undefined) {
    assert.equal(conversation.windows.length, expected.windows);
  }
  if (expected.turns !== undefined) {
    assert.equal(conversation.turns.length, expected.turns);
  }
  if (expected.triggerAttempts !== undefined) {
    assert.equal(conversation.triggerAttempts.length, expected.triggerAttempts);
  }
  if (expected.triggerAttemptReasons !== undefined) {
    assert.deepEqual(
      conversation.triggerAttempts.map((attempt) => attempt.reason),
      expected.triggerAttemptReasons
    );
  }
  if (expected.triggerAttemptProbabilities !== undefined) {
    assert.deepEqual(
      conversation.triggerAttempts.map((attempt) => attempt.probability),
      expected.triggerAttemptProbabilities
    );
  }
  if (expected.triggerAttemptAdmissions !== undefined) {
    assert.deepEqual(
      conversation.triggerAttempts.map((attempt) => attempt.admitted),
      expected.triggerAttemptAdmissions
    );
  }
  if (expected.loopExits !== undefined) {
    assert.equal(conversation.loopExits.length, expected.loopExits);
  }
  if (expected.loopExitReasons !== undefined) {
    assert.deepEqual(
      conversation.loopExits.map((exit) => exit.reason),
      expected.loopExitReasons
    );
  }

  if (expected.journalRecords !== undefined) {
    assert.equal(result.sessionJournal.length, expected.journalRecords);
  }
  if (expected.minJournalRecords !== undefined) {
    assert.ok(
      result.sessionJournal.length >= expected.minJournalRecords,
      `expected at least ${expected.minJournalRecords} session journal records, got ${result.sessionJournal.length}`
    );
  }
  if (expected.journalRecords !== undefined || expected.minJournalRecords !== undefined) {
    assert.ok(
      result.homeAfter.files.some(
        (file) =>
          file.path.startsWith("sessions/journal/") &&
          file.path.endsWith("/000001.jsonl")
      ),
      "expected home-after to include the append-only session journal"
    );
  }

  const turn = conversation.turns[0];
  if (!turn) {
    return;
  }

  if (expected.turnStatus !== undefined) {
    assert.equal(turn.status, expected.turnStatus);
  }
  if (expected.steerCount !== undefined) {
    assert.equal(turn.steerCount, expected.steerCount);
  }
  if (expected.steerCounts !== undefined) {
    assert.deepEqual(
      conversation.turns.map((candidate) => candidate.steerCount),
      expected.steerCounts
    );
  }
  if (expected.eventIds !== undefined) {
    assert.deepEqual(turn.eventIds, expected.eventIds);
  }
  if (expected.turnEventIds !== undefined) {
    assert.deepEqual(
      conversation.turns.map((candidate) => candidate.eventIds),
      expected.turnEventIds
    );
  }
  if (expected.windowReasons !== undefined) {
    assert.deepEqual(
      conversation.windows.map((window) => window.reason),
      expected.windowReasons
    );
  }
  if (expected.windowEventIds !== undefined) {
    assert.deepEqual(
      conversation.windows.map((window) => window.eventIds),
      expected.windowEventIds
    );
  }
  if (expected.phases !== undefined) {
    assert.deepEqual(
      turn.phases.map((phase) => phase.phase),
      expected.phases
    );
  }
}

function assertAction(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.action;
  if (!expected) {
    return;
  }

  const actions = result.session.conversations[0]?.turns[0]?.proposedActions ?? [];
  assert.ok(
    actions.length > 0,
    "expected at least one proposed action in exported session"
  );

  if (expected.toolName !== undefined) {
    const firstAction = actions[0];
    assert.ok(firstAction, "expected first proposed action in exported session");
    assert.equal(firstAction.toolName, expected.toolName);
  }
  if (expected.toolNames !== undefined) {
    assert.deepEqual(
      actions.map((candidate) => candidate.toolName),
      expected.toolNames
    );
  }
  const actionToolNames = actions.map((candidate) => candidate.toolName);
  for (const toolName of expected.toolNamesInclude ?? []) {
    assert.ok(
      actionToolNames.some((candidate) => candidate === toolName),
      `missing proposed action ${toolName}`
    );
  }

  const selectedAction =
    expected.toolName !== undefined
      ? actions.find((candidate) => candidate.toolName === expected.toolName)
      : actions[0];
  assert.ok(selectedAction, "expected an action matching fixture expectation");

  if (selectedAction.toolName === "send_group_message") {
    if (expected.groupId !== undefined) {
      assert.equal(selectedAction.params.groupId, expected.groupId);
    }
    if (expected.textMinLength !== undefined) {
      assert.ok(selectedAction.params.text.length >= expected.textMinLength);
    }
    if (expected.textMaxLength !== undefined) {
      assert.ok(selectedAction.params.text.length <= expected.textMaxLength);
    }
    if (expected.textDoesNotMatch !== undefined) {
      assert.doesNotMatch(
        selectedAction.params.text,
        new RegExp(expected.textDoesNotMatch)
      );
    }
  }
}

function assertTools(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.tools;
  if (!expected) {
    return;
  }

  if (expected.calls !== undefined) {
    assert.equal(result.mockTools.calls.length, expected.calls);
  }
  if (expected.toolNames !== undefined) {
    assert.deepEqual(
      result.mockTools.calls.map((call) => call.toolName),
      expected.toolNames
    );
  }
  const executedToolNames = result.mockTools.calls.map((call) => call.toolName);
  for (const toolName of expected.toolNamesInclude ?? []) {
    assert.ok(
      executedToolNames.some((candidate) => candidate === toolName),
      `missing executed tool ${toolName}`
    );
  }
  if (expected.connectorSideEffects !== undefined) {
    const connectorCalls =
      "calls" in result.connector && Array.isArray(result.connector.calls)
        ? result.connector.calls.length
        : result.connector.sentGroupMessages.length;
    assert.equal(
      connectorCalls,
      expected.connectorSideEffects
    );
  }
}

function assertModelInput(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.modelInput;
  if (!expected) {
    return;
  }

  if (expected.requests !== undefined) {
    assert.equal(result.modelRequests.length, expected.requests);
  }

  if (result.modelRequests.length === 0) {
    if ((expected.contains?.length ?? 0) > 0 || (expected.tools?.length ?? 0) > 0) {
      assert.fail("expected at least one captured model request");
    }
    return;
  }

  const allContent = result.modelRequests
    .flatMap((request) =>
      request.messages.map((message) => modelContentText(message.content))
    )
    .join("\n");
  for (const pattern of expected.contains ?? []) {
    assert.match(allContent, new RegExp(escapeRegExp(pattern)));
  }
  for (const pattern of expected.doesNotContain ?? []) {
    assert.doesNotMatch(allContent, new RegExp(escapeRegExp(pattern)));
  }

  const requestToolNames = result.modelRequests.flatMap((request) =>
    request.tools ?? []
  );
  for (const toolName of expected.tools ?? []) {
    assert.ok(
      requestToolNames.includes(toolName),
      `expected model request tools to include ${toolName}`
    );
  }
}

function assertModelExchange(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.modelExchange;
  if (!expected) {
    return;
  }

  if (expected.exchanges !== undefined) {
    assert.equal(result.modelExchanges.length, expected.exchanges);
  }
  if (expected.minExchanges !== undefined) {
    assert.ok(
      result.modelExchanges.length >= expected.minExchanges,
      `expected at least ${expected.minExchanges} model exchanges`
    );
  }

  if (expected.responses !== undefined) {
    assert.equal(
      result.modelExchanges.filter((exchange) => exchange.response).length,
      expected.responses
    );
  }
  if (expected.minResponses !== undefined) {
    assert.ok(
      result.modelExchanges.filter((exchange) => exchange.response).length >=
        expected.minResponses,
      `expected at least ${expected.minResponses} model responses`
    );
  }
  if (expected.maxToolCallsPerResponse !== undefined) {
    for (const [index, exchange] of result.modelExchanges.entries()) {
      const toolCallCount = exchange.response?.toolCalls?.length ?? 0;
      assert.ok(
        toolCallCount <= expected.maxToolCallsPerResponse,
        `expected model exchange ${index} to include at most ${expected.maxToolCallsPerResponse} tool calls, got ${toolCallCount}`
      );
    }
  }

  if (expected.purposes !== undefined) {
    assert.deepEqual(
      result.modelExchanges.map((exchange) => exchange.purpose),
      expected.purposes
    );
  }
  for (const purpose of expected.purposeIncludes ?? []) {
    assert.ok(
      result.modelExchanges.some((exchange) => exchange.purpose === purpose),
      `expected model exchanges to include purpose ${purpose}`
    );
  }

  const responseText = result.modelExchanges
    .map((exchange) =>
      [
        exchange.response?.content ?? "",
        JSON.stringify(exchange.response?.toolCalls ?? []),
        JSON.stringify(exchange.response?.toolResults ?? [])
      ].join("\n")
    )
    .join("\n");
  for (const pattern of expected.responseContains ?? []) {
    assert.match(responseText, new RegExp(escapeRegExp(pattern)));
  }
  for (const pattern of expected.responseDoesNotContain ?? []) {
    assert.doesNotMatch(responseText, new RegExp(escapeRegExp(pattern)));
  }
}

function assertPromptCache(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.promptCache;
  if (!expected) {
    return;
  }
  const scopedExchanges = expected.includeDreaming
    ? result.modelExchanges
    : result.modelExchanges.filter(
        (exchange) => exchange.purpose === "agent_action"
      );
  const requests = scopedExchanges.map((exchange) => exchange.request);
  assert.ok(requests.length > 1, "expected multiple model requests for cache verification");

  if (expected.enabled !== undefined) {
    assert.equal(
      requests.every(
        (request) => request.promptCacheEnabled === expected.enabled
      ),
      true,
      `expected prompt cache enabled=${expected.enabled} on every agent request`
    );
  }

  if (expected.singleSession) {
    const sessionIds = new Set(requests.map((request) => request.sessionId));
    assert.equal(sessionIds.size, 1, "expected one stable model session id");
    assert.ok(requests[0]?.sessionId, "expected a non-empty model session id");
  }

  if (expected.singleSystemMessage) {
    for (const [index, request] of requests.entries()) {
      assert.equal(
        request.messages.filter((message) => message.role === "system").length,
        1,
        `request ${index} should contain exactly one stable system/persona message`
      );
    }
  }

  if (expected.appendOnly) {
    for (let index = 1; index < requests.length; index += 1) {
      const previous = requests[index - 1];
      const current = requests[index];
      assert.ok(previous && current);
      assert.ok(
        current.messages.length >= previous.messages.length,
        `request ${index} shortened the message history`
      );
      assert.deepEqual(
        current.messages.slice(0, previous.messages.length),
        previous.messages,
        `request ${index} did not preserve the exact previous message prefix`
      );
    }
  }

  if (expected.terminalDreamingContinuation) {
    assertTerminalDreamingContinuation(result);
  }

  const completed = scopedExchanges.filter((exchange) => exchange.response);
  if (expected.requestBodyEnabled) {
    for (const [index, exchange] of completed.entries()) {
      const body = parseRequestBody(exchange.response?.requestBody);
      assert.equal(
        readNestedString(body, "cache_control", "type"),
        "ephemeral",
        `model response ${index} request body did not enable prompt caching`
      );
      assert.equal(
        body.session_id,
        exchange.request.sessionId,
        `model response ${index} request body used a different session id`
      );
    }
  }

  const cacheReads = completed.map(
    (exchange) => exchange.response?.cacheUsage?.readTokens ?? 0
  );
  const hitResponses = cacheReads.filter((tokens) => tokens > 0).length;
  const readTokens = cacheReads.reduce((total, tokens) => total + tokens, 0);
  if (expected.minHitResponses !== undefined) {
    assert.ok(
      hitResponses >= expected.minHitResponses,
      `expected at least ${expected.minHitResponses} OpenRouter cache-hit responses, got ${hitResponses}`
    );
  }
  if (expected.minReadTokens !== undefined) {
    assert.ok(
      readTokens >= expected.minReadTokens,
      `expected at least ${expected.minReadTokens} OpenRouter cache-read tokens, got ${readTokens}`
    );
  }

  const completedDreaming = result.modelExchanges.filter(
    (exchange) => exchange.purpose === "dreaming" && exchange.response
  );
  const dreamingCacheReads = completedDreaming.map(
    (exchange) => exchange.response?.cacheUsage?.readTokens ?? 0
  );
  const dreamingHitResponses = dreamingCacheReads.filter(
    (tokens) => tokens > 0
  ).length;
  const dreamingReadTokens = dreamingCacheReads.reduce(
    (total, tokens) => total + tokens,
    0
  );
  if (expected.minFirstDreamingReadTokens !== undefined) {
    const firstDreamingReadTokens = dreamingCacheReads[0] ?? 0;
    assert.ok(
      firstDreamingReadTokens >= expected.minFirstDreamingReadTokens,
      `expected the first dreaming response to read at least ${expected.minFirstDreamingReadTokens} cached tokens from the action prefix, got ${firstDreamingReadTokens}`
    );
  }
  if (expected.minDreamingHitResponses !== undefined) {
    assert.ok(
      dreamingHitResponses >= expected.minDreamingHitResponses,
      `expected at least ${expected.minDreamingHitResponses} dreaming cache-hit responses, got ${dreamingHitResponses}`
    );
  }
  if (expected.minDreamingReadTokens !== undefined) {
    assert.ok(
      dreamingReadTokens >= expected.minDreamingReadTokens,
      `expected at least ${expected.minDreamingReadTokens} dreaming cache-read tokens, got ${dreamingReadTokens}`
    );
  }
}

function assertTerminalDreamingContinuation(result: ReplayRunResult): void {
  const lastAgentRequest = result.modelExchanges
    .filter((exchange) => exchange.purpose === "agent_action")
    .at(-1)?.request;
  const firstDreamingRequest = result.modelExchanges.find(
    (exchange) => exchange.purpose === "dreaming"
  )?.request;
  assert.ok(lastAgentRequest, "expected an agent request before dreaming");
  assert.ok(firstDreamingRequest, "expected a dreaming request");
  assert.deepEqual(
    firstDreamingRequest.messages.slice(0, lastAgentRequest.messages.length),
    lastAgentRequest.messages,
    "dreaming did not preserve the exact agent request prefix"
  );
  assert.ok(
    firstDreamingRequest.messages.length > lastAgentRequest.messages.length,
    "dreaming did not append to the agent message history"
  );
  assert.deepEqual(
    firstDreamingRequest.tools,
    lastAgentRequest.tools,
    "dreaming changed the provider tool protocol and invalidated the cache prefix"
  );
  assert.deepEqual(
    firstDreamingRequest.tools.slice(-2),
    ["bash", "finish_dreaming"],
    "stable tool protocol is missing the terminal dreaming tools"
  );
  const terminalMessage = firstDreamingRequest.messages.at(-1);
  assert.equal(terminalMessage?.role, "user");
  assert.match(
    modelContentText(terminalMessage?.content),
    /Now you are dreaming\./
  );
  assert.doesNotMatch(
    modelContentText(terminalMessage?.content),
    /Turn transcript:|Agent proposed actions:|Tool results:|Injected memory:/,
    "dreaming repeated context that already exists in the session prefix"
  );
}

function modelContentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? String(value);
}

function parseRequestBody(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

function readNestedString(
  value: Record<string, unknown>,
  objectKey: string,
  valueKey: string
): string | undefined {
  const nested = value[objectKey];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) {
    return undefined;
  }
  const candidate = (nested as Record<string, unknown>)[valueKey];
  return typeof candidate === "string" ? candidate : undefined;
}

function assertRollout(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.rollout;
  if (!expected) {
    return;
  }

  if (expected.rollouts !== undefined) {
    assert.equal(result.rollouts.length, expected.rollouts);
  }

  const records = result.rollouts.flatMap((rollout) => rollout.records);
  if (expected.recordTypes !== undefined) {
    for (const recordType of expected.recordTypes) {
      assert.ok(
        records.some((record) => record.type === recordType),
        `missing rollout record type ${recordType}`
      );
    }
  }
  const spanNames = records
    .filter((record) => record.type === "span_completed")
    .map((record) => record.name);
  for (const spanName of expected.spans ?? []) {
    assert.ok(spanNames.includes(spanName), `missing rollout span ${spanName}`);
  }
  const tracedToolNames = records
    .filter((record) => record.type === "tool_completed")
    .map((record) => record.toolName);
  if (expected.toolNames !== undefined) {
    assert.deepEqual(tracedToolNames, expected.toolNames);
  }
  for (const toolName of expected.toolNamesInclude ?? []) {
    assert.ok(tracedToolNames.includes(toolName), `missing traced tool ${toolName}`);
  }
  const tracedModelResponses = records
    .flatMap((record) =>
      record.type === "message_committed" &&
      (record.source === "assistant" || record.source === "tool")
        ? [JSON.stringify(record.message.content)]
        : []
    )
    .join("\n");
  for (const pattern of expected.modelResponseContains ?? []) {
    assert.match(tracedModelResponses, new RegExp(escapeRegExp(pattern)));
  }
  for (const pattern of expected.modelResponseDoesNotContain ?? []) {
    assert.doesNotMatch(tracedModelResponses, new RegExp(escapeRegExp(pattern)));
  }
}

function assertMemory(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.memory;
  if (!expected) {
    return;
  }

  for (const fileExpectation of expected.homeBeforeContains ?? []) {
    assertHomeSnapshotContains(
      result.homeBefore,
      fileExpectation.path,
      fileExpectation.contains,
      "home-before"
    );
  }

  for (const fileExpectation of expected.homeAfterContains ?? []) {
    assertHomeSnapshotContains(
      result.homeAfter,
      fileExpectation.path,
      fileExpectation.contains,
      "home-after"
    );
  }

  for (const fileExpectation of expected.homeAfterDoesNotContain ?? []) {
    assertHomeSnapshotDoesNotContain(
      result.homeAfter,
      fileExpectation.path,
      fileExpectation.contains,
      "home-after"
    );
  }

  const rolloutSpans = result.rollouts
    .flatMap((rollout) => rollout.records)
    .filter((record) => record.type === "span_completed");
  const dreamSpan = rolloutSpans.find((span) => span.name === "dream.run");
  const memoryInjectSpan = rolloutSpans.find(
    (span) => span.name === "memory.inject"
  );
  assert.ok(memoryInjectSpan, "expected a memory.inject trace span");

  const memoryAttributes = readRecord(memoryInjectSpan.attributes);
  const injectedMemoryFiles = Array.isArray(memoryAttributes.memoryFiles)
    ? memoryAttributes.memoryFiles
    : [];
  const injectedMemoryText = JSON.stringify(injectedMemoryFiles);
  for (const expectedPath of expected.injectedMemoryPaths ?? []) {
    assert.match(injectedMemoryText, new RegExp(escapeRegExp(expectedPath)));
  }
  for (const expectedContent of expected.injectedMemoryContains ?? []) {
    assert.match(injectedMemoryText, new RegExp(escapeRegExp(expectedContent)));
  }

  assert.ok(dreamSpan, "expected a dream.run trace span");

  const dreamAttributes = readRecord(dreamSpan.attributes);
  const commands = Array.isArray(dreamAttributes.commands)
    ? dreamAttributes.commands
    : [];
  const commandText = commands
    .map((command) =>
      command &&
      typeof command === "object" &&
      "command" in command &&
      typeof command.command === "string"
        ? command.command
        : ""
    )
    .join("\n");

  for (const expectedCommand of expected.dreamCommandsContain ?? []) {
    assert.match(commandText, new RegExp(escapeRegExp(expectedCommand)));
  }

  assertStringArrayAttributeIncludes(
    dreamAttributes.addedFiles,
    expected.dreamAddedFiles ?? [],
    "dream.run addedFiles"
  );
  assertStringArrayAttributeIncludes(
    dreamAttributes.changedFiles,
    expected.dreamChangedFiles ?? [],
    "dream.run changedFiles"
  );
}

function assertHomeSnapshotContains(
  snapshot: ReplayRunResult["homeBefore"],
  filePath: string,
  expectedContent: string,
  label: string
): void {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `expected ${label} to include ${filePath}`);
  assert.match(file.content ?? "", new RegExp(escapeRegExp(expectedContent)));
}

function assertHomeSnapshotDoesNotContain(
  snapshot: ReplayRunResult["homeBefore"],
  filePath: string,
  unexpectedContent: string,
  label: string
): void {
  const file = snapshot.files.find((candidate) => candidate.path === filePath);
  assert.ok(file, `expected ${label} to include ${filePath}`);
  assert.doesNotMatch(
    file.content ?? "",
    new RegExp(escapeRegExp(unexpectedContent))
  );
}

function assertStringArrayAttributeIncludes(
  value: unknown,
  expectedValues: string[],
  label: string
): void {
  if (expectedValues.length === 0) {
    return;
  }

  assert.ok(Array.isArray(value), `expected ${label} to be an array`);
  for (const expectedValue of expectedValues) {
    assert.ok(
      value.includes(expectedValue),
      `expected ${label} to include ${expectedValue}`
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isSelfMessageEvent(
  event: ReplayRunResult["session"]["conversations"][number]["events"][number]["event"]
): boolean {
  return (
    event.type === "MessageReceived" &&
    (event.sender.isSelf === true ||
      (event.source.accountId !== undefined &&
        event.sender.id === event.source.accountId))
  );
}
