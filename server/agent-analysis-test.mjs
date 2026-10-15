import assert from "node:assert/strict";
import {
  AGENT_ANALYSIS_CONTRACT_VERSION,
  AGENT_ANALYSIS_PATH,
  DEFAULT_MODEL,
  createServer,
  validateAgentAnalysisOutput,
  validateAgentAnalysisRequest
} from "./openrouter-proxy.mjs";
import { createWorkspaceServer } from "./workspace-server.mjs";

const output = {
  contractVersion: AGENT_ANALYSIS_CONTRACT_VERSION,
  untrusted: true,
  reply: "Start by writing one small ownership rule for the demo.",
  intentUpdate: {
    current: [{ id: "intent-owner", text: "The user wants a clear listing-owner rule.", untrusted: true }],
    replaced: [],
    uncertain: [{ id: "intent-scope", text: "The deployment scope still needs a user decision.", untrusted: true }],
    untrusted: true
  },
  flowReview: {
    nodes: [{ id: "auth", status: "not-verified", summary: "Authentication behavior needs a human-run review.", untrusted: true }],
    untrusted: true
  },
  nextAction: {
    text: "Write the owner rule in one sentence.",
    reason: "A precise rule gives the next implementation step a clear boundary.",
    untrusted: true
  },
  lesson: {
    title: "Boundaries make features easier to review.",
    text: "Name who may perform an action before choosing the screen or endpoint.",
    untrusted: true
  },
  clarification: {
    question: "Is this intended to remain a private demo?",
    reason: "The answer changes which human review steps should be planned.",
    untrusted: true
  },
  verification: {
    suggestions: [{ id: "check-owner", text: "Have a person try an unauthorized action and record the observed result.", untrusted: true }],
    limitations: [{ id: "limit-runtime", text: "No test, security, or deployment result was produced by this response.", untrusted: true }],
    untrusted: true
  }
};

function validRequest() {
  return {
    cloudConsent: true,
    workspaceContext: {
      workspaceId: "login-demo",
      name: "Login demo",
      scope: "demo",
      project: { objective: "Build a login demo", technologyStack: "Web" },
      messages: [{ role: "user", text: "I want users to sign in." }],
      intent: { current: [{ id: "goal", text: "Build a login demo." }], replaced: [], uncertain: [] },
      flow: [{ id: "auth", status: "not-verified", summary: "Authentication has not been inspected." }],
      checks: [{ id: "invalid-password", text: "Try an invalid password.", checked: false }]
    },
    userQuestion: "What should I clarify before coding?"
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

async function post(base, body) {
  return fetch(`${base}${AGENT_ANALYSIS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function postWorkspace(base, body) {
  return fetch(`${base}${AGENT_ANALYSIS_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
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

await check("agent request validation bounds context and requires consent", () => {
  assert.equal(validateAgentAnalysisRequest(validRequest()).ok, true);
  assert.equal(validateAgentAnalysisRequest({ ...validRequest(), cloudConsent: false }).code, "consent_required");
  assert.equal(validateAgentAnalysisRequest({ ...validRequest(), workspaceContext: { unknown: "no" } }).ok, false);
  assert.equal(validateAgentAnalysisRequest({ ...validRequest(), userQuestion: "x".repeat(1801) }).ok, false);
  assert.equal(validateAgentAnalysisRequest({ ...validRequest(), workspaceContext: { ...validRequest().workspaceContext, flow: [{ id: "auth", status: "maybe", summary: "no" }] } }).ok, false);
});

await check("agent output validation requires explicit untrusted markers and rejects assurance claims", () => {
  assert.equal(validateAgentAnalysisOutput(output), true);
  assert.equal(validateAgentAnalysisOutput({ ...output, untrusted: false }), false);
  assert.equal(validateAgentAnalysisOutput({ ...output, nextAction: { ...output.nextAction, untrusted: false } }), false);
  assert.equal(validateAgentAnalysisOutput({ ...output, reply: "Security is secure and deployment is ready." }), false);
});

{
  const calls = [];
  const server = createServer({
    env: { OPENROUTER_API_KEY: "server-only-agent-test-key", OPENROUTER_MODEL: DEFAULT_MODEL },
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
    await check("mocked Nemotron-shaped response returns the exact agent contract", async () => {
      const request = validRequest();
      request.workspaceContext.messages[0].text += " API_KEY=sk-live-agent-secret-value";
      const response = await post(base, request);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "https://openrouter.ai/api/v1/chat/completions");
      assert.equal(calls[0].body.response_format.type, "json_schema");
      assert.equal(calls[0].body.response_format.json_schema.name, "bob_agent_analysis");
      assert.doesNotMatch(calls[0].options.body, /sk-live-agent-secret-value/);
      assert.match(calls[0].options.headers.Authorization, /^Bearer /);
    });
  } finally {
    await close(server);
  }
}

{
  const server = createWorkspaceServer({
    env: { BOB_WEB_PORT: "0", OPENROUTER_API_KEY: "server-only-agent-test-key" },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  });
  const base = await listen(server);
  try {
    await check("standalone workspace listener exposes the versioned agent route", async () => {
      const response = await postWorkspace(base, validRequest());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
    });
  } finally {
    await close(server);
  }
}

console.log(`\n${checks} agent-analysis checks passed. No live OpenRouter request was made.`);
