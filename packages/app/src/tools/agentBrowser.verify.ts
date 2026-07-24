import assert from "node:assert/strict";
import { createMockConnector } from "../connectors/mock/connector";
import {
  createActionBashToolImplementation,
  createActionBashToolScope
} from "./agentBrowser";

const now = () => new Date("2026-07-24T00:00:00.000Z");
const connector = createMockConnector({ now });
const implementation = createActionBashToolImplementation();
const skillResult = await implementation(
  {
    id: "bash-core-skill",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "agent-browser skills get core"
    }
  },
  {
    connector,
    now
  }
);

assert.equal(skillResult.status, "executed");
assert.equal(skillResult.result?.ok, true);
assert.match(JSON.stringify(skillResult.result?.data), /agent-browser core/);

const forwardingImplementation = createActionBashToolImplementation({
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: [
      "-e",
      [
        "const chunks=[];",
        "process.stdin.on('data',(chunk)=>chunks.push(chunk));",
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:Buffer.concat(chunks).toString('utf8')})));"
      ].join(""),
      "--"
    ]
  }
});
const forwardingResult = await forwardingImplementation(
  {
    id: "bash-forwarding",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command:
        "printf 'from-pipe' | agent-browser open 'https://example.test/a b' --json"
    }
  },
  {
    connector,
    now
  }
);

assert.equal(forwardingResult.status, "executed");
const forwardingData = forwardingResult.result?.data as
  | { stdout?: string }
  | undefined;
assert.deepEqual(JSON.parse(forwardingData?.stdout ?? ""), {
  argv: ["open", "https://example.test/a b", "--json"],
  stdin: "from-pipe"
});

const scopedBash = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-loop-test",
  provider: "fortress",
  configPath: "/opt/gestalt/dist/browser/agent-browser.json",
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: [
      "-e",
      [
        "const chunks=[];",
        "process.stdin.on('data',(chunk)=>chunks.push(chunk));",
        "process.stdin.on('end',()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),stdin:Buffer.concat(chunks).toString('utf8')})));"
      ].join(""),
      "--"
    ]
  }
});
const scopedResult = await scopedBash.implementation(
  {
    id: "bash-scoped-session",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command:
        "agent-browser --namespace rogue --session=rogue --provider rogue --config rogue.json open https://example.test --session ignored --namespace=ignored -pignored"
    }
  },
  {
    connector,
    now
  }
);
assert.equal(scopedResult.status, "executed");
const scopedData = scopedResult.result?.data as
  | { stdout?: string }
  | undefined;
assert.deepEqual(JSON.parse(scopedData?.stdout ?? ""), {
  argv: [
    "--config",
    "/opt/gestalt/dist/browser/agent-browser.json",
    "--namespace",
    "gestalt",
    "--session",
    "gestalt-loop-test",
    "--provider",
    "fortress",
    "open",
    "https://example.test"
  ],
  stdin: ""
});
const closeResult = await scopedBash.dispose();
assert.deepEqual(JSON.parse(closeResult.stdout), {
  argv: [
    "--config",
    "/opt/gestalt/dist/browser/agent-browser.json",
    "--namespace",
    "gestalt",
    "--session",
    "gestalt-loop-test",
    "--provider",
    "fortress",
    "close"
  ],
  stdin: ""
});
assert.equal(await scopedBash.dispose(), closeResult);

const unusedScopedBash = createActionBashToolScope({
  namespace: "gestalt",
  sessionId: "gestalt-unused-loop",
  agentBrowserTarget: {
    executable: "this-command-must-not-run"
  }
});
assert.deepEqual(await unusedScopedBash.dispose(), {
  stdout: "",
  stderr: "",
  exitCode: 0
});

const cancellationImplementation = createActionBashToolImplementation({
  agentBrowserTarget: {
    executable: process.execPath,
    argsPrefix: ["-e", "setInterval(() => undefined, 1000)", "--"]
  }
});
const controller = new AbortController();
setTimeout(() => controller.abort(), 50);
const cancellationResult = await cancellationImplementation(
  {
    id: "bash-cancellation",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "agent-browser wait"
    }
  },
  {
    connector,
    now,
    signal: controller.signal
  }
);
assert.equal(cancellationResult.status, "failed");
assert.equal(
  (cancellationResult.result?.data as { exitCode?: number } | undefined)
    ?.exitCode,
  124
);

const inheritedPipeImplementation =
  createActionBashToolImplementation({
    agentBrowserTarget: {
      executable: process.execPath,
      argsPrefix: [
        "-e",
        [
          'const {spawn}=require("node:child_process");',
          "const child=spawn(process.execPath,['-e','setTimeout(()=>{},1500)'],{stdio:['ignore','inherit','inherit']});",
          "child.unref();",
          "process.stdout.write('parent-exited');"
        ].join(""),
        "--"
      ]
    }
  });
const inheritedPipeStartedAt = Date.now();
const inheritedPipeResult = await inheritedPipeImplementation(
  {
    id: "bash-inherited-pipe",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "agent-browser test"
    }
  },
  {
    connector,
    now
  }
);
const inheritedPipeElapsedMs = Date.now() - inheritedPipeStartedAt;
assert.equal(inheritedPipeResult.status, "executed");
assert.match(
  (
    inheritedPipeResult.result?.data as
      | { stdout?: string }
      | undefined
  )?.stdout ?? "",
  /parent-exited/
);
assert.ok(
  inheritedPipeElapsedMs < 1_000,
  `native command waited ${inheritedPipeElapsedMs}ms for an inherited pipe`
);

const firstLoop = createActionBashToolImplementation();
const secondLoop = createActionBashToolImplementation();
await firstLoop(
  {
    id: "bash-first-loop-write",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "printf 'loop-one' > /state"
    }
  },
  { connector, now }
);
const firstLoopRead = await firstLoop(
  {
    id: "bash-first-loop-read",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "cat /state"
    }
  },
  { connector, now }
);
const secondLoopRead = await secondLoop(
  {
    id: "bash-second-loop-read",
    proposedAt: now().toISOString(),
    toolName: "bash",
    params: {
      command: "cat /state"
    }
  },
  { connector, now }
);
assert.match(JSON.stringify(firstLoopRead.result?.data), /loop-one/);
assert.equal(secondLoopRead.status, "failed");

console.log(
  JSON.stringify(
    {
      ok: true,
      coreSkillLoaded: true,
      forwardedArgs: ["open", "https://example.test/a b", "--json"],
      forwardedStdin: "from-pipe",
      runtimeOwnedNamespace: "gestalt",
      runtimeOwnedSession: "gestalt-loop-test",
      runtimeOwnedProvider: "fortress",
      sessionClosedOnDispose: true,
      cancelledExitCode: 124,
      inheritedPipeElapsedMs,
      isolatedVfs: true
    },
    null,
    2
  )
);
