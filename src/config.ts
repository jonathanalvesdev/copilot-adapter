import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

export class ConfigError extends Error {}

export interface ProxyConfig {
  host: string;
  port: number;
  /** Diretório de trabalho da sessão Copilot (isolado por padrão). */
  workingDirectory: string;
  /** COPILOT_HOME dedicado: o proxy não lê nem grava em ~/.copilot. */
  copilotHome: string;
  /** Segredo exigido nas rotas /v1/*. Opcional apenas em loopback. */
  apiKey: string | undefined;
  /** Token GitHub aceito pelo Copilot SDK (COPILOT_GITHUB_TOKEN, GH_TOKEN ou GITHUB_TOKEN). */
  githubToken: string | undefined;
}

export const USAGE = `Uso: copilot-adapter [--host <host>] [--port <porta>] [--cwd <diretório>]

  --host   Endereço de bind (padrão 127.0.0.1). Fora de loopback exige COPILOT_PROXY_API_KEY.
  --port   Porta (padrão 8080).
  --cwd    Diretório de trabalho isolado da sessão Copilot (padrão ~/.copilot-adapter/workspace).

Variáveis: COPILOT_PROXY_API_KEY, COPILOT_GITHUB_TOKEN (ou GH_TOKEN / GITHUB_TOKEN).`;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.toLowerCase());
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`Porta inválida: ${value}`);
  }
  return port;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined && value.trim() !== "");
}

function ensureDirectory(path: string): void {
  mkdirSync(path, { recursive: true });
}

/**
 * Lê argumentos e variáveis de ambiente e valida as regras de rede.
 * Lança ConfigError em qualquer configuração insegura, sem ecoar segredos.
 */
export function loadConfig(
  argv: string[],
  env: NodeJS.ProcessEnv,
  dataRoot: string = join(homedir(), ".copilot-adapter"),
): ProxyConfig {
  const { values } = parseArgs({
    args: argv,
    options: {
      host: { type: "string" },
      port: { type: "string" },
      cwd: { type: "string" },
    },
    strict: true,
  });

  const host = values.host ?? "127.0.0.1";
  const port = parsePort(values.port ?? "8080");
  const apiKey = firstNonEmpty(env.COPILOT_PROXY_API_KEY);

  if (!isLoopbackHost(host) && apiKey === undefined) {
    throw new ConfigError(
      `Bind em "${host}" (fora de loopback) exige COPILOT_PROXY_API_KEY definida. Abortando.`,
    );
  }

  const workingDirectory = values.cwd ? resolve(values.cwd) : join(dataRoot, "workspace");
  const copilotHome = join(dataRoot, "copilot-home");

  if (values.cwd) {
    if (!statSync(workingDirectory, { throwIfNoEntry: false })?.isDirectory()) {
      throw new ConfigError(`--cwd não é um diretório existente: ${workingDirectory}`);
    }
  } else {
    ensureDirectory(workingDirectory);
  }
  ensureDirectory(copilotHome);

  return {
    host,
    port,
    workingDirectory,
    copilotHome,
    apiKey,
    githubToken: firstNonEmpty(env.COPILOT_GITHUB_TOKEN, env.GH_TOKEN, env.GITHUB_TOKEN),
  };
}
