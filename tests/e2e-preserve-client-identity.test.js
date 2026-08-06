/**
 * End-to-end verification: does the "Preserve client identity headers"
 * connection-level toggle actually forward the client's identity headers
 * upstream?
 *
 * Uses the REAL executor chain (getExecutor -> execute -> proxyAwareFetch)
 * against a local echo server, so "upstream received" is observed from the
 * server side, not just from the header object built in memory.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import { getExecutor } from "open-sse/executors/index.js";

const ECHO_PORT = 20129;
const ECHO_URL = `http://127.0.0.1:${ECHO_PORT}`;

const CLIENT_IDENTITY_HEADERS = {
  "user-agent": "codex-cli/1.2.3",
  originator: "codex_cli_rs",
  "openai-beta": "responses=experimental",
  "chatgpt-account-id": "acc_test_123",
  "x-stainless-lang": "js",
  // auth-like headers that must NEVER be forwarded
  authorization: "Bearer client-secret",
  "x-api-key": "client-key",
};

function startEchoServer() {
  const received = [];
  const server = http.createServer((req, res) => {
    received.push({ url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((resolvePromise) => {
    server.listen(ECHO_PORT, "127.0.0.1", () =>
      resolvePromise({ server, received }),
    );
  });
}

function makeCredentials(preserveClientIdentity) {
  return {
    apiKey: "sk-upstream-key",
    providerSpecificData: {
      baseUrl: ECHO_URL,
      preserveClientIdentity,
    },
    rawHeaders: { ...CLIENT_IDENTITY_HEADERS },
  };
}

describe("end-to-end preserveClientIdentity passthrough", () => {
  let echo;

  beforeAll(async () => {
    echo = await startEchoServer();
  });

  afterAll(async () => {
    await new Promise((r) => echo.server.close(r));
  });

  it("ON: upstream actually receives the client identity headers (server-side view)", async () => {
    const executor = getExecutor("openai-compatible-e2e-on");
    const res = await executor.execute({
      model: "gpt-4o-mini",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: makeCredentials(true),
    });

    expect(res.response.status).toBe(200);

    // 9router's own auth header wins; client Authorization must NOT leak
    expect(res.headers.Authorization).toBe("Bearer sk-upstream-key");
    expect(res.headers.authorization).toBeUndefined();

    // What the echo server actually received (node lowercases header names)
    const seen = echo.received[echo.received.length - 1].headers;
    expect(seen["user-agent"]).toBe("codex-cli/1.2.3");
    expect(seen["originator"]).toBe("codex_cli_rs");
    expect(seen["openai-beta"]).toBe("responses=experimental");
    expect(seen["chatgpt-account-id"]).toBe("acc_test_123");
    expect(seen["x-stainless-lang"]).toBe("js");
    // client credential headers must not appear upstream
    expect(seen["authorization"]).toBe("Bearer sk-upstream-key");
    expect(seen["x-api-key"]).toBeUndefined();
  });

  it("OFF: upstream does NOT receive the client identity headers", async () => {
    const executor = getExecutor("openai-compatible-e2e-off");
    const res = await executor.execute({
      model: "gpt-4o-mini",
      body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      credentials: makeCredentials(false),
    });

    expect(res.response.status).toBe(200);

    // 9router's own outbound header set must NOT contain the forwarded identity
    // headers when the toggle is off
    expect(res.headers["user-agent"]).toBeUndefined();
    expect(res.headers.originator).toBeUndefined();
    expect(res.headers["openai-beta"]).toBeUndefined();
    expect(res.headers["chatgpt-account-id"]).toBeUndefined();

    // Upstream view: undici always injects a default `user-agent: node`, but the
    // client identity headers must not appear
    const seen = echo.received[echo.received.length - 1].headers;
    expect(seen["originator"]).toBeUndefined();
    expect(seen["openai-beta"]).toBeUndefined();
    expect(seen["chatgpt-account-id"]).toBeUndefined();
    expect(seen["authorization"]).toBe("Bearer sk-upstream-key");
  });
});
