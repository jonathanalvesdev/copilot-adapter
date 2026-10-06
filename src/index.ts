#!/usr/bin/env node
import { ConfigError, USAGE, loadConfig } from "./config.js";
import { createCopilotGateway, createRealCopilotClient } from "./copilot.js";
import { buildServer } from "./server.js";

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(USAGE);
    return;
  }

  let config;
  try {
    config = loadConfig(process.argv.slice(2), process.env);
  } catch (error) {
    // Mensagens de ConfigError nunca contêm segredos.
    const reason = error instanceof Error ? error.message : "configuração inválida";
    console.error(`${reason}\n\n${USAGE}`);
    process.exit(1);
  }

  const client = createRealCopilotClient(config, process.env);
  const gateway = createCopilotGateway(client, config.workingDirectory);
  const app = buildServer({ gateway, apiKey: config.apiKey });

  const shutdown = async () => {
    await app.close();
    await gateway.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ host: config.host, port: config.port });
  if (config.apiKey === undefined) {
    app.log.warn("COPILOT_PROXY_API_KEY não definida: rotas /v1/* sem autenticação (somente loopback).");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof ConfigError ? error.message : "Falha ao iniciar o proxy.");
  process.exit(1);
});
