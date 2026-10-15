import assert from "node:assert/strict";
import {
  AGENT_ANALYSIS_CONTRACT_VERSION,
  AGENT_ANALYSIS_PATH,
  LOCAL_GUIDANCE_PATH,
  CHATBASE_MENTOR_PATH,
  DEFAULT_MODEL,
  GENERIC_MENTOR_PATH,
  MAX_AGENT_CONTEXT_MESSAGES,
  MAX_TEXT_LENGTH,
  createServer,
  validateAgentAnalysisOutput,
  validateAgentAnalysisRequest,
  validateChatbaseMentorRequest
} from "./openrouter-proxy.mjs";
import { createWorkspaceServer } from "./workspace-server.mjs";
import { normalizeGenericMentorRequest } from "./bob-mentor-adapter.mjs";

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

async function postWorkspaceLocalGuidance(base, body) {
  return fetch(`${base}${LOCAL_GUIDANCE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", Origin: base },
    body: JSON.stringify(body)
  });
}

async function postWorkspaceChatbase(base, body, secret = "chatbase-test-secret") {
  return fetch(`${base}${CHATBASE_MENTOR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: base,
      "x-bob-integration-secret": secret
    },
    body: JSON.stringify(body)
  });
}

async function postWorkspaceChatbaseServerToServer(base, body, secret = "chatbase-test-secret") {
  return fetch(`${base}${CHATBASE_MENTOR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bob-integration-secret": secret
    },
    body: JSON.stringify(body)
  });
}

async function postWorkspaceGeneric(base, body, secret = "generic-test-secret") {
  return fetch(`${base}${GENERIC_MENTOR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Origin: base,
      "x-bob-integration-secret": secret
    },
    body: JSON.stringify(body)
  });
}

function chatbaseRequest() {
  return {
    source: "chatbase",
    agentId: "agent_demo",
    conversationId: "conversation_123",
    userId: "user_42",
    consent: true,
    userMessage: "What should I verify before sharing this project?",
    project: { projectName: "Task tracker", objective: "Keep personal data server-side" },
    messages: [{ role: "user", text: "Goal: Build a task tracker." }]
  };
}

function genericRequest() {
  return {
    source: "custom-host",
    conversationId: "conversation_generic_123",
    userId: "user_42",
    consent: true,
    userMessage: "What should I verify before sharing this project?",
    project: { projectName: "Task tracker", objective: "Keep personal data server-side" },
    messages: [{ role: "user", text: "Goal: Build a task tracker." }],
    capabilities: ["guidance", "review"]
  };
}

async function postChatbase(base, body, secret = "chatbase-test-secret") {
  return fetch(`${base}${CHATBASE_MENTOR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bob-integration-secret": secret
    },
    body: JSON.stringify(body)
  });
}

async function postGeneric(base, body, secret = "generic-test-secret") {
  return fetch(`${base}${GENERIC_MENTOR_PATH}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bob-integration-secret": secret
    },
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

await check("Chatbase adapter normalizes bounded action inputs and requires consent", () => {
  const normalized = validateChatbaseMentorRequest({ ...chatbaseRequest(), inputs: { question: "Use the declared action question." } });
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.agentId, "agent_demo");
  assert.equal(normalized.value.conversationId, "conversation_123");
  assert.equal(normalized.value.cloudConsent, true);
  assert.equal(normalized.value.userQuestion, "Use the declared action question.");
  assert.equal(normalized.value.workspaceContext.workspaceId, "chatbase:agent_demo:conversation_123");
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), consent: false }).code, "consent_required");
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), conversationId: "bad id" }).ok, false);
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), inputs: { question: "Use the declared action question." } }).value.userQuestion, "Use the declared action question.");
});

await check("integration validation rejects missing consent and conversation identity", () => {
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), consent: undefined }).code, "consent_required");
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), conversationId: undefined }).ok, false);
  assert.equal(validateChatbaseMentorRequest({ ...chatbaseRequest(), conversationId: "" }).ok, false);
});

await check("integration validation enforces bounded identifiers, messages, and context", () => {
  assert.equal(validateChatbaseMentorRequest({
    ...chatbaseRequest(),
    userMessage: "x".repeat(MAX_TEXT_LENGTH + 1)
  }).ok, false);
  assert.equal(validateChatbaseMentorRequest({
    ...chatbaseRequest(),
    messages: Array.from({ length: MAX_AGENT_CONTEXT_MESSAGES + 1 }, () => ({ role: "user", text: "x" }))
  }).ok, false);
  assert.equal(validateChatbaseMentorRequest({
    ...chatbaseRequest(),
    inputs: { conversationId: "bad id" }
  }).ok, false);
});

await check("generic guidance normalization preserves declared provider-neutral fields", () => {
  const normalized = normalizeGenericMentorRequest(genericRequest());
  assert.equal(normalized.ok, true);
  assert.equal(normalized.value.source, "custom-host");
  assert.equal(normalized.value.conversationId, "conversation_generic_123");
  assert.equal(normalized.value.cloudConsent, true);
  assert.deepEqual(normalized.value.capabilities, ["guidance", "review"]);
  assert.equal(normalized.value.workspaceContext.workspaceId, "custom-host:conversation_generic_123");
  assert.equal(normalized.value.userQuestion, genericRequest().userMessage);
});

await check("generic guidance normalization rejects consent, conversation, and bounded-input violations", () => {
  assert.equal(normalizeGenericMentorRequest({ ...genericRequest(), consent: false }).code, "consent_required");
  assert.equal(normalizeGenericMentorRequest({ ...genericRequest(), conversationId: undefined }).ok, false);
  assert.equal(normalizeGenericMentorRequest({ ...genericRequest(), userMessage: "x".repeat(MAX_TEXT_LENGTH + 1) }).ok, false);
  assert.equal(normalizeGenericMentorRequest({
    ...genericRequest(),
    messages: Array.from({ length: MAX_AGENT_CONTEXT_MESSAGES + 1 }, () => ({ role: "user", text: "x" }))
  }).ok, false);
  assert.equal(normalizeGenericMentorRequest({
    ...genericRequest(),
    capabilities: Array.from({ length: 21 }, () => "guidance")
  }).ok, false);
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
  const calls = [];
  const server = createServer({
    env: {
      OPENROUTER_API_KEY: "server-only-agent-test-key",
      OPENROUTER_MODEL: DEFAULT_MODEL,
      BOB_CHATBASE_SHARED_SECRET: "chatbase-test-secret"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
    }
  });
  const base = await listen(server);
  try {
    await check("Chatbase custom-action endpoint returns a compact untrusted mentor result", async () => {
      const response = await postChatbase(base, chatbaseRequest());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "success");
      assert.equal(body.data.untrusted, true);
      assert.equal(body.data.contractVersion, AGENT_ANALYSIS_CONTRACT_VERSION);
      assert.equal(body.data.conversationId, "conversation_123");
      assert.equal(body.data.nextStep.untrusted, true);
      assert.equal(calls.length, 1);
    });
    await check("Chatbase adapter response preserves the provider-neutral guidance shape", async () => {
      const body = await (await postChatbase(base, chatbaseRequest())).json();
      assert.deepEqual(Object.keys(body).sort(), ["data", "status"]);
      assert.equal(body.status, "success");
      assert.deepEqual(Object.keys(body.data).sort(), [
        "clarification",
        "contractVersion",
        "conversationId",
        "flowReview",
        "intentUpdate",
        "lesson",
        "limitations",
        "nextStep",
        "reply",
        "untrusted",
        "verificationNeeded"
      ].sort());
      assert.equal(body.data.untrusted, true);
      assert.equal(body.data.nextStep.untrusted, true);
      assert.equal(body.data.lesson.untrusted, true);
      assert.equal(body.data.clarification.untrusted, true);
      assert.equal(body.data.flowReview.untrusted, true);
      assert.equal(body.data.intentUpdate.untrusted, true);
    });
    await check("Chatbase adapter rejects missing or wrong integration secret", async () => {
      const response = await postChatbase(base, chatbaseRequest(), "wrong-secret");
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error.code, "integration_unauthorized");
      const missing = await postChatbase(base, chatbaseRequest(), "");
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).error.code, "integration_unauthorized");
    });
    await check("integration provider payload excludes user and integration secrets", async () => {
      const request = chatbaseRequest();
      request.userMessage += " API_KEY=sk-live-generic-integration-secret";
      request.project.objective += " password: 'integration-password-secret'";
      request.messages[0].text += " Bearer integration-bearer-secret";
      const response = await postChatbase(base, request);
      assert.equal(response.status, 200);
      assert.equal(calls.length, 3);
      const providerBody = calls.at(-1).options.body;
      assert.doesNotMatch(providerBody, /sk-live-generic-integration-secret|integration-password-secret|integration-bearer-secret|chatbase-test-secret/);
      assert.match(calls.at(-1).options.headers.Authorization, /^Bearer /);
    });
  } finally {
    await close(server);
  }
}

{
  const calls = [];
  const server = createServer({
    env: {
      OPENROUTER_API_KEY: "server-only-generic-test-key",
      OPENROUTER_MODEL: DEFAULT_MODEL,
      BOB_GENERIC_SHARED_SECRET: "generic-test-secret"
    },
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 });
    }
  });
  const base = await listen(server);
  try {
    await check("generic mentor endpoint returns the provider-neutral untrusted guidance envelope", async () => {
      const response = await postGeneric(base, genericRequest());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(Object.keys(body).sort(), ["data", "status"]);
      assert.equal(body.status, "success");
      assert.deepEqual(Object.keys(body.data).sort(), [
        "capabilities",
        "clarification",
        "contractVersion",
        "conversationId",
        "flowReview",
        "intentUpdate",
        "lesson",
        "nextAction",
        "reply",
        "source",
        "untrusted",
        "userId",
        "verification"
      ].sort());
      assert.equal(body.data.source, "custom-host");
      assert.equal(body.data.conversationId, "conversation_generic_123");
      assert.equal(body.data.userId, "user_42");
      assert.deepEqual(body.data.capabilities, ["guidance", "review"]);
      assert.equal(body.data.contractVersion, AGENT_ANALYSIS_CONTRACT_VERSION);
      assert.equal(body.data.untrusted, true);
      assert.equal(body.data.nextAction.untrusted, true);
      assert.equal(body.data.verification.untrusted, true);
      assert.equal(calls.length, 1);
    });
    await check("generic mentor endpoint rejects an absent or incorrect shared secret", async () => {
      const wrong = await postGeneric(base, genericRequest(), "wrong-secret");
      assert.equal(wrong.status, 401);
      assert.equal((await wrong.json()).error.code, "integration_unauthorized");
      const missing = await postGeneric(base, genericRequest(), "");
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).error.code, "integration_unauthorized");
      assert.equal(calls.length, 1);
    });
    await check("generic mentor provider payload contains no user or shared secrets", async () => {
      const request = genericRequest();
      request.userMessage += " API_KEY=sk-live-generic-route-secret-value";
      request.project.objective += " password: 'generic-password-secret'";
      request.messages[0].text += " Bearer generic-bearer-secret-value";
      const response = await postGeneric(base, request);
      assert.equal(response.status, 200);
      assert.equal(calls.length, 2);
      const providerBody = calls.at(-1).options.body;
      assert.doesNotMatch(providerBody, /sk-live-generic-route-secret-value|generic-password-secret|generic-bearer-secret-value|generic-test-secret/);
      assert.match(calls.at(-1).options.headers.Authorization, /^Bearer /);
    });
  } finally {
    await close(server);
  }
}

{
  const server = createWorkspaceServer({
    env: {
      BOB_WEB_PORT: "0",
      OPENROUTER_API_KEY: "server-only-agent-test-key",
      BOB_CHATBASE_SHARED_SECRET: "chatbase-test-secret",
      BOB_GENERIC_SHARED_SECRET: "generic-test-secret"
    },
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }), { status: 200 })
  });
  const base = await listen(server);
  try {
    await check("standalone workspace listener exposes the versioned agent route", async () => {
      const response = await postWorkspace(base, validRequest());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), output);
    });
    await check("workspace listener exposes deterministic local guidance", async () => {
      const response = await postWorkspaceLocalGuidance(base, {
        workspaceContext: {
          source: "workspace",
          conversationId: "login-demo",
          scope: "demo",
          project: validRequest().workspaceContext.project,
          messages: validRequest().workspaceContext.messages,
          capabilities: ["conversation-context"],
          checks: validRequest().workspaceContext.checks
        },
        userQuestion: "What should I clarify before coding?"
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.contractVersion, "bob-guidance-core.v1");
      assert.equal(body.untrusted, true);
      assert.ok(body.nextAction && body.securityReview);
    });
    await check("workspace listener exposes the Chatbase adapter route", async () => {
      const response = await postWorkspaceChatbase(base, chatbaseRequest());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "success");
      assert.equal(body.data.untrusted, true);
      assert.equal(body.data.conversationId, "conversation_123");
    });
    await check("workspace Chatbase adapter accepts server-to-server requests without Origin", async () => {
      const response = await postWorkspaceChatbaseServerToServer(base, chatbaseRequest());
      assert.equal(response.status, 200);
      assert.equal((await response.json()).status, "success");
    });
    await check("workspace listener exposes the generic mentor route", async () => {
      const response = await postWorkspaceGeneric(base, genericRequest());
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, "success");
      assert.equal(body.data.source, "custom-host");
      assert.equal(body.data.conversationId, "conversation_generic_123");
    });
  } finally {
    await close(server);
  }
}

console.log(`\n${checks} agent-analysis/integration checks passed. No live OpenRouter request was made.`);
