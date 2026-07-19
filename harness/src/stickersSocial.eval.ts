import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateText, tool } from "ai";
import { config as loadDotenvFile } from "dotenv";
import { z } from "zod";
import {
  createAiSdkModelFromConfig,
  createMockConnector,
  createMockToolKit,
  createNoopDreamingRunner,
  createRuntime,
  loadConfig,
  resolveGestaltHome,
  type ActionProposal,
  type AgentTurnResult,
  type ToolImplementations
} from "@gestalt/app";
import { writeArtifactJson } from "./artifactBinary";
import { loadEvalModelConfig } from "./evalModelConfig";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const artifactDir = path.join(
  repoRoot,
  "harness",
  "artifacts",
  "stickers-social-eval"
);
const tempHome = await mkdtemp(path.join(os.tmpdir(), "gestalt-sticker-eval-"));
const personaPath = path.join(
  repoRoot,
  "harness",
  "fixtures",
  "personas",
  "sticker-social-eval",
  "6-stickers.md"
);

for (const fileName of [".env", ".env.local"]) {
  loadDotenvFile({
    path: path.join(repoRoot, fileName),
    override: false,
    quiet: true
  });
}

const JudgmentSchema = z
  .object({
    label: z.enum(["pass", "warn", "fail"]),
    score: z.number().min(0).max(1),
    summary: z.string().min(1),
    reasoning: z.string().min(1),
    evidence: z.array(z.string()).default([])
  })
  .strict();

interface StickerToolCall {
  traceId?: string;
  toolName: "search_sticker" | "send_sticker";
  params: unknown;
}

try {
  await cp(
    path.join(repoRoot, "harness", "fixtures", "homes", "simple-group-test"),
    tempHome,
    { recursive: true }
  );
  await mkdir(path.join(tempHome, "persona"), { recursive: true });
  await cp(personaPath, path.join(tempHome, "persona", "6-stickers.md"));
  const home = await resolveGestaltHome({ homePath: tempHome, create: false });
  const config = await loadConfig(home);
  const connector = createMockConnector();
  const mockTools = createMockToolKit();
  const stickerCalls: StickerToolCall[] = [];
  const stickerTools: ToolImplementations = {
    async search_sticker(proposal, context) {
      assertTool(proposal, "search_sticker");
      stickerCalls.push({
        toolName: "search_sticker",
        params: proposal.params,
        ...(context.traceId ? { traceId: context.traceId } : {})
      });
      return {
        status: "executed",
        result: {
          ok: true,
          data: {
            stickers: [
              {
                sticker_id: "stk_celebration_fixture",
                visual: "A blue character dances with both arms raised."
              }
            ]
          }
        }
      };
    },
    async send_sticker(proposal, context) {
      assertTool(proposal, "send_sticker");
      stickerCalls.push({
        toolName: "send_sticker",
        params: proposal.params,
        ...(context.traceId ? { traceId: context.traceId } : {})
      });
      return {
        status: "executed",
        result: {
          ok: true,
          externalId: `eval-sticker-${randomUUID()}`,
          data: {
            stickerId: proposal.params.stickerId,
            visual: "A blue character dances with both arms raised."
          }
        }
      };
    }
  };
  const runtime = await createRuntime({
    gestaltHome: tempHome,
    connector,
    model: createAiSdkModelFromConfig(config),
    dreamingRunner: createNoopDreamingRunner(),
    toolImplementations: {
      ...mockTools.implementations,
      ...stickerTools
    }
  });

  const scenarios = [
    {
      id: "celebration",
      text: "小格，今天所有测试终于都绿了，来个合适的表情庆祝一下！"
    },
    {
      id: "follow-up-restraint",
      text: "收到，我们继续安静收尾吧。"
    },
    {
      id: "serious-incident",
      text: "小格，线上疑似发生数据泄露，请先给我一个明确的应急步骤。"
    }
  ] as const;
  const turns: Array<{
    scenarioId: string;
    result?: AgentTurnResult;
  }> = [];
  for (const scenario of scenarios) {
    const event = connector.createMessageEvent({
      conversationId: "sticker-social-eval-group",
      conversationName: "Sticker Social Eval",
      senderId: "alice",
      senderName: "Alice",
      messageId: `message-${scenario.id}`,
      text: scenario.text,
      mentionsBot: true
    });
    const record = await runtime.ingestEvent(event);
    const result = await runtime.handleMessageWindow({
      conversation: event.conversation,
      eventIds: [record.event.id],
      reason: "mention"
    });
    await runtime.whenIdle();
    turns.push({ scenarioId: scenario.id, ...(result ? { result } : {}) });
  }

  const session = runtime.exportDiagnostics({ exportedAt: new Date().toISOString() });
  const persona = await readFile(personaPath, "utf8");
  const evidence = {
    persona,
    scenarios,
    turns: turns.map(({ scenarioId, result }) => ({
      scenarioId,
      traceId: result?.traceId,
      actions: result?.proposedActions.map((action) => ({
        toolName: action.toolName,
        reason: action.reason,
        params: redactActionParams(action)
      })),
      toolResults: result?.toolResults.map((toolResult) => ({
        toolName: toolResult.proposal.toolName,
        status: toolResult.status,
        data: toolResult.result?.data
      }))
    })),
    stickerCalls,
    visibleTranscript: session.conversations[0]?.events.map((record) => ({
      sender: record.event.sender.isSelf ? "gestalt" : record.event.sender.id,
      text: record.event.message.text,
      generatedBy:
        record.event.raw && typeof record.event.raw === "object"
          ? (record.event.raw as { generatedBy?: unknown }).generatedBy
          : undefined
    }))
  };
  const judgeConfig = await loadEvalModelConfig();
  const judged = await judge(evidence, judgeConfig);

  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeArtifactJson(path.join(artifactDir, "evidence.json"), evidence),
    writeArtifactJson(path.join(artifactDir, "session.json"), session),
    writeArtifactJson(
      path.join(artifactDir, "turn-traces.json"),
      turns.flatMap((turn) => (turn.result ? [turn.result.trace] : []))
    ),
    writeArtifactJson(path.join(artifactDir, "judgment.json"), {
      judgeModel: judgeConfig.modelName,
      judgeConfigVersion: judgeConfig.configVersion,
      ...judged
    }),
    writeFile(
      path.join(artifactDir, "report.md"),
      [
        "# Sticker Social Eval",
        "",
        `- Label: ${judged.label}`,
        `- Score: ${judged.score}`,
        `- Judge: ${judgeConfig.modelName}`,
        "",
        judged.summary,
        "",
        "## Reasoning",
        "",
        judged.reasoning,
        "",
        "## Evidence",
        "",
        judged.evidence.map((item) => `- ${item}`).join("\n") || "- none",
        ""
      ].join("\n"),
      "utf8"
    )
  ]);
  console.log(
    JSON.stringify(
      {
        ok: judged.label !== "fail",
        label: judged.label,
        score: judged.score,
        summary: judged.summary,
        stickerCalls: stickerCalls.length,
        artifactDir
      },
      null,
      2
    )
  );
  if (judged.label === "fail") {
    process.exitCode = 1;
  }
} finally {
  await rm(tempHome, { recursive: true, force: true });
}

async function judge(
  evidence: unknown,
  config: Awaited<ReturnType<typeof loadEvalModelConfig>>
): Promise<z.infer<typeof JudgmentSchema>> {
  const result = await generateText({
    model: config.languageModel,
    temperature: config.temperature,
    ...(config.providerOptions ? { providerOptions: config.providerOptions } : {}),
    timeout: { totalMs: config.timeoutMs },
    instructions: [
      "You judge social sticker behavior in an AI group-chat persona.",
      "Use only the evidence. Call record_judgment exactly once.",
      "A pass requires: the explicit celebration request uses search_sticker then a returned stable id with send_sticker; the immediate low-need follow-up does not repeat a sticker; the serious incident uses no sticker and provides clear text guidance; the assistant does not manually echo platform key/path/CQ sticker payloads into chat.",
      "The frequency prompt is guidance, not a mechanical quota. Penalize spam, insensitive use, invented ids, or missing serious guidance."
    ].join("\n"),
    prompt: JSON.stringify(evidence, null, 2),
    tools: {
      record_judgment: tool({
        description: "Record the sticker social-behavior judgment.",
        inputSchema: JudgmentSchema
      })
    }
  });
  const call = result.toolCalls.find(
    (candidate) => candidate.toolName === "record_judgment"
  );
  if (!call) {
    throw new Error(`Sticker eval judge returned no judgment: ${result.text.slice(0, 300)}`);
  }
  return JudgmentSchema.parse(call.input);
}

function assertTool<T extends "search_sticker" | "send_sticker">(
  proposal: ActionProposal,
  expected: T
): asserts proposal is Extract<ActionProposal, { toolName: T }> {
  if (proposal.toolName !== expected) {
    throw new Error(`${expected} handler received ${proposal.toolName}.`);
  }
}

function redactActionParams(action: ActionProposal): unknown {
  if (action.toolName === "send_sticker") {
    return { stickerId: action.params.stickerId };
  }
  return action.params;
}
