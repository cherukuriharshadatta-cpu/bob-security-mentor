import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { makeDocument, append } from "./dom-fixture.mjs";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");
const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
let checks = 0;
function test(name, run) { run(); checks++; console.log(`PASS ${name}`); }
const msg = (role, text) => ({ role, text });
const key = "chatgpt:test";
const at = n => `2026-10-13T00:00:${String(n).padStart(2, "0")}.000Z`;

test("manifest is local-only MV3 with canonical host and bundled shadow stylesheet", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://chatgpt.com/*"]);
  assert.equal(manifest.content_scripts[0].css, undefined);
  assert.deepEqual(manifest.web_accessible_resources[0].resources, ["src/styles.css"]);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*", "http://localhost/*"]);
});

test("only supported HTTPS conversation routes receive keys", () => {
  for (const path of ["/c/abc_123", "/c/abc_123/", "/g/project-slug/c/abc_123", "/g/g-p-example-project/c/abc_123"]) {
    assert.equal(core.conversationKeyFromUrl(`https://chatgpt.com${path}?model=example#top`), "chatgpt:abc_123");
  }
  for (const url of ["/c/a", "https://chatgpt.com/", "https://example.com/c/a", "http://chatgpt.com/c/a", "https://chatgpt.com:8443/c/a", "https://chatgpt.com.evil/c/a", "https://www.chatgpt.com/c/a", "https://chatgpt.com/c/a/extra", "https://chatgpt.com/c/%61", "https://chatgpt.com/x/../c/a", "https://chatgpt.com/c/a\\x", "https://user@chatgpt.com/c/a", "https://chatgpt.com/share/a"]) {
    assert.equal(core.conversationKeyFromUrl(url), null, url);
  }
});

test("capture preserves interleaved order and excludes non-conversation text", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main");
  append(main, "div", { "data-message-author-role": "user" }, "Build a timer");
  append(main, "div", { "data-message-author-role": "assistant" }, "Choose a platform");
  append(main, "div", { "data-message-author-role": "user" }, "I want to build a web timer");
  const nav = append(main, "nav");
  append(nav, "div", { "data-message-author-role": "user" }, "PRIVATE SIDEBAR");
  const hidden = append(main, "section", { "aria-hidden": "true" });
  append(hidden, "div", { "data-message-author-role": "user" }, "HIDDEN");
  append(main, "textarea", { "data-message-author-role": "user" }, "UNSENT DRAFT");
  const bob = append(main, "div", { id: "bob-mentor-root" });
  append(bob, "div", { "data-message-author-role": "user" }, "BOB MEMORY");
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.ok(!JSON.stringify(result).match(/PRIVATE|HIDDEN|UNSENT|BOB MEMORY/));
});

test("capture works when the thread has no main element and turn metadata lacks data-turn", () => {
  const doc = makeDocument();
  const shell = append(doc.body, "div", { id: "thread-shell" });
  const userTurn = append(shell, "article", { "data-testid": "conversation-turn-1" });
  append(userTurn, "div", { "data-message-author-role": "user" }, "Build a to-do app");
  const assistantTurn = append(shell, "article", { "data-testid": "conversation-turn-2" });
  append(assistantTurn, "div", { "data-message-author-role": "assistant" }, "Start with the task model.");
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.deepEqual(result.messages, [msg("user", "Build a to-do app"), msg("assistant", "Start with the task model.")]);
  assert.match(result.diagnostic, /conversation-turn/);
});

test("display:contents and explicit turn fallback capture without duplicate wrappers", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main");
  const turn = append(main, "article", { "data-testid": "conversation-turn-1", "data-turn": "user" });
  const wrapper = append(turn, "div", { "data-message-author-role": "user" }, "", { display: "contents" });
  append(wrapper, "p", {}, "Goal: Build an Android to-do app");
  append(wrapper, "button", {}, "Copy");
  append(main, "article", { "data-testid": "conversation-turn-2", "data-turn": "assistant" }, "Start with one task.");
  const result = core.extractConversation(doc);
  assert.deepEqual(result.messages, [msg("user", "Goal: Build an Android to-do app"), msg("assistant", "Start with one task.")]);
});

test("accessible screen-reader labels classify bounded messages without leaking labels into text", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 500, left: 0, top: 0 });
  const user = append(main, "div", { class: "message-row" }, "", { width: 800, height: 70, left: 40, top: 40 });
  append(user, "h4", { class: "sr-only" }, "You");
  append(user, "p", {}, "Please help me plan a timer.");
  const assistant = append(main, "div", { class: "message-row" }, "", { width: 800, height: 90, left: 40, top: 140 });
  append(assistant, "h4", { class: "visually-hidden" }, "ChatGPT");
  append(assistant, "p", {}, "Start by defining the timer state.");
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "accessibleLabel");
  assert.deepEqual(result.messages, [
    msg("user", "Please help me plan a timer."),
    msg("assistant", "Start by defining the timer state.")
  ]);
  assert.equal(result.diagnostics.source, "accessibleLabel");
  assert.equal(result.diagnostics.capturedMessages, 2);
  assert.doesNotMatch(JSON.stringify(result.messages), /You|ChatGPT|sr-only|visually-hidden/);
});

test("accessible aria-labelledby labels classify the nearest visible message container", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 400, left: 0, top: 0 });
  const label = append(main, "h4", { id: "human-label", class: "sr-only" }, "Human");
  const row = append(main, "div", { "aria-labelledby": "human-label" }, "", { width: 700, height: 60, left: 100, top: 30 });
  append(row, "p", {}, "A message labelled through an accessible reference.");
  const result = core.extractConversation(doc);
  assert.equal(result.source, "accessibleLabel");
  assert.deepEqual(result.messages, [msg("user", "A message labelled through an accessible reference.")]);
  assert.doesNotMatch(result.messages[0].text, /Human/);
  void label;
});

test("visible speaker headings use their parent message container", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 400, left: 0, top: 0 });
  const user = append(main, "div", { class: "block-user" }, "", { width: 700, height: 60, left: 100, top: 30 });
  append(user, "h4", {}, "You said:");
  append(user, "p", {}, "nvm lets try minecraft actually");
  const assistant = append(main, "div", { class: "block-assistant" }, "", { width: 700, height: 80, left: 100, top: 130 });
  append(assistant, "h4", {}, "ChatGPT said:");
  append(assistant, "p", {}, "Let us make a small block-world prototype.");
  const result = core.extractConversation(doc);
  assert.equal(result.source, "accessibleLabel");
  assert.deepEqual(result.messages, [
    msg("user", "nvm lets try minecraft actually"),
    msg("assistant", "Let us make a small block-world prototype.")
  ]);
});

test("accessible labels do not merge speakers from one shared outer container", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 500, left: 0, top: 0 });
  const outer = append(main, "div", { class: "conversation" }, "", { width: 900, height: 240, left: 0, top: 20 });
  append(outer, "h4", { class: "sr-only" }, "You");
  append(outer, "div", { class: "user-bubble" }, "Can we make a game like Roblox?", { width: 300, height: 58, left: 570, top: 40 });
  append(outer, "h4", { class: "sr-only" }, "ChatGPT");
  append(outer, "div", { class: "assistant-response" }, "Yes, we can start with a small prototype.", { width: 700, height: 80, left: 80, top: 140 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "visualLayout");
  assert.deepEqual(result.messages, [
    msg("user", "Can we make a game like Roblox?"),
    msg("assistant", "Yes, we can start with a small prototype.")
  ]);
  assert.doesNotMatch(result.messages[0].text, /small prototype/);
});

test("accessible role anchors capture bounded sibling segments inside a mixed wrapper", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 500, left: 0, top: 0 });
  const outer = append(main, "div", { class: "thread-shell" }, "", { width: 900, height: 240, left: 0, top: 20 });
  const userAnchor = append(outer, "div", { class: "speaker-anchor" }, "", { width: 200, height: 20, left: 20, top: 30 });
  append(userAnchor, "h4", { class: "sr-only" }, "You");
  append(outer, "div", { class: "user-bubble" }, "Build a small game.", { width: 300, height: 58, left: 570, top: 50 });
  const assistantAnchor = append(outer, "div", { class: "speaker-anchor" }, "", { width: 200, height: 20, left: 20, top: 130 });
  append(assistantAnchor, "h4", { class: "sr-only" }, "ChatGPT");
  append(outer, "div", { class: "assistant-response" }, "Start with a playable prototype.", { width: 700, height: 80, left: 80, top: 150 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "accessibleLabel");
  assert.deepEqual(result.messages, [
    msg("user", "Build a small game."),
    msg("assistant", "Start with a playable prototype.")
  ]);
  assert.equal(result.diagnostics.matchedUsers, 1);
  assert.equal(result.diagnostics.capturedUsers, 1);
  assert.equal(result.diagnostics.rejectedUsers["mixed-speakers"], 0);
});

test("accessible role anchors capture bodies below display-contents wrappers", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 500, left: 0, top: 0 });
  const outer = append(main, "div", { class: "thread-shell" }, "", { width: 900, height: 240, left: 0, top: 20 });
  const userShell = append(outer, "div", { class: "message-shell" }, "", { display: "contents" });
  append(userShell, "h4", { class: "sr-only" }, "You");
  append(userShell, "div", { class: "message-body" }, "Actually, let us try Minecraft.", { width: 320, height: 58, left: 540, top: 50 });
  const assistantShell = append(outer, "div", { class: "message-shell" }, "", { display: "contents" });
  append(assistantShell, "h4", { class: "sr-only" }, "ChatGPT");
  append(assistantShell, "div", { class: "message-body" }, "We can make a small block-world prototype.", { width: 700, height: 80, left: 80, top: 150 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "accessibleLabel");
  assert.deepEqual(result.messages, [
    msg("user", "Actually, let us try Minecraft."),
    msg("assistant", "We can make a small block-world prototype.")
  ]);
  assert.equal(result.diagnostics.capturedUsers, 1);
  assert.equal(result.diagnostics.capturedAssistants, 1);
});

test("unsupported DOM and hidden-only messages fail with a diagnostic, not page scraping", () => {
  const doc = makeDocument();
  append(doc.body, "div", {}, "Do not scrape arbitrary page text");
  assert.equal(core.extractConversation(doc).status, "not-found");
  const main = append(doc.body, "main");
  append(main, "div", { "data-message-author-role": "user" }, "Hidden", { display: "none" });
  const result = core.extractConversation(doc);
  assert.deepEqual(result.messages, []);
  assert.match(result.diagnostic, /no readable/);
});

test("visual-layout fallback captures right-aligned user and left-aligned assistant blocks only", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 700, left: 0, top: 0 });
  append(main, "div", { class: "user-bubble" }, "Can we make a game like Roblox?", { width: 300, height: 58, left: 570, top: 40 });
  append(main, "div", { class: "assistant-response" }, "Yes, we can start with a small game prototype.", { width: 700, height: 80, left: 80, top: 140 });
  append(main, "div", { class: "composer" }, "Ask ChatGPT", { width: 700, height: 45, left: 80, top: 600 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "visualLayout");
  assert.deepEqual(result.messages.map(message => message.role), ["user", "assistant"]);
  assert.match(result.diagnostic, /approximate/);
});

test("visual-layout fallback uses parent row alignment for full-width ChatGPT-like blocks", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 700, left: 0, top: 0 });
  const userRow = append(main, "div", { class: "group flex justify-end" }, "", { width: 900, height: 70, left: 0, top: 40, display: "flex", justifyContent: "flex-end", marginLeft: "auto" });
  append(userRow, "div", { class: "max-w-3xl" }, "User text in a full-width rendered block.", { width: 900, height: 58, left: 0, top: 40 });
  const assistantRow = append(main, "div", { class: "group flex justify-start" }, "", { width: 900, height: 90, left: 0, top: 140, display: "flex", justifyContent: "flex-start", marginRight: "auto" });
  append(assistantRow, "div", { class: "prose markdown" }, "Assistant text in a full-width rendered block.", { width: 900, height: 78, left: 0, top: 140 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "ok");
  assert.equal(result.source, "visualLayout");
  assert.deepEqual(result.messages.map(message => message.role), ["user", "assistant"]);
  assert.deepEqual(result.messages.map(message => message.text), [
    "User text in a full-width rendered block.",
    "Assistant text in a full-width rendered block."
  ]);
  assert.equal(result.diagnostics.capturedMessages, 2);
  assert.ok(result.diagnostics.classifiedBlocks >= 2);
  assert.match(result.diagnostic, /source: visualLayout/);
  assert.doesNotMatch(result.diagnostic, /User text|Assistant text/);
});

test("visual-layout fallback excludes centered ambiguous blocks and reports bounded counts", () => {
  const doc = makeDocument();
  const main = append(doc.body, "main", {}, "", { width: 900, height: 400, left: 0, top: 0 });
  append(main, "div", { class: "welcome-panel" }, "Centered introductory text is not a message.", { width: 900, height: 80, left: 0, top: 80 });
  const result = core.extractConversation(doc);
  assert.equal(result.status, "not-found");
  assert.equal(result.source, "visualLayout");
  assert.equal(result.messages.length, 0);
  assert.equal(result.diagnostics.capturedMessages, 0);
  assert.equal(result.diagnostics.classifiedBlocks, 0);
  assert.ok(result.diagnostics.ambiguousBlocks >= 1);
  assert.match(result.diagnostic, /source: visualLayout/);
  assert.match(result.diagnostic, /ambiguous block/);
  assert.doesNotMatch(result.diagnostic, /Centered introductory/);
});

test("guidance separates users from assistants and retains explicit goal across questions", () => {
  const input = "user: I want to build a timer.\nassistant: I want to build a car.\nuser: Which platform should I choose?";
  const guidance = core.deriveGuidance(input);
  assert.match(guidance.currentGoal, /build a timer/);
  assert.doesNotMatch(guidance.currentGoal, /car/);
  assert.match(guidance.openQuestions, /possibly already answered/);
  assert.match(guidance.nextStep, /Which platform/);
});

test("intent ledger stores current intent, scope, confidence, and replacement history", () => {
  const messages = [
    msg("user", "Goal: Build a Roblox-style game for the hackathon demo."),
    msg("assistant", "The project is production ready."),
    msg("user", "Actually, the new goal is to build a Minecraft-style browser game for production. Requirement: The app must support beginner players. Maybe use JavaScript.")
  ];
  const ledger = core.intentLedgerFromMessages(messages, null, at(3));
  const currentGoals = ledger.items.filter(item => item.type === "goal" && item.status === "current");
  const replacedGoals = ledger.items.filter(item => item.type === "goal" && item.status === "replaced");
  assert.equal(currentGoals.length, 1);
  assert.match(currentGoals[0].text, /Minecraft-style browser game/);
  assert.equal(currentGoals[0].scope, "production");
  assert.equal(currentGoals[0].confidence, "high");
  assert.equal(replacedGoals.length, 1);
  assert.equal(replacedGoals[0].scope, "demo");
  assert.equal(replacedGoals[0].history.at(-1).status, "replaced");
  assert.equal(ledger.items.some(item => item.type === "requirement" && item.status === "current"), true);
  assert.equal(ledger.items.some(item => item.type === "decision" && item.status === "uncertain"), true);
  assert.match(core.intentClarificationCue(ledger), /Clarify this uncertain user statement/);
  assert.doesNotMatch(JSON.stringify(ledger), /production ready/);
});

test("memory persists the intent ledger and Markdown explains its evidence boundary", () => {
  const memory = core.memoryFromObservation(null, key, [
    msg("user", "Goal: Build a private demo dashboard."),
    msg("assistant", "Goal: Build a public banking platform.")
  ], at(4));
  assert.ok(memory.intentLedger);
  assert.equal(memory.intentLedger.items.length, 1);
  assert.match(memory.intentLedger.items[0].text, /private demo dashboard/);
  assert.doesNotMatch(JSON.stringify(memory.intentLedger), /banking/);
  assert.match(memory.markdown, /## Intent ledger/);
  assert.match(memory.markdown, /Only explicit user statements become ledger items/);
});

test("later intent beyond the old 1800-character snapshot limit replaces automatic goal", () => {
  const messages = [msg("user", "Goal: Build a timer"), ...Array.from({ length: 45 }, () => msg("assistant", "Long context ".repeat(200))), msg("user", "Instead build a recipe app.")];
  const memory = core.memoryFromObservation(null, key, messages, at(0));
  assert.equal(memory.messages.length, 40);
  assert.match(memory.project.objective, /recipe app/);
  assert.match(memory.guidance.currentGoal, /recipe app/);
  assert.ok(memory.messages.every(m => m.text.length <= 1800));
});

test("explicit changed fields replace old suggestions; assistant completion claims do not verify work", () => {
  let memory = core.memoryFromObservation(null, key, [msg("user", "Features: Login\nTechnology stack: React")], at(0));
  memory = core.memoryFromObservation(memory, key, [msg("user", "Features: Offline list\nTechnology stack: Kotlin"), msg("assistant", "Completed milestones: all tests passed\nDeployment readiness: production ready")], at(1));
  assert.equal(memory.project.features, "Offline list");
  assert.equal(memory.project.technologyStack, "Kotlin");
  assert.equal(memory.project.completedMilestones, "");
  assert.equal(memory.project.deploymentReadiness, "");
});

test("edits are immutable, preserve multiline lists and intentional clearing, and survive capture", () => {
  const original = core.memoryFromObservation(null, key, [msg("user", "Goal: Build a timer\nFeatures: Login")], at(0));
  const before = JSON.stringify(original);
  let edited = core.applyProjectEdits(original, { objective: "Build a habit tracker", features: "", pendingTasks: "Build screen\nTest screen" }, at(1));
  assert.equal(JSON.stringify(original), before);
  const editedBefore = JSON.stringify(edited);
  const updated = core.memoryFromObservation(edited, key, [msg("user", "Goal: Build a recipe app\nFeatures: Sharing")], at(2));
  assert.equal(JSON.stringify(edited), editedBefore);
  assert.equal(updated.project.objective, "Build a habit tracker");
  assert.equal(updated.suggestions.objective, "Build a recipe app");
  assert.equal(updated.project.features, "");
  assert.equal(updated.project.pendingTasks, "Build screen\nTest screen");
  assert.match(updated.guidance.currentGoal, /User-confirmed/);
});

test("unchanged capture/edit is idempotent and change history is bounded", () => {
  const messages = [msg("user", "Goal: Build a timer")];
  const first = core.memoryFromObservation(null, key, messages, at(0));
  const same = core.memoryFromObservation(first, key, messages, at(1));
  assert.deepEqual(same, first);
  const edited = core.applyProjectEdits(first, { projectName: "Timer" }, at(1));
  assert.deepEqual(core.applyProjectEdits(edited, { projectName: "Timer" }, at(2)), edited);
  let current = same;
  for (let n = 0; n < 80; n++) current = core.memoryFromObservation(current, key, [msg("user", `Goal: Build timer ${n}`)], String(n));
  assert.equal(current.turns.length, 40);
});

test("legacy migration is unconfirmed and conversation keys never inherit another project's memory", () => {
  const legacy = { schemaVersion: 1, conversationKey: key, project: { objective: "Legacy suggestion" }, overrides: { objective: "Should not be confirmed" }, turns: [] };
  const memory = core.memoryFromObservation(legacy, key, [], at(0));
  assert.deepEqual(memory.overrides, {});
  assert.equal(memory.project.objective, "Legacy suggestion");
  const other = core.memoryFromObservation(memory, "chatgpt:other", [], at(1));
  assert.equal(other.project.objective, "");
  assert.equal(other.consentGranted, false);
});

test("security review gives conservative topic signals without claiming safety", () => {
  const messages = [
    msg("user", "Build a SaaS app with login and a PostgreSQL database. Use process.env for API keys."),
    msg("assistant", "We can add rate limiting, parameterized queries, CSP, CSRF protection, structured error handling, and an origin allowlist."),
    msg("assistant", "For now use innerHTML = userInput and allow all origins so it is easy to test.")
  ];
  const checks = core.securityChecksFromMemoryOrMessages(messages);
  const byId = Object.fromEntries(checks.map(check => [check.id, check]));
  assert.equal(checks.length, 10);
  assert.equal(byId["authentication-authorization"].status, "mentioned");
  assert.equal(byId["database-data-access"].status, "mentioned");
  assert.equal(byId["secrets-env"].status, "mentioned");
  assert.equal(byId["input-output"].status, "needs-review");
  assert.equal(byId["cors-csrf-session"].status, "needs-review");
  assert.match(byId["input-output"].detail, /not a security audit/i);
  const summary = core.securitySummary(checks);
  assert.equal(summary.scoreLabel, "Needs review");
  assert.match(summary.headline, /not a security audit/i);
});

test("security signals persist in memory, Markdown, and local question answers", () => {
  const memory = core.memoryFromObservation(null, key, [msg("user", "Goal: Make a public API without rate limiting")], at(0));
  assert.equal(memory.schemaVersion, 3);
  assert.ok(memory.security && memory.security.checks.length === 10);
  assert.equal(memory.security.checks.find(check => check.id === "rate-abuse").status, "needs-review");
  assert.match(core.markdownFromMemory(memory), /Security & readiness review/);
  assert.match(core.answerLocalQuestion("Is this secure?", memory), /No security assurance is provided/);
  assert.match(core.answerLocalQuestion("What is my goal?", memory), /Make a public API/);
});

test("Markdown includes structured memory, provenance, capture bounds and verification limits", () => {
  const memory = core.applyProjectEdits(core.memoryFromObservation(null, key, [msg("user", "Goal: Build a timer")], at(0)), { projectName: "Timer" }, at(1));
  const md = core.markdownFromMemory(memory);
  for (const pattern of [/Bob mentor project memory/, /User-confirmed/, /Suggested \/ unconfirmed/, /local browser storage/, /not been verified/, /latest 40 rendered messages/, /Technology stack/, /Known issues/, /Deployment readiness/]) assert.match(md, pattern);
  assert.equal(memory.markdown, md);
});

console.log(`\n${checks} core/DOM fixture checks passed. Real browser validation is still required.`);
