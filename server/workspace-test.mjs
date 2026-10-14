import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { readFile } from "node:fs/promises";
import {
  DEFAULT_MODEL,
  MAX_REQUEST_BYTES,
  MENTOR_PATH,
  OPENROUTER_URL,
  validateRequest
} from "./openrouter-proxy.mjs";
import {
  DEFAULT_WEB_PORT,
  STATIC_ROUTES,
  createWorkspaceServer,
  getWorkspaceConfig,
  startWorkspaceServer
} from "./workspace-server.mjs";

const output = {
  reply: "Write one acceptance example before changing the implementation.",
  projectUnderstanding: {
    whatIsBeingBuilt: "A timer app.",
    why: "A small practice project.",
    targetUsers: "The project owner."
  },
  changedRequirements: [],
  nextStep: "Describe what starting and stopping the timer should do.",
  securityReview: [],
  openQuestions: [],
  uncertainty: ["Implementation was not inspected."],
  verificationNeeded: ["Run an actual timer test."]
};

function validRequest() {
  return {
    cloudConsent: true,
    conversationKey: "workspace:timer_test-123",
    messages: [{ role: "user", text: "Goal: Build a timer." }],
    project: { objective: "Build a timer", technologyStack: "Web" },
    userMessage: "What should I do first?"
  };
}

function providerResponse(value = output) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function post(base, body = validRequest(), headers = {}) {
  return fetch(`${base}${MENTOR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base, ...headers },
    body: JSON.stringify(body)
  });
}

// fetch normalizes dot segments before sending. Raw HTTP is necessary to
// exercise traversal and Host checks against what the server actually receives.
function rawRequest(base, target, { method = "GET", headers = {}, body } = {}) {
  const url = new URL(base);
  if (Object.values(headers).some(value => Array.isArray(value))) {
    return rawSocketRequest(url.port, target, method, headers, body);
  }
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: url.port,
      method,
      path: target,
      headers: { Host: url.host, ...headers }
    }, response => {
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Test request timed out.")));
    request.end(body);
  });
}

function rawSocketRequest(port, target, method, headers, body) {
  const lines = [`${method} ${target} HTTP/1.1`];
  for (const [name, value] of Object.entries({ Host: `127.0.0.1:${port}`, ...headers })) {
    for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
  }
  if (body !== undefined) lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
  lines.push("Connection: close", "", body || "");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(port) });
    const chunks = [];
    socket.setTimeout(5000, () => socket.destroy(new Error("Test request timed out.")));
    socket.on("connect", () => socket.end(lines.join("\r\n")));
    socket.on("data", chunk => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const split = text.indexOf("\r\n\r\n");
      const headerText = split < 0 ? text : text.slice(0, split);
      const bodyText = split < 0 ? "" : text.slice(split + 4);
      const status = Number(headerText.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1]);
      const responseHeaders = {};
      for (const line of headerText.split("\r\n").slice(1)) {
        const separator = line.indexOf(":");
        if (separator > 0) responseHeaders[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
      }
      resolve({ status, headers: responseHeaders, text: bodyText });
    });
  });
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

let checks = 0;
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}

await check("configuration defaults to loopback:4173 and keeps workspace/extension ports independent", () => {
  assert.deepEqual(getWorkspaceConfig({}), { host: "127.0.0.1", port: DEFAULT_WEB_PORT, model: DEFAULT_MODEL, apiKey: "" });
  assert.equal(getWorkspaceConfig({ BOB_WEB_PORT: "0", BOB_PORT: "invalid" }).port, 0);
  assert.equal(getWorkspaceConfig({ BOB_WEB_PORT: "4321" }).port, 4321);
  assert.equal(typeof createWorkspaceServer, "function");
  for (const port of ["-1", "65536", "4173.5", "Infinity", "invalid", " "]) {
    assert.throws(() => getWorkspaceConfig({ BOB_WEB_PORT: port }), /BOB_WEB_PORT/);
  }
});

await check("shared validation accepts safe workspace and ChatGPT keys, but still requires cloud consent", () => {
  assert.equal(validateRequest(validRequest()).ok, true);
  assert.equal(validateRequest({ ...validRequest(), conversationKey: "chatgpt:test_123" }).ok, true);
  for (const key of ["workspace:", "workspace:../private", "workspace:has spaces", "workspace:a/b", "workspace:a.b", "other:test", `workspace:${"x".repeat(200)}`]) {
    assert.equal(validateRequest({ ...validRequest(), conversationKey: key }).ok, false, key);
  }
  assert.equal(validateRequest({ ...validRequest(), cloudConsent: false }).code, "consent_required");
});

{
  let providerCalls = 0;
  const { server, host, port } = await startWorkspaceServer({
    env: { BOB_WEB_PORT: "0" },
    fetchImpl: async () => {
      providerCalls += 1;
      throw new Error("Unexpected provider call.");
    }
  });
  const base = `http://${host}:${port}`;
  try {
    await check("health reports only availability and model without requiring a provider key", async () => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, providerConfigured: false, model: DEFAULT_MODEL });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    });

    await check("every allowlisted asset is served at its exact public route with security headers", async () => {
      for (const [route, file] of Object.entries(STATIC_ROUTES)) {
        const response = await fetch(`${base}${route}`);
        let expected;
        try {
          expected = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
        } catch (error) {
          // The workspace fixture currently has no project.js. Keep the
          // allowlist explicit and verify that a missing allowlisted asset is
          // still a safe 404 rather than silently substituting another file.
          assert.equal(error?.code, "ENOENT");
          assert.equal(response.status, 404, route);
          assert.equal(JSON.parse(await response.text()).error.code, "not_found");
          continue;
        }
        assert.equal(response.status, 200, route);
        assert.equal(await response.text(), expected, route);
        const type = file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : "text/javascript";
        assert.equal(response.headers.get("content-type"), `${type}; charset=utf-8`, route);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
        assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
        assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
      const queryResponse = await fetch(`${base}/app.js?v=test`);
      assert.equal(queryResponse.status, 200);
      await queryResponse.text();
      const head = await fetch(`${base}/`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.ok(Number(head.headers.get("content-length")) > 0);
      assert.equal(await head.text(), "");
    });

    await check("private files, directory browsing, encoded/raw traversal, and absolute targets are blocked", async () => {
      for (const route of [
        "/.env", "/server/.env", "/server/.env.example", "/.git/config", "/README.md", "/manifest.json",
        "/server/openrouter-proxy.mjs", "/server/workspace-server.mjs", "/src/content.js", "/src/core.js",
        "/web/", "/server/", "/web/index.html", "/../index.html", "/web/../index.html", "/%2e%2e/index.html",
        "/web/%2e%2e/%2e%2e/.env", "/%2eenv", "/%2e%2e%2f.env", "/..\\.env", "/index.html/../.env", "/app.js/",
        "/app.js%00", "//index.html", "/toString", "/__proto__"
      ]) {
        const response = await rawRequest(base, route);
        assert.equal(response.status, 404, route);
        assert.equal(JSON.parse(response.text).error.code, "not_found", route);
        assert.equal(response.headers["access-control-allow-origin"], undefined);
      }
      const response = await rawRequest(base, `http://evil.example:${port}/index.html`);
      assert.equal(response.status, 400);
    });

    await check("Host is restricted to bound loopback aliases at the actual listener port", async () => {
      for (const hostHeader of [
        `evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.2:${port}`, `2130706433:${port}`,
        `[::1]:${port}`, `localhost.:${port}`, "localhost", "127.0.0.1", "localhost:0",
        `localhost:${port === 65535 ? port - 1 : port + 1}`, `user@localhost:${port}`
      ]) {
        const response = await rawRequest(base, "/health", { headers: { Host: hostHeader } });
        assert.equal(response.status, 403, hostHeader);
        assert.equal(JSON.parse(response.text).error.code, "host_not_allowed");
      }
      const local = await rawRequest(base, "/health", { headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}` } });
      assert.equal(local.status, 200);
      const duplicates = await rawRequest(base, "/health", { headers: { Host: [`127.0.0.1:${port}`, `evil.example:${port}`] } });
      assert.equal(duplicates.status, 403);
    });

    await check("unapproved origins and absent Origin on writes are rejected without CORS", async () => {
      for (const origin of [
        "https://evil.example", "https://chatgpt.com", "null", "http://localhost:3000",
        `http://127.0.0.1:${port === 65535 ? port - 1 : port + 1}`, `http://localhost:${port}`,
        `${base}/`, `${base}/private`, `https://127.0.0.1:${port}`
      ]) {
        const response = await post(base, validRequest(), { Origin: origin });
        assert.equal(response.status, 403, origin);
        assert.equal((await response.json()).error.code, "origin_not_allowed");
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
      const absent = await rawRequest(base, MENTOR_PATH, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(validRequest())
      });
      assert.equal(absent.status, 403);
      const duplicate = await rawRequest(base, MENTOR_PATH, {
        method: "POST", headers: { Origin: [base, base], "content-type": "application/json" }, body: JSON.stringify(validRequest())
      });
      assert.equal(duplicate.status, 403);
      for (const route of ["/", "/health"]) {
        const response = await fetch(`${base}${route}`, { headers: { Origin: "https://evil.example" } });
        assert.equal(response.status, 403);
        await response.text();
      }
    });

    await check("only same-origin mentor preflight succeeds and no broad localhost CORS is enabled", async () => {
      const allowed = await fetch(`${base}${MENTOR_PATH}`, { method: "OPTIONS", headers: { Origin: base } });
      assert.equal(allowed.status, 204);
      assert.equal(allowed.headers.get("access-control-allow-origin"), null);
      const denied = await fetch(`${base}${MENTOR_PATH}`, {
        method: "OPTIONS", headers: { Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" }
      });
      assert.equal(denied.status, 403);
      await denied.text();
    });

    await check("no consent and no provider key fail before any upstream call", async () => {
      for (const consent of [false, undefined, "true"]) {
        const response = await post(base, { ...validRequest(), cloudConsent: consent });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).error.code, "consent_required");
      }
      const response = await post(base);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "not_configured");
      const localhost = await rawRequest(base, MENTOR_PATH, {
        method: "POST",
        headers: { Host: `localhost:${port}`, Origin: `http://localhost:${port}`, "content-type": "application/json" },
        body: JSON.stringify(validRequest())
      });
      assert.equal(localhost.status, 503);
      assert.equal(JSON.parse(localhost.text).error.code, "not_configured");
      assert.equal(providerCalls, 0);
    });

    await check("JSON, content type, body limits, and shared validation remain enforced", async () => {
      const malformed = await fetch(`${base}${MENTOR_PATH}`, {
        method: "POST", headers: { Origin: base, "content-type": "application/json" }, body: "{"
      });
      assert.equal(malformed.status, 400);
      assert.equal((await malformed.json()).error.code, "invalid_json");
      const nonJson = await post(base, validRequest(), { "content-type": "text/plain" });
      assert.equal(nonJson.status, 415);
      assert.equal((await nonJson.json()).error.code, "unsupported_media_type");
      const invalid = await post(base, { ...validRequest(), project: { privateFile: ".env" } });
      assert.equal(invalid.status, 400);
      assert.equal((await invalid.json()).error.code, "invalid_request");
      const huge = await fetch(`${base}${MENTOR_PATH}`, {
        method: "POST", headers: { Origin: base, "content-type": "application/json" }, body: " ".repeat(MAX_REQUEST_BYTES + 1)
      });
      assert.equal(huge.status, 413);
      assert.equal((await huge.json()).error.code, "payload_too_large");
      assert.equal(providerCalls, 0);
    });
  } finally {
    await close(server);
  }
}

{
  const calls = [];
  const secret = "server-only-test-credential";
  const model = "test/mentor-model";
  const { server, host, port } = await startWorkspaceServer({
    env: { BOB_WEB_PORT: "0", OPENROUTER_API_KEY: secret, OPENROUTER_MODEL: model },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return providerResponse({ ...output, reply: "Keep password='output-test-secret' on the server." });
    }
  });
  const base = `http://${host}:${port}`;
  try {
    await check("configured health exposes a boolean and model, never the credential", async () => {
      const response = await fetch(`${base}/health`);
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(text), { ok: true, providerConfigured: true, model });
      assert.doesNotMatch(text, /server-only-test-credential|apiKey|OPENROUTER_API_KEY/);
      assert.equal(calls.length, 0);
    });

    await check("same-origin workspace requests forward only redacted data with server credentials and structured output", async () => {
      const request = validRequest();
      request.messages[0].text += " API_KEY=sk-live-input-test-secret";
      request.project.objective += " password='project-test-secret'";
      request.userMessage += " Bearer abcdefghijklmnop";
      const response = await post(base, request);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.reply, "Keep password=[REDACTED] on the server.");
      assert.deepEqual({ ...result, reply: output.reply }, output);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
      assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
      assert.equal(calls.length, 1);
      const call = calls[0];
      assert.equal(call.url, OPENROUTER_URL);
      assert.equal(call.options.method, "POST");
      assert.equal(call.options.headers.Authorization, `Bearer ${secret}`);
      assert.equal(call.options.signal instanceof AbortSignal, true);
      assert.equal(call.body.model, model);
      assert.equal(call.body.response_format.type, "json_schema");
      assert.equal(call.body.response_format.json_schema.strict, true);
      assert.match(call.options.body, /untrusted reference data/);
      assert.match(call.options.body, /REDACTED/);
      assert.doesNotMatch(call.options.body, /sk-live-input-test-secret|project-test-secret|abcdefghijklmnop|server-only-test-credential/);
    });

    await check("cloud consent remains required when the provider is configured", async () => {
      const response = await post(base, { ...validRequest(), cloudConsent: false });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "consent_required");
      assert.equal(calls.length, 1);
    });
  } finally {
    await close(server);
  }
}

{
  const formats = [];
  const { server, host, port } = await startWorkspaceServer({
    env: { BOB_WEB_PORT: "0", OPENROUTER_API_KEY: "server-only-test-credential" },
    fetchImpl: async (_url, options) => {
      formats.push(JSON.parse(options.body).response_format.type);
      return formats.length === 1 ? new Response("schema unsupported", { status: 422 }) : providerResponse();
    }
  });
  try {
    await check("workspace uses the same one-time structured-output fallback", async () => {
      const response = await post(`http://${host}:${port}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
      assert.deepEqual(formats, ["json_schema", "json_object"]);
    });
  } finally {
    await close(server);
  }
}

for (const [name, fetchImpl, status, code] of [
  ["provider failures hide upstream content", async () => new Response("upstream-private-secret", { status: 503 }), 502, "provider_error"],
  ["invalid structured output is rejected", async () => providerResponse({ reply: "upstream-private-secret" }), 502, "invalid_model_response"],
  ["provider abort is returned as a safe timeout", async () => { throw Object.assign(new Error("upstream-private-secret"), { name: "AbortError" }); }, 504, "provider_timeout"]
]) {
  const { server, host, port } = await startWorkspaceServer({
    env: { BOB_WEB_PORT: "0", OPENROUTER_API_KEY: "server-only-test-credential" }, fetchImpl
  });
  try {
    await check(name, async () => {
      const response = await post(`http://${host}:${port}`);
      assert.equal(response.status, status);
      const text = await response.text();
      assert.equal(JSON.parse(text).error.code, code);
      assert.doesNotMatch(text, /upstream-private-secret|server-only-test-credential/);
    });
  } finally {
    await close(server);
  }
}

console.log(`\n${checks} workspace server checks passed. All listeners were ephemeral; no live OpenRouter request was made.`);
