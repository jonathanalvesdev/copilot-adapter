# Copilot Adapter

Proxy mínimo que expõe uma API **OpenAI-compatible** (somente texto) sobre o SDK oficial `@github/copilot-sdk`, para que o OpenNotebook use a assinatura GitHub Copilot.

```
OpenNotebook → API OpenAI-compatible → Proxy → @github/copilot-sdk → GitHub Copilot
```

O proxy é um **adaptador de protocolo, não um agente**: o modelo só produz texto. Ele não executa shell, não lê arquivos, não acessa URLs, MCPs nem variáveis de ambiente.

## Endpoints

| Rota | Auth | Descrição |
|---|---|---|
| `GET /health` | pública | `{"status":"ok"}`, sem dados de usuário, tokens ou env |
| `GET /v1/models` | Bearer | `CopilotClient.listModels()` convertido para o formato OpenAI (modelos com política `disabled` são omitidos) |
| `POST /v1/chat/completions` | Bearer | `model`, `messages`, `stream`; roles `system`, `developer`, `user`, `assistant`; conteúdo em texto (string ou partes `text`) |

Campos como `tools`, `tool_choice`, `temperature` e `max_tokens` são **ignorados** (tool calling não existe). A resposta não traz `usage`. Imagens/áudio retornam 400.

## Requisitos

- Node.js >= 22.12
- Assinatura GitHub Copilot ativa
- Um token GitHub aceito pelo Copilot (ver abaixo)

## Autenticação do GitHub

O runtime do Copilot roda em modo `empty` do SDK (sem keychain do SO, sem descoberta de configuração). Por isso a forma recomendada é um token por variável de ambiente, o mecanismo oficial do Copilot CLI ([docs](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)):

1. Crie um *fine-grained personal access token* (`github_pat_...`) na **sua conta pessoal** (não em organização) com a permissão de conta **Copilot Requests**.
2. Exporte em `COPILOT_GITHUB_TOKEN` (ordem de precedência: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`).

O proxy lê o token e o entrega ao SDK pela opção `gitHubToken`; ele **não** é repassado ao runtime por herança de ambiente. Observação: o token do `gh auth token` foi testado e retornou `403 not authorized to use this Copilot feature`; use o PAT acima.

## Configuração segura

| Item | Comportamento |
|---|---|
| Sessão Copilot | `availableTools: []`, `excludedTools: ["builtin:*","mcp:*","custom:*"]`, `onPermissionRequest` sempre `{kind:"reject"}`, sem MCP, tools, agentes, skills ou handlers de input. Definida em um único lugar: `buildSessionConfig` em `src/copilot.ts` |
| Ambiente | O `CopilotClient` recebe somente a allowlist de `src/runtimeEnv.ts` (PATH, variáveis de sistema do Windows/Linux/macOS, locale, proxy/CA). `AWS_*`, `DATABASE_URL`, `*_API_KEY`, `*_SECRET`, `*_PASSWORD`, tokens etc. não passam |
| API key | `COPILOT_PROXY_API_KEY`; toda rota exceto `/health` exige `Authorization: Bearer <chave>` (decidido pela rota casada, não pela URL bruta; comparação em tempo constante) |
| Rede | Padrão `127.0.0.1:8080`. Fora de loopback sem `COPILOT_PROXY_API_KEY` o processo aborta. Sem API key, requisições com `Host` não-loopback recebem 403 (proteção contra DNS rebinding) |
| CORS | Desabilitado (nenhum cabeçalho CORS emitido) |
| Diretórios | Sem usar HOME. Workspace `~/.copilot-adapter/workspace` e `COPILOT_HOME` `~/.copilot-adapter/copilot-home`, ou o valor de `--cwd` |
| Logs | Apenas método, rota (sem query), status e nome da classe do erro. Nunca prompt, body, headers, chave, token ou env |

Gere uma chave forte, por exemplo: `[Convert]::ToBase64String((1..32 | % { Get-Random -Max 256 }) -as [byte[]])` (PowerShell).

## Executar no Windows (PowerShell)

```powershell
npm install
npm run build

$env:COPILOT_GITHUB_TOKEN = "github_pat_..."
$env:COPILOT_PROXY_API_KEY = "uma-chave-longa-e-aleatoria"

node dist/index.js                      # 127.0.0.1:8080
node dist/index.js --port 9000 --cwd C:\copilot-sandbox
```

Opções: `--host`, `--port`, `--cwd`. Em desenvolvimento: `npm run dev`.

Teste rápido:

```powershell
curl.exe http://127.0.0.1:8080/health
curl.exe -H "Authorization: Bearer $env:COPILOT_PROXY_API_KEY" http://127.0.0.1:8080/v1/models
```

## OpenNotebook + Docker Desktop

1. Inicie o proxy acessível pelo container (a API key é obrigatória neste modo):

   ```powershell
   node dist/index.js --host 0.0.0.0 --port 8080
   ```

2. No OpenNotebook, adicione um provedor **OpenAI-compatible**:
   - **Base URL:** `http://host.docker.internal:8080/v1`
   - **API key:** o valor de `COPILOT_PROXY_API_KEY`
3. Liste/cadastre os modelos retornados por `/v1/models`.

Atenção: `--host 0.0.0.0` expõe a porta na rede local. Restrinja no Firewall do Windows ao acesso do Docker/localhost e mantenha a API key secreta.

## Desenvolvimento

```powershell
npm test; npm run typecheck; npm run lint; npm run build; npm audit
```

Estrutura: `src/config.ts` (args e regras de rede), `src/runtimeEnv.ts` (allowlist), `src/copilot.ts` (sessão deny-by-default e eventos do SDK), `src/openai.ts` (formatos OpenAI), `src/server.ts` (Fastify, auth, SSE), `src/index.ts` (CLI).

## Limitações

- Somente texto; sem tool calling, sem `usage`.
- Cada requisição cria uma sessão Copilot efêmera; o histórico enviado pelo cliente vira transcrição no prompt.
- O teste ao vivo contra o Copilot depende do seu token (ver autenticação); os testes automatizados usam um SDK simulado.
