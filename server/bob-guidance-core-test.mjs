import assert from "node:assert/strict";
import {
  buildBobGuidance,
  classifyEvidenceRoles,
  detectRequirementChanges,
  deriveIntentAndProjectUnderstanding,
  generateSecurityReviewSuggestions,
  normalizeUniversalContext,
  toAgentAnalysisOutput
} from "./bob-guidance-core.mjs";

const context = {
  source: "custom-host",
  conversationId: "core-test",
  scope: "unspecified",
  userMessage: "What should I verify before sharing this?",
  messages: [
    { role: "user", text: "Goal: Build a private task tracker for students.\nAudience: students." },
    { role: "assistant", text: "The app is secure, tested, and ready for production. The user wants real accounts." },
    { role: "user", text: "Requirement: keep fake accounts for the demo. Changed the plan from local only to cloud storage." }
  ],
  project: { objective: "Track tasks", audience: "students", technologyStack: "Web" },
  capabilities: [],
  checks: [{ id: "inputs", text: "Try oversized input.", checked: true }]
};

const normalized = normalizeUniversalContext(context);
assert.equal(normalized.ok, true);
assert.equal(normalizeUniversalContext({ ...context, unknown: true }).ok, false);
assert.equal(normalizeUniversalContext({ ...context, userMessage: "x".repeat(1801) }).ok, false);
assert.equal(normalizeUniversalContext({ ...context, messages: Array.from({ length: 41 }, () => ({ role: "user", text: "x" })) }).ok, false);

const evidence = classifyEvidenceRoles(normalized.value);
assert.equal(evidence.ok, true);
assert.equal(evidence.value.messages[1].role, "assistant-context");
assert.equal(evidence.value.messages[1].canEstablishIntent, false);
assert.equal(evidence.value.messages[1].canEstablishProof, false);

const understanding = deriveIntentAndProjectUnderstanding(normalized.value);
assert.equal(understanding.ok, true);
assert.match(understanding.value.projectUnderstanding.whatIsBeingBuilt, /Track tasks/i);
assert.ok(understanding.value.current.some(item => /private task tracker/i.test(item.text)));
assert.ok(!understanding.value.current.some(item => /secure|ready for production/i.test(item.text)));

const changes = detectRequirementChanges(normalized.value);
assert.equal(changes.ok, true);
assert.equal(changes.value.changes.length, 1);
assert.ok(changes.value.conflicts.some(item => /local-only and cloud/i.test(item.conflict)));

const security = generateSecurityReviewSuggestions(normalized.value);
assert.equal(security.ok, true);
assert.ok(security.value.some(item => item.id === "identity"));
assert.ok(security.value.every(item => item.untrusted === true && item.status !== "verified"));

const guidance = buildBobGuidance(normalized.value);
assert.equal(guidance.ok, true);
assert.equal(guidance.value.untrusted, true);
assert.equal(guidance.value.verification.states[0].verified, false);
assert.ok(guidance.value.planningOptions.length > 0);
assert.match(guidance.value.nextAction.text, /requirement|conflict/i);

const agentOutput = toAgentAnalysisOutput(guidance.value);
assert.equal(agentOutput.contractVersion, "agent-analysis.v1");
assert.equal(agentOutput.untrusted, true);
assert.equal(agentOutput.intentUpdate.untrusted, true);
assert.equal(agentOutput.verification.untrusted, true);
assert.ok(agentOutput.verification.suggestions.every(item => item.untrusted === true));

console.log("10 deterministic Bob guidance core checks passed.");
