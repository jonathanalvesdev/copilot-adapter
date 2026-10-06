import { z } from "zod";

/** Conteúdo aceito: string ou lista de partes de texto. Imagens/áudio são rejeitados. */
const contentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.literal("text"), text: z.string() })),
]);

const messageSchema = z.object({
  role: z.enum(["system", "developer", "user", "assistant"]),
  content: contentSchema,
});

/**
 * Campos desconhecidos (temperature, max_tokens, tools...) são ignorados de propósito:
 * o proxy nunca repassa `tools`/`tool_choice` ao Copilot.
 */
export const chatCompletionRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().optional().default(false),
});

export type ChatCompletionRequest = z.infer<typeof chatCompletionRequestSchema>;
type ChatMessage = ChatCompletionRequest["messages"][number];

/** Entrada já traduzida para o que a sessão Copilot precisa. */
export interface CopilotPrompt {
  model: string;
  /** Texto de system/developer; vira a mensagem de sistema da sessão. */
  instructions: string;
  /** Conversa em texto corrido terminando na última mensagem do usuário. */
  prompt: string;
}

function contentToText(content: ChatMessage["content"]): string {
  return typeof content === "string" ? content : content.map((part) => part.text).join("\n");
}

const ROLE_LABEL = { user: "User", assistant: "Assistant" } as const;

export function toCopilotPrompt(request: ChatCompletionRequest): CopilotPrompt {
  const instructions: string[] = [];
  const conversation: Array<{ role: "user" | "assistant"; text: string }> = [];

  for (const message of request.messages) {
    const text = contentToText(message.content);
    if (message.role === "system" || message.role === "developer") {
      instructions.push(text);
    } else {
      conversation.push({ role: message.role, text });
    }
  }

  const last = conversation[conversation.length - 1];
  if (last?.role !== "user") {
    throw new InvalidPromptError("A última mensagem não-system deve ter role 'user'.");
  }

  // Caso comum (uma pergunta só): envia o texto puro, sem moldura de transcrição.
  const prompt =
    conversation.length === 1
      ? last.text
      : conversation.map((turn) => `${ROLE_LABEL[turn.role]}: ${turn.text}`).join("\n\n");

  return { model: request.model, instructions: instructions.join("\n\n"), prompt };
}

export class InvalidPromptError extends Error {}

// --- Respostas no formato OpenAI -------------------------------------------

export interface ModelSummary {
  id: string;
}

export function toOpenAiModelList(models: ModelSummary[]) {
  return {
    object: "list" as const,
    data: models.map((model) => ({
      id: model.id,
      object: "model" as const,
      created: 0,
      owned_by: "github-copilot",
    })),
  };
}

export function newCompletionId(): string {
  return `chatcmpl-${crypto.randomUUID()}`;
}

export function toChatCompletion(id: string, model: string, text: string) {
  return {
    id,
    object: "chat.completion" as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant" as const, content: text },
        finish_reason: "stop" as const,
      },
    ],
  };
}

export type ChunkPayload =
  | { kind: "role" }
  | { kind: "text"; text: string }
  | { kind: "stop" };

/** Serializa um evento como linha SSE `data: {...}\n\n`. */
export function toSseChunk(id: string, model: string, created: number, payload: ChunkPayload): string {
  const choice =
    payload.kind === "role"
      ? { index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }
      : payload.kind === "text"
        ? { index: 0, delta: { content: payload.text }, finish_reason: null }
        : { index: 0, delta: {}, finish_reason: "stop" };

  const chunk = { id, object: "chat.completion.chunk", created, model, choices: [choice] };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";

export function openAiError(message: string, type: string, code: string) {
  return { error: { message, type, code } };
}
