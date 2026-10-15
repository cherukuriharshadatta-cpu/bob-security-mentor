import assert from "node:assert/strict";
import {
  DEFAULT_MODEL,
  MENTOR_PATH,
  createServer,
  redactSecrets,
  validateRequest
} from "./openrouter-proxy.mjs";

const output = {
  reply: "Start by writing the smallest timer requirement and a test for it.",
  projectUnderstanding: {
    whatIsBeingBuilt: "A timer app.",
    why: "The user wants a focused practice project.",
    targetUsers: "The project owner."
  },
  changedRequirements: [],
  nextStep: "Write one acceptance example for starting and stopping the timer.",
  securityReview: [
    {
      area: "Secrets",
      status: "needs-review",
      reason: "No implementation evidence was provided.",
      recommendedAction: "Keep provider credentials on the server."
    }
  ],
  openQuestions: [],
  uncertainty: ["The captured notes may omit earlier decisions."],
  verificationNeeded: ["Run the project's tests after implementation."]
};

function validRequest() {
  return {
    cloudConsent: true,
    conversationKey: "chatgpt:test_123",
    messages: [
      { role: "user", text: "Goal: Build a timer." },
      { role: "assistant", text: "What platform will you use?" }
    ],
    project: { objective: "Build a timer", technologyStack: "Web" },
    userMessage: "What should I do first?"
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => server.close(resolve));
}

async function post(base, body, headers = {}) {
  return fetch(`${base}${MENTOR_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

let checks = 0;
function check(name, run) {
  return Promise.resolve(run()).then(() => {
    checks += 1;
    console.log(`PASS ${name}`);
  });
}

await check("redaction handles keys, bearer tokens, passwords, env lines, and private key blocks", () => {
  const source = [
    "OPENAI_API_KEY=sk-live-example-value",
    "Authorization: Bearer abcdefghijklmnop",
    "password: 'correct horse battery staple'",
    "-----BEGIN PRIVATE KEY-----\nsecret material\n-----END PRIVATE KEY-----"
  ].join("\n");
  const redacted = redactSecrets(source);
  assert.doesNotMatch(redacted, /sk-live-example-value|abcdefghijklmnop|correct horse battery staple|secret material/);
  assert.match(redacted, /REDACTED/);
});

await check("validation enforces consent, bounded messages, known project fields, and the conversation key", () => {
  assert.equal(validateRequest(validRequest()).ok, true);
  assert.equal(validateRequest({ ...validRequest(), cloudConsent: false }).code, "consent_required");
  assert.equal(validateRequest({ ...validRequest(), conversationKey: "chatgpt:bad/key" }).ok, false);
  assert.equal(validateRequest({ ...validRequest(), messages: Array.from({ length: 41 }, () => ({ role: "user", text: "x" })) }).ok, false);
  assert.equal(validateRequest({ ...validRequest(), project: { unknown: "no" } }).ok, false);
});

{
  const server = createServer({ env: {} });
  const base = await listen(server);
  try {
    await check("health is available without a provider key", async () => {
      const response = await fetch(`${base}/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, providerConfigured: false, model: DEFAULT_MODEL });
    });

    await check("allowed ChatGPT CORS is echoed and preflight succeeds", async () => {
      const response = await fetch(`${base}${MENTOR_PATH}`, {
        method: "OPTIONS",
        headers: { Origin: "https://chatgpt.com", "Access-Control-Request-Method": "POST" }
      });
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "https://chatgpt.com");
    });

    await check("unapproved origins are rejected", async () => {
      const response = await fetch(`${base}${MENTOR_PATH}`, {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }
      });
      assert.equal(response.status, 403);
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    });

    await check("invalid input is rejected before a missing key becomes relevant", async () => {
      const response = await post(base, { ...validRequest(), cloudConsent: "yes" }, { Origin: "http://localhost:3000" });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "consent_required");
    });
  } finally {
    await close(server);
  }
}

{
  const model = "nvidia/nemotron-test-model";
  const server = createServer({ env: { OPENROUTER_API_KEY: "server-only-test-key", OPENROUTER_MODEL: model } });
  const base = await listen(server);
  try {
    await check("configured health reports the model and never returns the provider credential", async () => {
      const response = await fetch(`${base}/health`);
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(body), { ok: true, providerConfigured: true, model });
      assert.doesNotMatch(body, /server-only-test-key|apiKey|OPENROUTER_API_KEY/);
    });
  } finally {
    await close(server);
  }
}

{
  const calls = [];
  const server = createServer({
    env: { OPENROUTER_API_KEY: "server-only-test-key", OPENROUTER_MODEL: DEFAULT_MODEL },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });
  const base = await listen(server);
  try {
    await check("successful model response uses strict structured output and redacted reference data", async () => {
      const request = validRequest();
      request.messages[0].text += " API_KEY=sk-live-secret-value";
      const response = await post(base, request, { Origin: "https://chatgpt.com" });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(calls[0].body.model, DEFAULT_MODEL);
      assert.equal(calls[0].body.response_format.type, "json_schema");
      assert.doesNotMatch(calls[0].options.body, /sk-live-secret-value/);
      assert.match(calls[0].options.headers.Authorization, /^Bearer /);
    });
  } finally {
    await close(server);
  }
}

{
  let calls = 0;
  const requestBodies = [];
  const server = createServer({
    env: { OPENROUTER_API_KEY: "server-only-test-key" },
    fetchImpl: async (_url, options) => {
      calls += 1;
      requestBodies.push(JSON.parse(options.body));
      if (calls === 1) return new Response("structured output is unsupported", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
    }
  });
  const base = await listen(server);
  try {
    await check("structured-output rejection gets exactly one json_object fallback", async () => {
      const response = await post(base, validRequest());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
      assert.equal(calls, 2);
      assert.equal(requestBodies[0].response_format.type, "json_schema");
      assert.deepEqual(requestBodies[1].response_format, { type: "json_object" });
    });
  } finally {
    await close(server);
  }
}

{
  const server = createServer({
    env: { OPENROUTER_API_KEY: "server-only-test-key" },
    fetchImpl: async () => new Response("provider secret sk-live-provider-secret-value", { status: 503 })
  });
  const base = await listen(server);
  try {
    await check("provider failure is safe and does not expose upstream text", async () => {
      const response = await post(base, validRequest());
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.doesNotMatch(text, /sk-live-provider-secret-value|provider secret/);
      assert.equal(JSON.parse(text).error.code, "provider_error");
    });
  } finally {
    await close(server);
  }
}

console.log(`\n${checks} server checks passed. No live OpenRouter request was made.`);
