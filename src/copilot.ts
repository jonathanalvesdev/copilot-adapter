import { CopilotClient } from "@github/copilot-sdk";
import type { ModelInfo, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { ProxyConfig } from "./config.js";
import type { CopilotPrompt, ModelSummary } from "./openai.js";
import { buildRuntimeEnv } from "./runtimeEnv.js";

/** Porta de saída do proxy: o servidor HTTP só conhece esta interface. */
export interface CopilotGateway {
  listModels(): Promise<ModelSummary[]>;
  /** Devolve o texto da resposta em pedaços, na ordem em que o Copilot os gera. */
  streamAnswer(input: CopilotPrompt, signal: AbortSignal): AsyncGenerator<string>;
  close(): Promise<void>;
}

// --- Subconjunto do SDK que o proxy usa (permite testar sem o runtime real) ---

export interface CopilotSessionLike {
  on(handler: (event: SessionEvent) => void): () => void;
  send(options: { prompt: string }): Promise<string>;
  disconnect(): Promise<void>;
}

export interface CopilotClientLike {
  start(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  createSession(config: SessionConfig): Promise<CopilotSessionLike>;
  stop(): Promise<unknown>;
}

const BASE_INSTRUCTIONS =
  "You are a text-only assistant. You have no tools and cannot access files, a shell, " +
  "the network or the local machine. Answer using only the conversation text.";

/**
 * ÚNICO lugar onde uma sessão Copilot é configurada. Deny-by-default:
 * nenhuma ferramenta, nenhum MCP, nenhuma permissão concedida.
 */
export function buildSessionConfig(input: CopilotPrompt, workingDirectory: string): SessionConfig {
  const systemContent = input.instructions
    ? `${BASE_INSTRUCTIONS}\n\n${input.instructions}`
    : BASE_INSTRUCTIONS;

  return {
    model: input.model,
    workingDirectory,
    streaming: true,
    availableTools: [],
    excludedTools: ["builtin:*", "mcp:*", "custom:*"],
    onPermissionRequest: () => Promise.resolve({ kind: "reject" }),
    systemMessage: { mode: "replace", content: systemContent },
    mcpServers: {},
    customAgents: [],
    skillDirectories: [],
    enableSkills: false,
    enableConfigDiscovery: false,
    infiniteSessions: { enabled: false },
  };
}

export function createCopilotGateway(client: CopilotClientLike, workingDirectory: string): CopilotGateway {
  // O runtime sobe na primeira requisição; falha de inicialização é tentada de novo na próxima.
  let starting: Promise<void> | undefined;
  const ensureStarted = () => {
    starting ??= client.start().catch((error: unknown) => {
      starting = undefined;
      throw error;
    });
    return starting;
  };

  return {
    async listModels() {
      await ensureStarted();
      const models = await client.listModels();
      return models.filter((model) => model.policy?.state !== "disabled").map((model) => ({ id: model.id }));
    },

    async *streamAnswer(input, signal) {
      await ensureStarted();
      const session = await client.createSession(buildSessionConfig(input, workingDirectory));
      const events = new EventQueue<string>();

      const stopListening = session.on((event) => {
        if (event.type === "assistant.message_delta") events.push(event.data.deltaContent);
        else if (event.type === "session.error") events.fail(new CopilotRequestError(event.data.errorType));
        else if (event.type === "session.idle") events.finish();
      });
      const abort = () => events.fail(new CopilotRequestError("aborted"));
      signal.addEventListener("abort", abort, { once: true });
      // O cliente pode ter desconectado (ou o timeout disparado) enquanto a sessão era criada.
      if (signal.aborted) abort();

      try {
        await session.send({ prompt: input.prompt });
        yield* events;
      } finally {
        signal.removeEventListener("abort", abort);
        stopListening();
        await session.disconnect().catch(() => undefined);
      }
    },

    async close() {
      await client.stop();
    },
  };
}

/** Erro seguro para logs: carrega só uma categoria, nunca texto do prompt ou da resposta. */
export class CopilotRequestError extends Error {}

/** Fila assíncrona simples: eventos do SDK entram por push, o servidor consome com for-await. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private finished = false;
  private failure: Error | undefined;
  private wake: (() => void) | undefined;

  push(item: T) {
    this.items.push(item);
    this.wake?.();
  }
  finish() {
    this.finished = true;
    this.wake?.();
  }
  fail(error: Error) {
    this.failure ??= error;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) {
        yield item;
      } else if (this.failure) {
        throw this.failure;
      } else if (this.finished) {
        return;
      } else {
        await new Promise<void>((resolve) => (this.wake = resolve));
      }
    }
  }
}

/** Cria o cliente real: runtime isolado, env filtrada, modo "empty" do SDK. */
export function createRealCopilotClient(config: ProxyConfig, source: NodeJS.ProcessEnv): CopilotClient {
  return new CopilotClient({
    mode: "empty",
    workingDirectory: config.workingDirectory,
    baseDirectory: config.copilotHome,
    env: buildRuntimeEnv(source),
    gitHubToken: config.githubToken,
    logLevel: "error",
  });
}
