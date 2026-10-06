import { describe, expect, it } from "vitest";
import type { CopilotPrompt } from "../src/openai.js";
import { buildServer } from "../src/server.js";
import { API_KEY, fakeGateway, memoryLog } from "./helpers.js";

const auth = { authorization: `Bearer ${API_KEY}` };
const body = { model: "gpt-5", messages: [{ role: "user", content: "Oi" }] };

function server(gateway = fakeGateway(), log = memoryLog()) {
  return buildServer({ gateway, apiKey: API_KEY, logStream: log.stream });
}

/** Gateway que captura o que o servidor entrega ao Copilot. */
function capturingGateway() {
  const captured: { input?: CopilotPrompt } = {};
  const gateway = fakeGateway({
     
    async *streamAnswer(input) {
      captured.input = input;
      yield "ok";
    },
  });
  return { captured, gateway };
}

describe("GET /health", () => {
  it("é público e devolve apenas status operacional", async () => {
    const response = await server().inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

describe("autenticação", () => {
  it("recusa /v1/* sem Authorization", async () => {
    const response = await server().inject({ method: "GET", url: "/v1/models" });
    expect(response.statusCode).toBe(401);
  });

  it("recusa chave errada, inclusive de mesmo tamanho", async () => {
    const wrong = "x".repeat(API_KEY.length);
    const response = await server().inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `Bearer ${wrong}` },
    });
    expect(response.statusCode).toBe(401);
  });

  it("recusa esquema diferente de Bearer", async () => {
    const response = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: { authorization: `Basic ${API_KEY}` },
      payload: body,
    });
    expect(response.statusCode).toBe(401);
  });

  it("aceita a chave correta", async () => {
    const response = await server().inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(response.statusCode).toBe(200);
  });

  it("aceita o esquema bearer em minúsculas (RFC 7235)", async () => {
    const response = await server().inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: `bearer ${API_KEY}` },
    });
    expect(response.statusCode).toBe(200);
  });

  // Regressão: o roteador decodifica %XX; a autenticação comparava a URL bruta.
  it.each([
    ["GET", "/%76%31/models"],
    ["GET", "/v%31/models"],
    ["POST", "/%761/chat/completions"],
    ["GET", "/rota-inexistente"],
  ])("exige API key em %s %s (rota decodificada ou desconhecida)", async (method, url) => {
    const response = await server().inject({ method: method as "GET" | "POST", url, payload: method === "POST" ? body : undefined });
    expect(response.statusCode).toBe(401);
  });

  it("sem apiKey configurada (loopback) as rotas ficam abertas para Host local", async () => {
    const app = buildServer({ gateway: fakeGateway(), apiKey: undefined, logStream: memoryLog().stream });
    for (const host of ["localhost:8080", "127.0.0.1:8080", "[::1]:8080"]) {
      const response = await app.inject({ method: "GET", url: "/v1/models", headers: { host } });
      expect(response.statusCode).toBe(200);
    }
  });

  // Regressão: sem API key, DNS rebinding permitia uma página web usar o proxy.
  it("sem apiKey configurada recusa Host externo (DNS rebinding)", async () => {
    const app = buildServer({ gateway: fakeGateway(), apiKey: undefined, logStream: memoryLog().stream });
    const response = await app.inject({
      method: "GET",
      url: "/v1/models",
      headers: { host: "attacker.example:8080", origin: "http://attacker.example:8080" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("GET /v1/models", () => {
  it("converte a lista do Copilot para o formato OpenAI", async () => {
    const response = await server().inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(response.json()).toEqual({
      object: "list",
      data: [
        { id: "gpt-5", object: "model", created: 0, owned_by: "github-copilot" },
        { id: "claude-sonnet-4.5", object: "model", created: 0, owned_by: "github-copilot" },
      ],
    });
  });

  it("devolve 502 genérico quando o Copilot falha", async () => {
    const gateway = fakeGateway({ listModels: () => Promise.reject(new Error("token ghp_SEGREDO")) });
    const response = await server(gateway).inject({ method: "GET", url: "/v1/models", headers: auth });
    expect(response.statusCode).toBe(502);
    expect(response.body).not.toContain("ghp_SEGREDO");
  });
});

describe("POST /v1/chat/completions", () => {
  it("responde sem streaming", async () => {
    const response = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message).toEqual({ role: "assistant", content: "Olá, mundo" });
    expect(json.choices[0].finish_reason).toBe("stop");
  });

  it("aceita roles system, developer, user e assistant e repassa ao gateway", async () => {
    const { captured, gateway } = capturingGateway();
    const response = await server(gateway).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: {
        model: "gpt-5",
        messages: [
          { role: "system", content: "Seja breve." },
          { role: "developer", content: [{ type: "text", text: "Responda em PT-BR." }] },
          { role: "user", content: "Oi" },
          { role: "assistant", content: "Olá!" },
          { role: "user", content: "Tudo bem?" },
        ],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(captured.input?.instructions).toBe("Seja breve.\n\nResponda em PT-BR.");
    expect(captured.input?.prompt).toBe("User: Oi\n\nAssistant: Olá!\n\nUser: Tudo bem?");
  });

  it("converte eventos em SSE OpenAI e finaliza com [DONE]", async () => {
    const response = await server().inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");

    const events = response.body.split("\n\n").filter(Boolean);
    expect(events.at(-1)).toBe("data: [DONE]");
    const chunks = events.slice(0, -1).map((line) => JSON.parse(line.replace("data: ", "")));
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const text = chunks.map((chunk) => chunk.choices[0].delta.content ?? "").join("");
    expect(text).toBe("Olá, mundo");
    expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
    expect(chunks.every((chunk) => chunk.object === "chat.completion.chunk")).toBe(true);
  });

  it("devolve erro HTTP quando o Copilot falha antes do primeiro pedaço (stream)", async () => {
    // eslint-disable-next-line require-yield
    const gateway = fakeGateway({ async *streamAnswer() { throw new Error("boom"); } });
    const response = await server(gateway).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...body, stream: true },
    });
    expect(response.statusCode).toBe(502);
  });

  it.each([
    ["sem messages", { model: "gpt-5" }],
    ["sem model", { messages: body.messages }],
    ["role inválida", { model: "m", messages: [{ role: "tool", content: "x" }] }],
    [
      "conteúdo de imagem",
      { model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] },
    ],
    ["só system", { model: "m", messages: [{ role: "system", content: "x" }] }],
  ])("rejeita corpo inválido: %s", async (_name, payload) => {
    const response = await server().inject({ method: "POST", url: "/v1/chat/completions", headers: auth, payload });
    expect(response.statusCode).toBe(400);
  });

  it("ignora tools/tool_choice sem repassá-los ao Copilot", async () => {
    const { captured, gateway } = capturingGateway();
    await server(gateway).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { ...body, tools: [{ type: "function", function: { name: "rm" } }], tool_choice: "auto" },
    });
    expect(Object.keys(captured.input ?? {}).sort()).toEqual(["instructions", "model", "prompt"]);
  });
});

describe("CORS e rotas", () => {
  it("não emite cabeçalhos CORS", async () => {
    const app = server();
    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/v1/models",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
    const health = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(health.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("não expõe outras rotas", async () => {
    const response = await server().inject({ method: "GET", url: "/v1/files", headers: auth });
    expect(response.statusCode).toBe(404);
  });
});

describe("logs", () => {
  it("não contêm API key, Authorization, prompt, resposta nem texto de erro", async () => {
    const log = memoryLog();
    await server(fakeGateway(), log).inject({
      method: "POST",
      url: "/v1/chat/completions",
      headers: auth,
      payload: { model: "gpt-5", messages: [{ role: "user", content: "SEGREDO-DO-DOCUMENTO" }] },
    });
    await server(fakeGateway(), log).inject({
      method: "GET",
      url: "/v1/models",
      headers: { authorization: "Bearer chave-errada-xyz" },
    });
    const failing = fakeGateway({ listModels: () => Promise.reject(new Error("falhou com SEGREDO-NO-ERRO")) });
    await server(failing, log).inject({ method: "GET", url: "/v1/models", headers: auth });

    const logs = log.text();
    expect(logs.length).toBeGreaterThan(0);
    const forbidden = [API_KEY, "chave-errada-xyz", "Bearer", "authorization", "SEGREDO-DO-DOCUMENTO", "SEGREDO-NO-ERRO", "Olá, mundo"];
    for (const text of forbidden) {
      expect(logs).not.toContain(text);
    }
  });
});
