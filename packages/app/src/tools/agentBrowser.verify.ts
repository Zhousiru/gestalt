import assert from "node:assert/strict";
import { createMockConnector } from "../connectors/mock/connector";
import { createActionBashToolImplementation } from "./agentBrowser";

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
      cancelledExitCode: 124,
      isolatedVfs: true
    },
    null,
    2
  )
);
