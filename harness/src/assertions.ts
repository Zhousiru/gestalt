import assert from "node:assert/strict";
import type { ReplayRunResult } from "./replayRunner";

export function assertReplayRun(result: ReplayRunResult): void {
  assertSession(result);
  assertAction(result);
  assertTools(result);
  assertModelInput(result);
  assertModelExchange(result);
  assertTrace(result);
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

  if (expected.nextSeq !== undefined) {
    assert.equal(conversation.nextSeq, expected.nextSeq);
  }
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
  if (expected.loopExits !== undefined) {
    assert.equal(conversation.loopExits.length, expected.loopExits);
  }
  if (expected.loopExitReasons !== undefined) {
    assert.deepEqual(
      conversation.loopExits.map((exit) => exit.reason),
      expected.loopExitReasons
    );
  }

  if (expected.realtimeExports !== undefined) {
    assert.equal(result.sessionExports.length, expected.realtimeExports);
  }
  if (expected.minRealtimeExports !== undefined) {
    assert.ok(
      result.sessionExports.length >= expected.minRealtimeExports,
      `expected at least ${expected.minRealtimeExports} realtime session exports, got ${result.sessionExports.length}`
    );
  }
  if (
    expected.realtimeExports !== undefined ||
    expected.minRealtimeExports !== undefined ||
    expected.finalRealtimeExportMatches === true
  ) {
    assert.ok(
      result.homeAfter.files.some(
        (file) =>
          file.path.startsWith("sessions/") && file.path.endsWith(".jsonl")
      ),
      "expected home-after to include a rotated realtime session export"
    );
  }
  if (expected.finalRealtimeExportMatches === true) {
    const lastExport = result.sessionExports.at(-1);
    assert.ok(lastExport, "expected at least one realtime session export");
    assert.deepEqual(lastExport.conversations, result.session.conversations);
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
  if (expected.eventSeqs !== undefined) {
    assert.deepEqual(turn.eventSeqs, expected.eventSeqs);
  }
  if (expected.turnEventSeqs !== undefined) {
    assert.deepEqual(
      conversation.turns.map((candidate) => candidate.eventSeqs),
      expected.turnEventSeqs
    );
  }
  if (expected.windowReasons !== undefined) {
    assert.deepEqual(
      conversation.windows.map((window) => window.reason),
      expected.windowReasons
    );
  }
  if (expected.windowEventSeqs !== undefined) {
    assert.deepEqual(
      conversation.windows.map((window) => window.eventSeqs),
      expected.windowEventSeqs
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
      request.messages.map((message) => message.content ?? "")
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
}

function assertTrace(result: ReplayRunResult): void {
  const expected = result.fixture.expectations.trace;
  if (!expected) {
    return;
  }

  if (expected.traces !== undefined) {
    assert.equal(result.traces.length, expected.traces);
  }

  const spanNames = result.traces.flatMap((trace) =>
    trace.spans.map((span) => span.name)
  );
  for (const spanName of expected.spans ?? []) {
    assert.ok(spanNames.includes(spanName), `missing trace span ${spanName}`);
  }
  if (expected.toolNames !== undefined) {
    const tracedToolNames = result.traces
      .flatMap((trace) => trace.spans)
      .filter((span) => span.name === "tool.execute")
      .flatMap((span) => {
        const toolCalls = span.attributes.toolCalls;
        return Array.isArray(toolCalls)
          ? toolCalls.map(readToolCallName).filter((name): name is string => Boolean(name))
          : [];
      });
    assert.deepEqual(tracedToolNames, expected.toolNames);
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

  const dreamSpan = result.traces
    .flatMap((trace) => trace.spans)
    .find((span) => span.name === "dream.run");
  const memoryInjectSpan = result.traces
    .flatMap((trace) => trace.spans)
    .find((span) => span.name === "memory.inject");
  assert.ok(memoryInjectSpan, "expected a memory.inject trace span");

  const injectedMemoryFiles = Array.isArray(
    memoryInjectSpan.attributes.memoryFiles
  )
    ? memoryInjectSpan.attributes.memoryFiles
    : [];
  const injectedMemoryText = JSON.stringify(injectedMemoryFiles);
  for (const expectedPath of expected.injectedMemoryPaths ?? []) {
    assert.match(injectedMemoryText, new RegExp(escapeRegExp(expectedPath)));
  }
  for (const expectedContent of expected.injectedMemoryContains ?? []) {
    assert.match(injectedMemoryText, new RegExp(escapeRegExp(expectedContent)));
  }

  assert.ok(dreamSpan, "expected a dream.run trace span");

  const commands = Array.isArray(dreamSpan.attributes.commands)
    ? dreamSpan.attributes.commands
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
    dreamSpan.attributes.addedFiles,
    expected.dreamAddedFiles ?? [],
    "dream.run addedFiles"
  );
  assertStringArrayAttributeIncludes(
    dreamSpan.attributes.changedFiles,
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

function readToolCallName(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const toolName = (value as { toolName?: unknown }).toolName;
  return typeof toolName === "string" ? toolName : undefined;
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
