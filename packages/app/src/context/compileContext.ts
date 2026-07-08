import type { CanonicalEvent } from "../events/schemas";
import type { GestaltConfig } from "../home/loadConfig";
import type { MemoryFragment } from "../memory/store";
import type { PersonaPack } from "../persona/loadPersona";
import type { MessageWindow, SessionEventRecord } from "../session/schemas";
import type { ToolDefinition } from "../tools/schemas";
import { renderConversationTranscript } from "./renderTranscript";
import type { ContextEventRecord } from "./selectContextEvents";

export interface CompiledMessageWindow {
  id: string;
  reason: MessageWindow["reason"];
  fromSeq: number;
  toSeq: number;
  eventSeqs: number[];
  events: SessionEventRecord[];
  contextEvents: ContextEventRecord[];
}

export interface CompiledContext {
  event: CanonicalEvent;
  window?: CompiledMessageWindow;
  transcript: string;
  persona: PersonaPack;
  memories: MemoryFragment[];
  tools: ToolDefinition[];
  config: {
    path: string;
    flatValues: GestaltConfig["flatValues"];
  };
}

export interface CompileContextInput {
  event: CanonicalEvent;
  window?: MessageWindow;
  windowEvents?: SessionEventRecord[];
  contextEvents?: ContextEventRecord[];
  persona: PersonaPack;
  memories: MemoryFragment[];
  tools: ToolDefinition[];
  config: GestaltConfig;
}

export function compileContext(input: CompileContextInput): CompiledContext {
  const transcript = renderConversationTranscript({
    event: input.event,
    ...(input.window ? { window: input.window } : {}),
    ...(input.windowEvents ? { windowEvents: input.windowEvents } : {}),
    ...(input.contextEvents ? { contextEvents: input.contextEvents } : {})
  });

  return {
    event: input.event,
    ...(input.window
      ? {
          window: {
            id: input.window.id,
            reason: input.window.reason,
            fromSeq: input.window.fromSeq,
            toSeq: input.window.toSeq,
            eventSeqs: input.window.eventSeqs,
            events: input.windowEvents ?? [],
            contextEvents: input.contextEvents ?? []
          }
        }
      : {}),
    transcript,
    persona: input.persona,
    memories: input.memories,
    tools: input.tools,
    config: {
      path: input.config.path,
      flatValues: input.config.flatValues
    }
  };
}
