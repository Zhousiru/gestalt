import type { GestaltHome } from "../home/resolveGestaltHome";
import { createDailyJsonlWriter } from "../recording/dailyJsonl";
import type { AgentTurnTrace } from "./schemas";
import { AgentTurnTraceSchema } from "./schemas";

export interface TraceRecorder {
  recordAgentTurn(trace: AgentTurnTrace): Promise<void>;
}

export function createTraceRecorder(home: GestaltHome): TraceRecorder {
  const writer = createDailyJsonlWriter(home.tracesDir);

  return {
    async recordAgentTurn(trace) {
      const parsedTrace = AgentTurnTraceSchema.parse(trace);
      await writer.append(parsedTrace.startedAt, parsedTrace);
    }
  };
}
