import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const model = require("../web/project.js");
let checks = 0;
function test(name, run) {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
}

test("creates a real empty workspace without seed claims", () => {
  const state = model.createWorkspace({ id: "empty", name: "My workspace", now: "2026-10-15T00:00:00Z" });
  assert.equal(state.id, "empty");
  assert.equal(state.name, "My workspace");
  assert.equal(state.messages.length, 0);
  assert.equal(state.sources.length, 0);
  assert.equal(state.scope, "unspecified");
  assert.equal(state.memory.intentLedger.items.length, 0);
  const analysis = model.analyzeWorkspace(state);
  assert.equal(analysis.clarification, null);
  assert.deepEqual(analysis.flow.map((node) => node.id), ["intent", "experience", "inputs", "auth", "data", "verification"]);
  assert.ok(analysis.flow.every((node) => node.status === "unknown" && node.verified === false));
  assert.ok(analysis.flow.every((node) => /Not verified/i.test(node.label)));
  assert.equal(analysis.onboarding.status, "needs-brief");
  assert.equal(analysis.onboarding.needsBrief, true);
  assert.ok(Object.isFrozen(state));
});

test("onboarding adds an explicit user brief without using the demo fixture", () => {
  const empty = model.createWorkspace({ id: "onboarding", now: "t0" });
  const state = model.addUserBrief(empty, "Goal: Build a private timer.", { now: "t1" });
  assert.equal(empty.messages.length, 0);
  assert.deepEqual(state.messages.map((message) => [message.role, message.source]), [["user", "brief"]]);
  assert.equal(model.onboarding(state).status, "brief-recorded");
  assert.equal(model.onboarding(state).userBrief, "Goal: Build a private timer.");
  assert.equal(model.createWorkspace({ id: "fixture", brief: model.DEMO_BRIEF, now: "t0" }).messages.length, 1);
});

test("briefs and imports preserve explicit roles and source attribution", () => {
  const state = model.createWorkspace({
    id: "transcript",
    name: "Transcript workspace",
    brief: "Goal: Build a private demo with fake accounts.",
    messages: [
      { role: "assistant", text: "You could deploy this publicly." },
      { role: "user", text: "Requirement: Users can edit only their own records." }
    ],
    now: "2026-10-15"
  });
  assert.deepEqual(state.messages.map((message) => message.role), ["user", "assistant", "user"]);
  assert.ok(state.messages.every((message) => message.source === "brief" || message.source === "transcript"));
  const analysis = model.analyzeWorkspace(state);
  assert.ok(analysis.intent.current.some((item) => item.text.includes("private demo")));
  assert.ok(!analysis.intent.current.some((item) => item.text.includes("deploy this publicly")));
  assert.ok(analysis.intent.current.every((item) => item.source.role === "user"));
  assert.ok(model.exportMarkdown(state).includes("User message"));
});

test("assistant text cannot establish intent or project completion", () => {
  let state = model.createWorkspace({ id: "roles", now: "now" });
  state = model.importTranscript(state, "Assistant: Goal: Ship a banking app\nUser: Goal: Build a toy timer", { now: "later" });
  assert.equal(state.memory.intentLedger.items.length, 1);
  assert.equal(state.memory.intentLedger.items[0].text, "Build a toy timer");
  assert.equal(state.memory.project.deploymentReadiness, "");
  assert.ok(!model.exportMarkdown(state).includes("Ship a banking app — source"));
});

test("assistant-only security topics and user questions do not request scope clarification", () => {
  let state = model.createWorkspace({ id: "assistant-only", now: "t0" });
  state = model.appendAssistantMessage(state, "Use login, passwords and private records for the app.", { now: "t1" });
  let analysis = model.analyzeWorkspace(state);
  assert.equal(analysis.clarification, null);
  assert.equal(analysis.intent.current.length, 0);
  assert.ok(analysis.findings.some((finding) => finding.status === "mentioned"));

  state = model.appendUserMessage(state, "Can you explain login and private records?", { now: "t2" });
  analysis = model.analyzeWorkspace(state);
  assert.equal(analysis.clarification, null);
  assert.equal(analysis.intent.current.length, 0);
});

test("append and restore are immutable and enforce message and text bounds", () => {
  let state = model.createWorkspace({ id: "bounds", now: "t0" });
  const before = JSON.stringify(state);
  const long = "x".repeat(model.MAX_TEXT_LENGTH + 200);
  for (let index = 0; index < model.MAX_MESSAGES + 8; index += 1) {
    state = model.appendUserMessage(state, `${index}: ${long}`, { now: `t${index}` });
  }
  assert.equal(state.messages.length, model.MAX_MESSAGES);
  assert.ok(state.messages.every((message) => message.text.length <= model.MAX_TEXT_LENGTH));
  assert.equal(model.createWorkspace({ id: "bounds", now: "t0" }).messages.length, 0);
  assert.notEqual(JSON.stringify(state), before);
  assert.ok(Object.isFrozen(state.messages));
  assert.ok(Object.isFrozen(state.memory));
  const roundTrip = model.restoreWorkspace(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(roundTrip.messages, state.messages);
  assert.deepEqual(roundTrip.memory.intentLedger, state.memory.intentLedger);
});

test("scope changes are explicit and old user-reported checks need repeating", () => {
  let state = model.createWorkspace({ id: "scope", brief: "Goal: Build an account demo.", now: "t0" });
  state = model.chooseScope(state, "demo", { now: "t1" });
  state = model.recordCheck(state, "record-ownership", true, { now: "t2" });
  assert.equal(state.scope, "demo");
  assert.equal(state.messages.length, 1, "choosing scope is workspace metadata, not a fabricated transcript turn");
  assert.equal(model.analyzeWorkspace(state).checkCounts.checked, 1);
  state = model.chooseScope(state, "production", { now: "t3" });
  const analysis = model.analyzeWorkspace(state);
  assert.equal(analysis.scope, "production");
  assert.equal(analysis.checkCounts.needsRepeat, 1);
  assert.equal(analysis.checks.find((check) => check.id === "record-ownership").verified, false);
  assert.equal(analysis.clarification, null);
});

test("unknown scope produces a security-relevant clarification and a six-node conceptual flow", () => {
  let state = model.createWorkspace({ id: "security", now: "t0" });
  state = model.appendUserMessage(state, "Goal: Build sign-in with accounts and private records.", { now: "t1" });
  const analysis = model.analyzeWorkspace(state);
  assert.deepEqual(analysis.flow.map((node) => node.id), ["intent", "experience", "inputs", "auth", "data", "verification"]);
  assert.equal(analysis.flowKind, "conceptual");
  assert.match(analysis.clarification.question, /demo|production/);
  assert.ok(analysis.findings.some((finding) => finding.status === "mentioned"));
  assert.ok(analysis.findings.every((finding) => finding.verified === false));
  assert.equal(analysis.checkCounts.verified, 0);
  assert.match(analysis.limitations, /does not.*execute tests/i);
});

test("lessons and local replies teach auth ownership without overwriting the goal", () => {
  let state = model.createWorkspace({ id: "lesson", brief: "Goal: Build a private notes app.", now: "t0" });
  const before = state.memory.guidance.currentGoal;
  const lesson = model.lessonFor("auth", state);
  for (const key of ["explanation", "why", "recommendedChange", "secureExample", "verification"]) {
    assert.ok(lesson[key], key);
  }
  assert.match(lesson.secureExample, /owner_id|ownership|session/i);
  const reply = model.localReply("How do I stop one account reading another account's record?", state);
  assert.match(reply, /Deterministic local teaching/);
  assert.match(reply, /owner|ownership/i);
  assert.equal(state.memory.guidance.currentGoal, before);
  assert.deepEqual(model.toCloudPayload(state, "What should I do next?").conversationKey, "workspace:lesson");
  assert.equal(model.toCloudPayload(state, "What should I do next?").cloudConsent, true);
});

test("malformed restore is rejected and export cannot trust injected derived state", () => {
  assert.equal(model.restoreWorkspace(null), null);
  assert.equal(model.restoreWorkspace({ schemaVersion: 99, id: "x", messages: [] }), null);
  assert.equal(model.restoreWorkspace({ schemaVersion: 1, id: "bad id", messages: [] }), null);
  assert.throws(() => model.exportMarkdown({ id: "not-a-workspace" }), TypeError);
  const state = model.createWorkspace({ id: "safe", brief: "Goal: Build a timer.", now: "t0" });
  const parsed = JSON.parse(JSON.stringify(state));
  parsed.memory = { project: { objective: "Assistant claimed this was deployed" }, intentLedger: { items: [] } };
  parsed.scope = "production";
  const restored = model.restoreWorkspace(parsed);
  assert.equal(restored.memory.project.objective, "Build a timer.");
  assert.equal(restored.scope, "production");
  const markdown = model.exportMarkdown(restored);
  assert.match(markdown, /not.*verified|limitations/i);
  assert.doesNotMatch(markdown, /Assistant claimed this was deployed/);
});

test("UMD browser path exposes BobWorkspaceModel next to BobMentorCore", () => {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../src/core.js", import.meta.url), "utf8"), context);
  vm.runInContext(fs.readFileSync(new URL("../web/project.js", import.meta.url), "utf8"), context);
  assert.equal(typeof context.BobWorkspaceModel.createWorkspace, "function");
  assert.equal(context.BobWorkspaceModel.createWorkspace({ id: "browser", now: "t" }).id, "browser");
});

console.log(`PASS workspace-model (${checks} checks)`);
