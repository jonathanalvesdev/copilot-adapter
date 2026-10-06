import type { ModelInfo, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProxyConfig } from "../src/config.js";
import {
  CopilotRequestError,
  buildSessionConfig,
  createCopilotGateway,
  createRealCopilotClient,
} from "../src/copilot.js";
import type { CopilotClientLike, CopilotSessionLike } from "../src/copilot.js";

// Captura as opções que o proxy passa ao CopilotClient real, sem iniciar o runtime.
const clientConstructor = vi.hoisted(() => vi.fn());
vi.mock("@github/copilot-sdk", () => ({
  CopilotClient: class {
    constructor(options: unknown) {
      clientConstructor(options);
    }
  },
}));

const prompt = { model: "gpt-5", instructions: "Seja breve.", prompt: "Oi" };

type Handler = (event: SessionEvent) => void;

/** Sessão falsa: ao receber send(), emite os eventos configurados. */
function fakeClient(script: (emit: Handler) => void) {
  const state = {
    config: undefined as SessionConfig | undefined,
    disconnected: false,
    starts: 0,
    sent: [] as string[],
    emit: undefined as Handler | undefined,
  };
  const session: CopilotSessionLike = {
    on: (handler) => {
      state.emit = handler;
      return () => undefined;
    },
    send: ({ prompt }) => {
      state.sent.push(prompt);
      queueMicrotask(() => script(state.emit as Handler));
      return Promise.resolve("message-id");
    },
    disconnect: () => {
      state.disconnected = true;
      return Promise.resolve();
    },
  };
  const client: CopilotClientLike = {
    start: () => {
      state.starts += 1;
      return Promise.resolve();
    },
    listModels: () =>
      Promise.resolve([
        { id: "gpt-5", name: "GPT-5" },
        { id: "bloqueado", name: "X", policy: { state: "disabled", terms: "" } },
      ] as ModelInfo[]),
    createSession: (config) => {
      state.config = config;
      return Promise.resolve(session);
    },
    stop: () => Promise.resolve([]),
  };
  return { client, state };
}

const delta = (text: string) => ({ type: "assistant.message_delta", data: { deltaContent: text } }) as SessionEvent;
const idle = { type: "session.idle", data: {} } as SessionEvent;

async function collect(iterable: AsyncIterable<string>) {
  let text = "";
  for await (const piece of iterable) text += piece;
  return text;
}

describe("configuração da sessão Copilot (deny-by-default)", () => {
  const config = buildSessionConfig(prompt, "/isolado");

  it("usa availableTools: [] explicitamente", () => {
    expect(config.availableTools).toEqual([]);
  });

  it("exclui também qualquer ferramenta builtin, MCP e custom", () => {
    expect(config.excludedTools).toEqual(["builtin:*", "mcp:*", "custom:*"]);
  });

  it("recusa toda solicitação de permissão", async () => {
    const decisions = await Promise.all(
      ["shell", "write", "read", "mcp", "url", "memory", "custom-tool"].map((kind) =>
        config.onPermissionRequest?.({ kind } as never, { sessionId: "s" }),
      ),
    );
    expect(decisions).toEqual(Array(7).fill({ kind: "reject" }));
  });

  it("não declara MCP, tools customizadas, agentes, skills nem handlers de input", () => {
    expect(config.mcpServers).toEqual({});
    expect(config.tools).toBeUndefined();
    expect(config.customAgents).toEqual([]);
    expect(config.skillDirectories).toEqual([]);
    expect(config.enableSkills).toBe(false);
    expect(config.enableConfigDiscovery).toBe(false);
    expect(config.onUserInputRequest).toBeUndefined();
    expect(config.commands).toBeUndefined();
    expect(config.hooks).toBeUndefined();
  });

  it("usa o diretório isolado e inclui as instruções system/developer", () => {
    expect(config.workingDirectory).toBe("/isolado");
    expect(config.systemMessage).toMatchObject({ mode: "replace" });
    expect(JSON.stringify(config.systemMessage)).toContain("Seja breve.");
  });
});

describe("createCopilotGateway", () => {
  it("lista modelos habilitados", async () => {
    const { client } = fakeClient(() => undefined);
    expect(await createCopilotGateway(client, "/w").listModels()).toEqual([{ id: "gpt-5" }]);
  });

  it("inicia o runtime uma única vez, antes do primeiro uso", async () => {
    const { client, state } = fakeClient((emit) => emit(idle));
    const gateway = createCopilotGateway(client, "/w");

    await gateway.listModels();
    await collect(gateway.streamAnswer(prompt, new AbortController().signal));

    expect(state.starts).toBe(1);
  });

  it("converte eventos de delta em texto, termina no idle e desconecta a sessão", async () => {
    const { client, state } = fakeClient((emit) => {
      emit(delta("Olá"));
      emit(delta(", mundo"));
      emit(idle);
    });
    const gateway = createCopilotGateway(client, "/w");

    const text = await collect(gateway.streamAnswer(prompt, new AbortController().signal));

    expect(text).toBe("Olá, mundo");
    expect(state.sent).toEqual(["Oi"]);
    expect(state.config?.availableTools).toEqual([]);
    expect(state.disconnected).toBe(true);
  });

  it("propaga session.error sem expor a mensagem original", async () => {
    const { client, state } = fakeClient((emit) =>
      emit({ type: "session.error", data: { errorType: "rate_limit", message: "SEGREDO" } } as SessionEvent),
    );
    const gateway = createCopilotGateway(client, "/w");

    const failure = collect(gateway.streamAnswer(prompt, new AbortController().signal));

    await expect(failure).rejects.toBeInstanceOf(CopilotRequestError);
    await expect(failure).rejects.not.toThrow(/SEGREDO/);
    expect(state.disconnected).toBe(true);
  });

  // Regressão: abort ocorrido antes do registro do listener era ignorado e o stream travava.
  it("termina imediatamente se o sinal já chegou abortado", async () => {
    const { client, state } = fakeClient(() => undefined); // nunca responde
    const abort = new AbortController();
    abort.abort();

    const pending = collect(createCopilotGateway(client, "/w").streamAnswer(prompt, abort.signal));

    await expect(pending).rejects.toBeInstanceOf(CopilotRequestError);
    expect(state.disconnected).toBe(true);
  });

  it("aborta e desconecta quando o cliente HTTP cai", async () => {
    const { client, state } = fakeClient(() => undefined); // nunca responde
    const abort = new AbortController();
    const pending = collect(createCopilotGateway(client, "/w").streamAnswer(prompt, abort.signal));
    setTimeout(() => abort.abort(), 10);

    await expect(pending).rejects.toBeInstanceOf(CopilotRequestError);
    expect(state.disconnected).toBe(true);
  });
});

describe("cliente Copilot real: ambiente", () => {
  beforeEach(() => clientConstructor.mockClear());

  const config: ProxyConfig = {
    host: "127.0.0.1",
    port: 8080,
    workingDirectory: "/isolado",
    copilotHome: "/isolado-home",
    apiKey: "k",
    githubToken: "gho_TOKEN",
  };

  it("não propaga env sensível e usa modo empty", () => {
    const sensitive = {
      PATH: "/bin",
      SystemRoot: "C:\\Windows",
      HOME: "/home/x",
      AWS_ACCESS_KEY_ID: "AKIA",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DATABASE_URL: "postgres://u:p@h/db",
      OPENAI_API_KEY: "sk-openai",
      ANTHROPIC_API_KEY: "sk-ant",
      MY_SERVICE_SECRET: "s",
      DB_PASSWORD: "p",
      GITHUB_TOKEN: "ghp_AMBIENTE",
      COPILOT_PROXY_API_KEY: "proxy-key",
    };

    createRealCopilotClient(config, sensitive);

    const options = clientConstructor.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(options.mode).toBe("empty");
    expect(options.env).toEqual({ PATH: "/bin", SystemRoot: "C:\\Windows", HOME: "/home/x" });
    expect(JSON.stringify(options.env)).not.toMatch(/AKIA|aws-secret|postgres|sk-|ghp_|proxy-key/);
    // O token chega por opção explícita, nunca por env herdada.
    expect(options.gitHubToken).toBe("gho_TOKEN");
    expect(options.workingDirectory).toBe("/isolado");
    expect(options.baseDirectory).toBe("/isolado-home");
  });
});
