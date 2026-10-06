import type { CopilotGateway } from "../src/copilot.js";

export const API_KEY = "test-secret-key-123456";

export function fakeGateway(overrides: Partial<CopilotGateway> = {}): CopilotGateway {
  return {
    listModels: () => Promise.resolve([{ id: "gpt-5" }, { id: "claude-sonnet-4.5" }]),
     
    async *streamAnswer() {
      yield "Olá";
      yield ", mundo";
    },
    close: () => Promise.resolve(),
    ...overrides,
  };
}

export function memoryLog() {
  const lines: string[] = [];
  return { stream: { write: (line: string) => void lines.push(line) }, text: () => lines.join("") };
}
