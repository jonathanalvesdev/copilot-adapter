/**
 * Allowlist das únicas variáveis de ambiente repassadas ao runtime do Copilot.
 * Tudo que não está aqui (AWS_*, DATABASE_URL, OPENAI_API_KEY, *_SECRET, tokens...)
 * é descartado. O token GitHub e o COPILOT_HOME NÃO passam por aqui: o SDK os
 * recebe por opções explícitas (`gitHubToken`, `baseDirectory`).
 */
const ALLOWED_RUNTIME_ENV = new Set([
  // Resolução de executáveis e diretórios temporários
  "PATH",
  "PATHEXT",
  "TEMP",
  "TMP",
  "TMPDIR",
  // Windows
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  // Linux e macOS
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  // Locale
  "LANG",
  "LC_ALL",
  "TZ",
  // Rede corporativa: proxy e certificados (não contêm segredo de aplicação)
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** Comparação case-insensitive: no Windows `Path`/`SystemRoot` variam de caixa. */
export function buildRuntimeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && ALLOWED_RUNTIME_ENV.has(name.toUpperCase())) {
      runtimeEnv[name] = value;
    }
  }
  return runtimeEnv;
}
