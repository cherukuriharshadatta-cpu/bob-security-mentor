// Focused contract checks for the dependency-free floating Bob widget.
// These checks use the repository's minimal DOM; no browser or host service is needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { makeDocument } from "./dom-fixture.mjs";

const widgetSource = fs.readFileSync(new URL("../integrations/widget/bob-agent-widget.js", import.meta.url), "utf8");

function loadWidget() {
  const sandbox = { console, Date, Math, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  vm.runInNewContext(widgetSource, sandbox, { filename: "integrations/widget/bob-agent-widget.js" });
  return sandbox.BobAgentWidget;
}

function all(node) {
  return [node, ...node.children.flatMap(all)];
}

function shadowOf(documentRef) {
  return documentRef.body.children.find(node => node.getAttribute("data-bob-agent-widget"))?.testShadow;
}

let checks = 0;
async function test(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}

await test("browser widget has no provider secret, auth header, or network client", () => {
  assert.doesNotMatch(widgetSource, /OPENROUTER_API_KEY|BOB_[A-Z0-9_]*SECRET|x-bob-integration-secret/i);
  assert.doesNotMatch(widgetSource, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);

  const widget = loadWidget();
  assert.deepEqual(Object.keys(widget), ["version", "create", "mount"]);
  assert.equal(typeof widget.create, "function");
});

await test("host bridge exposes lifecycle/context methods and proxies the request callback", async () => {
  const documentRef = makeDocument();
  const requests = [];
  const widget = loadWidget();
  const bridge = widget.create({
    document: documentRef,
    source: "test-host",
    conversationId: "conversation-1",
    context: { projectName: "Task tracker", scope: "demo" },
    requestGuidance(payload) {
      requests.push(payload);
      return Promise.resolve({ data: { untrusted: true, reply: "Review one small step." } });
    }
  });

  assert.deepEqual(Object.keys(bridge), ["addMessage", "setContext", "ask", "open", "close", "destroy"]);
  bridge.addMessage({ role: "user", text: "Goal: Build a task tracker." });
  bridge.setContext({ projectName: "Task tracker", scope: "review" }).open().close();
  await bridge.ask("What should I verify first?");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].source, "test-host");
  assert.equal(requests[0].conversationId, "conversation-1");
  assert.equal(requests[0].userMessage, "What should I verify first?");
  assert.equal(requests[0].consent, true);
  assert.ok(Array.isArray(requests[0].messages));
  assert.equal(requests[0].project.projectName, "Task tracker");
});

await test("guidance fields are rendered as text and remain visibly untrusted", async () => {
  const documentRef = makeDocument();
  const hostile = "<img src=x onerror=alert(1)> & <script>alert(2)</script>";
  const widget = loadWidget();
  const bridge = widget.create({
    document: documentRef,
    requestGuidance: () => Promise.resolve({
      status: "success",
      data: {
        untrusted: true,
        reply: hostile,
        nextAction: { text: hostile, reason: hostile },
        lesson: { title: hostile, text: hostile },
        clarification: { question: hostile, reason: hostile },
        verification: { suggestions: [hostile], limitations: [hostile] }
      }
    })
  });
  await bridge.ask("Show the response safely");

  const shadow = shadowOf(documentRef);
  assert.equal(shadow.querySelectorAll("img").length, 0);
  assert.equal(shadow.querySelectorAll("script").length, 0);
  assert.match(shadow.textContent, /UNTRUSTED MENTOR GUIDANCE|Untrusted guidance/);
  assert.match(shadow.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(shadow.textContent, /Bob will only suggest|verify it yourself/);
});

await test("missing requestGuidance state is visible and performs no request", async () => {
  const documentRef = makeDocument();
  const widget = loadWidget();
  const bridge = widget.create({ document: documentRef });
  const shadow = shadowOf(documentRef);

  assert.match(shadow.textContent, /Host configuration needed/);
  assert.equal(await bridge.ask("Can Bob help?"), null);
  assert.match(shadow.textContent, /Configuration required/);
  assert.equal(all(shadow).filter(node => node.tagName === "SECTION").length, 1);
});

await test("context and messages are bounded before requestGuidance receives them", async () => {
  const documentRef = makeDocument();
  const requests = [];
  const widget = loadWidget();
  const bridge = widget.create({
    document: documentRef,
    context: {
      project: { projectName: "Bounded project", apiKey: "browser-must-not-see-this" },
      scope: "demo",
      nested: { one: { two: { three: { four: { five: "drop this" } } } } }
    },
    messages: Array.from({ length: 50 }, (_, index) => ({ role: index % 2 ? "assistant" : "user", text: "x".repeat(2500) })),
    requestGuidance(payload) {
      requests.push(payload);
      return Promise.resolve({ data: { untrusted: true, reply: "bounded" } });
    }
  });
  await bridge.ask("q".repeat(2500));

  assert.equal(requests.length, 1);
  const payload = requests[0];
  assert.equal(payload.messages.length, 40);
  assert.ok(payload.messages.every(message => message.text.length <= 2000));
  assert.equal(payload.userMessage.length, 2000);
  assert.equal(payload.context.project.apiKey, "[redacted]");
  assert.equal(payload.context.nested.one.two.three, undefined, "context depth is bounded");
});

console.log(`\n${checks} embeddable widget checks passed. No live browser or host service was used.`);
