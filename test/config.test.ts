import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { buildRuntimeEnv } from "../src/runtimeEnv.js";

const dataRoot = mkdtempSync(join(tmpdir(), "copilot-adapter-test-"));
const load = (args: string[], env: NodeJS.ProcessEnv = {}) => loadConfig(args, env, dataRoot);

describe("rede", () => {
  it("usa 127.0.0.1:8080 por padrão, sem exigir API key", () => {
    const config = load([]);
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(8080);
    expect(config.apiKey).toBeUndefined();
  });

  it.each(["0.0.0.0", "192.168.0.10", "::", "meu-host.local"])(
    "recusa bind em %s sem COPILOT_PROXY_API_KEY",
    (host) => {
      expect(() => load(["--host", host])).toThrow(ConfigError);
      expect(() => load(["--host", host], { COPILOT_PROXY_API_KEY: "   " })).toThrow(ConfigError);
    },
  );

  it("permite 0.0.0.0 (Docker Desktop) quando a API key existe", () => {
    const config = load(["--host", "0.0.0.0", "--port", "9000"], { COPILOT_PROXY_API_KEY: "segredo" });
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(9000);
    expect(config.apiKey).toBe("segredo");
  });

  it("a mensagem de erro não vaza a API key", () => {
    try {
      load(["--host", "0.0.0.0"], { COPILOT_PROXY_API_KEY: "" });
    } catch (error) {
      expect(String(error)).not.toContain("segredo");
    }
  });

  it.each(["0", "70000", "abc", "80.5"])("recusa porta inválida %s", (port) => {
    expect(() => load(["--port", port])).toThrow(ConfigError);
  });
});

describe("diretório de trabalho", () => {
  it("usa diretório dedicado, nunca HOME/USERPROFILE", () => {
    const config = load([]);
    expect(config.workingDirectory).toBe(join(dataRoot, "workspace"));
    expect(config.workingDirectory).not.toBe(process.env.USERPROFILE);
    expect(config.workingDirectory).not.toBe(process.env.HOME);
  });

  it("aceita --cwd existente e recusa inexistente", () => {
    expect(load(["--cwd", dataRoot]).workingDirectory).toBe(dataRoot);
    expect(() => load(["--cwd", join(dataRoot, "nao-existe")])).toThrow(ConfigError);
  });
});

describe("token GitHub", () => {
  it("segue a ordem COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN", () => {
    expect(load([], { GITHUB_TOKEN: "c", GH_TOKEN: "b", COPILOT_GITHUB_TOKEN: "a" }).githubToken).toBe("a");
    expect(load([], { GITHUB_TOKEN: "c", GH_TOKEN: "b" }).githubToken).toBe("b");
    expect(load([]).githubToken).toBeUndefined();
  });
});

describe("allowlist de ambiente", () => {
  it("mantém só o necessário, ignorando caixa dos nomes (Windows)", () => {
    const env = buildRuntimeEnv({
      Path: "C:\\bin",
      SYSTEMROOT: "C:\\Windows",
      USERPROFILE: "C:\\Users\\x",
      HTTPS_PROXY: "http://proxy:3128",
      AWS_PROFILE: "prod",
      DATABASE_URL: "postgres://x",
      STRIPE_SECRET: "s",
      DB_PASSWORD: "p",
      GH_TOKEN: "t",
    });
    expect(Object.keys(env).sort()).toEqual(["HTTPS_PROXY", "Path", "SYSTEMROOT", "USERPROFILE"]);
  });
});
