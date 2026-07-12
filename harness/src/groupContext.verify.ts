import assert from "node:assert/strict";
import {
  formatZonedDateTime,
  renderCurrentEnvironment,
  resolveTimezone,
  type GestaltConfig
} from "@gestalt/app";
import { assertReplayRun } from "./assertions";
import { runScenarioFixture } from "./replayRunner";

verifyTimeContextPrimitives();

const result = await runScenarioFixture(
  "harness/fixtures/scenarios/group-context-history.json"
);

assertReplayRun(result);

const contextSpans = result.rollouts
  .flatMap((rollout) => rollout.records)
  .filter(
    (record) =>
      record.type === "span_completed" && record.name === "context.compile"
  );
assert.ok(contextSpans.length > 0, "expected a context.compile span");
for (const span of contextSpans) {
  assert.equal(span.type, "span_completed");
  if (span.type !== "span_completed") {
    continue;
  }
  const attributes = span.attributes as Record<string, unknown>;
  assert.equal(attributes.timezone, "Asia/Shanghai");
  assert.equal(attributes.timezoneSource, "config");
  assert.equal(attributes.localTime, "2026-07-11 18:42");
}

const conversation = result.session.conversations[0];
const turn = conversation?.turns[0];

console.log(
  JSON.stringify(
    {
      ok: true,
      scenario: result.fixture.id,
      events: conversation?.events.length ?? 0,
      selfMessages:
        conversation?.events.filter(
          (record) =>
            record.event.type === "MessageReceived" &&
            record.event.sender.isSelf === true
        ).length ?? 0,
      actions: turn?.proposedActions.map((action) => action.toolName) ?? [],
      modelRequests: result.modelRequests.length,
      artifacts: result.artifactPaths
    },
    null,
    2
  )
);

function verifyTimeContextPrimitives(): void {
  const configured = configWithTimezone("Asia/Shanghai");
  assert.deepEqual(resolveTimezone(configured, () => "Europe/London"), {
    timezone: "Asia/Shanghai",
    source: "config"
  });
  assert.deepEqual(resolveTimezone(emptyConfig(), () => "Europe/London"), {
    timezone: "Europe/London",
    source: "system"
  });
  assert.deepEqual(resolveTimezone(emptyConfig(), () => "Not/AZone"), {
    timezone: "UTC",
    source: "utc_fallback"
  });
  assert.throws(
    () => resolveTimezone(configWithTimezone("Not/AZone")),
    /Invalid configured IANA timezone/
  );

  const shanghai = formatZonedDateTime(
    new Date("2026-07-11T10:42:16.000Z"),
    "Asia/Shanghai"
  );
  assert.deepEqual(shanghai, {
    date: "2026-07-11",
    time: "18:42",
    weekday: "Saturday",
    offset: "UTC+08:00"
  });

  assert.equal(
    formatZonedDateTime(
      new Date("2026-01-15T12:00:00.000Z"),
      "America/New_York"
    ).offset,
    "UTC-05:00"
  );
  assert.equal(
    formatZonedDateTime(
      new Date("2026-07-15T12:00:00.000Z"),
      "America/New_York"
    ).offset,
    "UTC-04:00"
  );

  const initialWindow = renderCurrentEnvironment(
    new Date("2026-07-11T10:42:16.000Z"),
    "Asia/Shanghai"
  );
  const steerWindow = renderCurrentEnvironment(
    new Date("2026-07-11T10:47:59.000Z"),
    "Asia/Shanghai"
  );
  assert.match(initialWindow, /Current local time: 2026-07-11 18:42/);
  assert.match(steerWindow, /Current local time: 2026-07-11 18:47/);
  assert.doesNotMatch(initialWindow, /18:42:16/);
  assert.doesNotMatch(steerWindow, /18:47:59/);
}

function configWithTimezone(timezone: string): GestaltConfig {
  return {
    path: "fixture/config.toml",
    raw: `timezone = "${timezone}"`,
    flatValues: { timezone }
  };
}

function emptyConfig(): GestaltConfig {
  return {
    path: "fixture/config.toml",
    raw: "",
    flatValues: {}
  };
}
