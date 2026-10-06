import { createHash, timingSafeEqual } from "node:crypto";
import Fastify from "fastify";
import type { FastifyInstance, FastifyReply } from "fastify";
import { isLoopbackHost } from "./config.js";
import type { CopilotGateway } from "./copilot.js";
import {
  InvalidPromptError,
  SSE_DONE,
  chatCompletionRequestSchema,
  newCompletionId,
  openAiError,
  toChatCompletion,
  toCopilotPrompt,
  toOpenAiModelList,
  toSseChunk,
} from "./openai.js";

export interface ServerOptions {
  gateway: CopilotGateway;
  apiKey: string | undefined;
  /** Destino dos logs; nos testes é um stream em memória. */
  logStream?: { write(line: string): void };
  requestTimeoutMs?: number;
}

const BODY_LIMIT_BYTES = 10 * 1024 * 1024; // documentos grandes do OpenNotebook

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearerTokenMatches(header: string | undefined, secret: string): boolean {
  // O esquema "Bearer" não diferencia maiúsculas (RFC 7235).
  const received = /^bearer +(.+)$/i.exec(header ?? "")?.[1] ?? "";
  // Compara hashes de tamanho fixo para não vazar o tamanho do segredo.
  return timingSafeEqual(sha256(received), sha256(secret));
}

/** Logs registram só o nome da classe do erro: a mensagem pode conter trechos do prompt. */
function errorType(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

function sendError(reply: FastifyReply, status: number, message: string, type: string, code: string) {
  return reply.code(status).send(openAiError(message, type, code));
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const { gateway, apiKey } = options;
  const timeoutMs = options.requestTimeoutMs ?? 120_000;

  const app: FastifyInstance = Fastify({
    bodyLimit: BODY_LIMIT_BYTES,
    // Logs: só metadados. Sem body, sem headers, sem env.
    logger: {
      level: "info",
      stream: options.logStream,
      redact: ["req.headers", "res.headers"],
      serializers: {
        req: (req) => ({ method: req.method, url: req.url?.split("?")[0] }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    },
  });

  app.addHook("onRequest", async (request, reply) => {
    if (apiKey === undefined) {
      // Sem API key o proxy só roda em loopback. Recusar Host externo bloqueia
      // DNS rebinding: uma página web apontando o próprio domínio para 127.0.0.1.
      if (!isLoopbackHost(request.hostname)) {
        return sendError(reply, 403, "Host não permitido.", "invalid_request_error", "forbidden_host");
      }
      return;
    }
    // Deny-by-default: decide pela rota casada pelo roteador, não pela URL bruta
    // (o roteador decodifica %XX, então "/%76%31/models" casa com /v1/models).
    if (request.routeOptions.url === "/health") return;
    if (!bearerTokenMatches(request.headers.authorization, apiKey)) {
      return sendError(reply, 401, "API key inválida ou ausente.", "invalid_request_error", "invalid_api_key");
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const status = typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 ? statusCode : 500;
    request.log.error({ errorType: errorType(error) }, "request failed");
    // Mensagem genérica: erros internos podem conter trechos do prompt.
    return sendError(reply, status, status < 500 ? "Requisição inválida." : "Erro interno.", "api_error", "internal_error");
  });

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/v1/models", async (request, reply) => {
    try {
      return toOpenAiModelList(await gateway.listModels());
    } catch (error) {
      request.log.error({ errorType: errorType(error) }, "listModels failed");
      return sendError(reply, 502, "Falha ao listar modelos no Copilot.", "api_error", "upstream_error");
    }
  });

  app.post("/v1/chat/completions", async (request, reply) => {
    const parsed = chatCompletionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "Corpo inválido: informe model e messages (texto).", "invalid_request_error", "invalid_body");
    }

    let prompt;
    try {
      prompt = toCopilotPrompt(parsed.data);
    } catch (error) {
      if (error instanceof InvalidPromptError) {
        return sendError(reply, 400, error.message, "invalid_request_error", "invalid_messages");
      }
      throw error;
    }

    const completionId = newCompletionId();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    reply.raw.on("close", () => abort.abort());

    const answer = gateway.streamAnswer(prompt, abort.signal);

    try {
      if (!parsed.data.stream) {
        let text = "";
        for await (const piece of answer) text += piece;
        return toChatCompletion(completionId, prompt.model, text);
      }

      // Streaming: só abre o SSE depois do primeiro pedaço, para ainda poder devolver erro HTTP.
      const first = await answer.next();
      const created = Math.floor(Date.now() / 1000);
      const write = (payload: Parameters<typeof toSseChunk>[3]) =>
        reply.raw.write(toSseChunk(completionId, prompt.model, created, payload));

      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      write({ kind: "role" });
      try {
        if (!first.done) {
          write({ kind: "text", text: first.value });
          for await (const piece of answer) write({ kind: "text", text: piece });
        }
        write({ kind: "stop" });
      } catch (error) {
        request.log.error({ errorType: errorType(error) }, "stream failed");
        reply.raw.write(`data: ${JSON.stringify(openAiError("Falha durante o streaming.", "api_error", "upstream_error"))}\n\n`);
      }
      reply.raw.write(SSE_DONE);
      reply.raw.end();
    } catch (error) {
      request.log.error({ errorType: errorType(error) }, "completion failed");
      if (!reply.sent) {
        return sendError(reply, 502, "Falha ao obter resposta do Copilot.", "api_error", "upstream_error");
      }
    } finally {
      clearTimeout(timer);
    }
  });

  return app;
}
