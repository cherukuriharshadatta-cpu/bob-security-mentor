// Tests real content/core code in a simulated DOM and extension environment.
// Does not validate Chrome content-script permissions, CSS, or the live ChatGPT DOM.
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { makeDocument, append } from "./dom-fixture.mjs";

const require = createRequire(import.meta.url);
const core = require("../src/core.js");
const content = fs.readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
const flush = () => new Promise(resolve => setImmediate(resolve));
const clone = value => value === undefined ? undefined : structuredClone(value);
const memKey = id => `bob.memory.chatgpt:${id}`;
const permKey = id => `bob.permission.chatgpt:${id}`;

function backend() {
  const db = {};
  const listeners = [];
  const locks = new Map();
  const control = { hold: null, release: null, fail: null };
  function emit(changes) { listeners.forEach(fn => fn(clone(changes), "local")); }
  return {
    db, control, emit,
    locks: { request(key, work) {
      const result = (locks.get(key) || Promise.resolve()).then(work);
      locks.set(key, result.catch(() => {}));
      return result;
    } },
    chrome() {
      const runtime = { getURL: path => `chrome-extension://test/${path}` };
      function perform(method, input, callback) {
        const execute = () => {
          if (control.fail === method) {
            control.fail = null;
            runtime.lastError = { message: "Simulated storage failure" };
            callback();
            delete runtime.lastError;
            return;
          }
          if (method === "get") {
            callback(Object.fromEntries(input.map(key => [key, clone(db[key])])));
            return;
          }
          const changes = {};
          if (method === "set") {
            for (const [key, value] of Object.entries(input)) {
              if (JSON.stringify(value) === JSON.stringify(db[key])) continue;
              changes[key] = { oldValue: clone(db[key]), newValue: clone(value) };
              db[key] = clone(value);
            }
          } else {
            for (const key of input) {
              if (db[key] !== undefined) changes[key] = { oldValue: clone(db[key]) };
              delete db[key];
            }
          }
          emit(changes);
          callback();
        };
        if (control.hold === method) { control.hold = null; control.release = () => { control.release = null; execute(); }; }
        else queueMicrotask(execute);
      }
      return { runtime, storage: {
        onChanged: { addListener: fn => listeners.push(fn) },
        local: Object.fromEntries(["get", "set", "remove"].map(method => [method, (input, callback) => perform(method, clone(input), callback)]))
      } };
    }
  };
}

function tab(shared = backend(), id = "A") {
  const doc = makeDocument();
  const main = append(doc.body, "main");
  append(main, "div", { "data-message-author-role": "user" }, "Goal: Build a timer");
  append(main, "div", { "data-message-author-role": "assistant" }, "Start with a small screen.");
  const composer = append(main, "div", { contenteditable: "true" }, "Ask ChatGPT");
  let clock = 0, timerId = 0, reads = 0;
  const timers = new Map(), observers = [], events = {};
  const fetchCalls = [];
  const context = {
    document: doc, console, URL, Blob, crypto: { randomUUID },
    Date: class extends Date { static now() { return clock; } },
    location: { href: `https://chatgpt.com/c/${id}`, origin: "https://chatgpt.com" },
    navigator: { locks: shared.locks }, chrome: shared.chrome(),
    AbortController,
    fetch: async (url, options) => {
      fetchCalls.push({ url, options, body: JSON.parse(options.body) });
      return { ok: true, status: 200, async json() {
        return {
          reply: "Start with a small testable step.",
          projectUnderstanding: { whatIsBeingBuilt: "A local prototype", why: "To learn", targetUsers: "The project owner" },
          changedRequirements: [], nextStep: "Write one acceptance example.", securityReview: [],
          openQuestions: [], uncertainty: ["The model response is unverified."], verificationNeeded: ["Run tests."]
        };
      } };
    },
    BobMentorCore: { ...core, extractConversation(document) { reads++; return core.extractConversation(document); } },
    confirm: () => true,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimeout(id) { timers.delete(id); }, setInterval() { return 0; },
    addEventListener(type, fn) { (events[type] ||= []).push(fn); },
    MutationObserver: class {
      constructor(fn) { this.fn = fn; this.connected = false; observers.push(this); }
      observe() { this.connected = true; }
      disconnect() { this.connected = false; }
    }
  };
  // Any accidental fallback to the website's storage must fail the test.
  Object.defineProperty(context, "localStorage", { get() { throw new Error("Page storage must never be used"); } });
  context.window = context;
  vm.runInNewContext(content, context, { filename: "src/content.js" });
  const shadow = doc.body.children.find(node => node.id === "bob-mentor-root").testShadow;
  shadow.children[0].fire("load");
  const all = node => [node, ...node.children.flatMap(all)];
  const find = label => all(shadow).find(node => node.tagName === "BUTTON" && node.textContent === label);
  const checkbox = all(shadow).find(node => node.tagName === "INPUT");
  const field = key => all(shadow).find(node => node.tagName === "TEXTAREA" && node.name === key);
  const text = () => shadow.textContent;
  function mutate(target = main) { observers.filter(o => o.connected).forEach(o => o.fn([{ target }])); }
  return {
    shared, context, shadow, main, composer, find, field, checkbox, text,
    get reads() { return reads; },
    get fetchCalls() { return fetchCalls; },
    get activeObservers() { return observers.filter(o => o.connected).length; },
    mutate,
    async allow() {
      await flush();
      checkbox.checked = true; checkbox.fire("change");
      const allow = all(shadow).find(node => node.tagName === "BUTTON" && node.textContent.startsWith("Allow THIS CONVERSATION:"));
      assert.equal(allow.disabled, false, text());
      allow.click(); await flush();
    },
    async tick(ms) {
      const end = clock + ms;
      let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(count++ < 100, "timer loop must remain bounded");
        const [id, timer] = next; clock = timer.at; timers.delete(id); timer.fn(); await flush();
      }
      clock = end; await flush();
    },
    navigate(id) {
      context.location.href = `https://chatgpt.com/c/${id}`;
      for (const fn of events.popstate || []) fn();
    },
    replaceMessages(text = "Goal: Build a recipe app") {
      main.children.forEach(node => { node.isConnected = false; });
      main.childNodes = [];
      append(main, "div", { "data-message-author-role": "user" }, text);
      mutate();
    }
  };
}

let passed = 0;
async function test(name, run) { await run(); passed++; console.log(`PASS ${name}`); }

await test("no reads before explicit consent; capture, paused edit and reload persistence", async () => {
  const t = tab(); await flush(); await t.tick(4000);
  assert.equal(t.reads, 0); assert.equal(t.activeObservers, 0);
  assert.equal(t.find("Allow THIS CONVERSATION: chatgpt:A").disabled, true);
  await t.allow(); await t.tick(3000);
  assert.ok(t.reads > 0); assert.equal(t.activeObservers, 1);
  assert.equal(t.shared.db[memKey("A")].messages.length, 2);
  t.find("Pause").click();
  const reads = t.reads;
  t.field("objective").value = "Build a habit tracker"; t.field("objective").fire("input");
  t.find("Save edited fields").click(); await flush();
  assert.equal(t.shared.db[memKey("A")].project.objective, "Build a habit tracker");
  t.mutate(); await t.tick(2000); assert.equal(t.reads, reads);
  const reloaded = tab(t.shared); await flush();
  assert.equal(reloaded.field("objective").value, "Build a habit tracker");
  assert.equal(reloaded.reads, 0); assert.equal(reloaded.activeObservers, 0);
});

await test("continuous streaming is throttled, identical snapshots deduplicate, drafts survive", async () => {
  const t = tab(); await t.allow(); await t.tick(3000);
  t.field("projectName").value = "My unsaved project"; t.field("projectName").fire("input");
  const before = t.reads;
  for (let n = 0; n < 20; n++) {
    t.main.children[1].textContent = `Stream fragment ${n}`;
    t.mutate(); await t.tick(100);
  }
  assert.ok(t.reads > before, "ongoing mutations must not starve capture");
  await t.tick(1000);
  const revision = t.shared.db[memKey("A")].bobRevision;
  t.mutate(); await t.tick(1000);
  assert.equal(t.shared.db[memKey("A")].bobRevision, revision);
  assert.equal(t.field("projectName").value, "My unsaved project");
});

await test("typing in the ChatGPT composer does not schedule Bob captures", async () => {
  const t = tab(); await t.allow(); await t.tick(3000);
  const before = t.reads;
  t.composer.textContent = "A user is typing a new prompt";
  t.mutate(t.composer);
  await t.tick(1200);
  assert.equal(t.reads, before, "composer mutations must not trigger DOM extraction");
});

await test("navigation stops capture and stale DOM cannot be assigned to a new key", async () => {
  const t = tab(); await t.allow(); await t.tick(3000);
  const before = t.reads;
  t.navigate("B"); await flush();
  assert.equal(t.activeObservers, 0); assert.equal(t.field("objective").value, "");
  await t.allow(); await t.tick(3000);
  assert.equal(t.reads, before);
  assert.match(t.text(), /Capture blocked/);
  t.replaceMessages(); await t.tick(2000);
  assert.ok(t.reads > before);
  assert.match(t.shared.db[memKey("B")].project.objective, /recipe app/);
  assert.match(t.shared.db[memKey("A")].project.objective, /timer/);
});

await test("pending capture write followed by revoke cannot resurrect memory", async () => {
  const t = tab(); await t.allow(); await t.tick(3000);
  t.shared.control.hold = "set";
  t.main.children[1].textContent = "Changed assistant text";
  t.mutate(); await t.tick(1000);
  assert.ok(t.shared.control.release, "capture write must be pending");
  t.find("Revoke & delete local memory").click();
  assert.equal(t.activeObservers, 0);
  t.shared.control.release(); await flush(); await t.tick(2000);
  assert.equal(t.shared.db[memKey("A")], undefined);
  assert.equal(t.shared.db[permKey("A")].granted, false);
  assert.equal(t.field("objective").value, "");
});

await test("A-B-A navigation ignores delayed activation callbacks", async () => {
  const t = tab(); await flush();
  t.shared.control.hold = "get";
  await t.allow();
  assert.ok(t.shared.control.release);
  t.navigate("B"); t.navigate("A");
  t.shared.control.release(); await flush(); await t.tick(3000);
  assert.equal(t.reads, 0); assert.equal(t.activeObservers, 0);
  assert.equal(t.shared.db[memKey("A")], undefined);
  assert.match(t.text(), /Paused/);
});

await test("storage failure is visible, fail-closed, and never uses page storage", async () => {
  const t = tab(); await flush();
  t.shared.control.fail = "set";
  await t.allow(); await t.tick(3000);
  assert.equal(t.reads, 0); assert.equal(t.activeObservers, 0);
  assert.match(t.text(), /Stopped safely: Simulated storage failure/);
  t.find("Retry local storage").click(); await flush();
  await t.allow(); await t.tick(3000);
  assert.ok(t.reads > 0);
});

await test("external edits pause capture but preserve drafts; cross-tab revoke clears both tabs", async () => {
  const shared = backend();
  const a = tab(shared); await a.allow(); await a.tick(3000);
  const b = tab(shared); await flush();
  b.find("Resume this conversation").click(); await flush(); await b.tick(3000);
  assert.equal(a.activeObservers, 0, "other tab writes pause the first tab");
  a.field("objective").value = "Keep this unsaved draft"; a.field("objective").fire("input");
  b.find("Pause").click();
  b.field("projectName").value = "Team timer"; b.field("projectName").fire("input");
  b.find("Save edited fields").click(); await flush();
  assert.equal(a.field("objective").value, "Keep this unsaved draft");
  a.find("Save edited fields").click(); await flush();
  assert.equal(shared.db[memKey("A")].project.projectName, "Team timer");
  assert.equal(shared.db[memKey("A")].project.objective, "Keep this unsaved draft");
  b.find("Resume this conversation").click(); await flush();
  b.shared.control.hold = "set";
  b.main.children[1].textContent = "New streamed answer"; b.mutate(); await b.tick(3000);
  assert.ok(shared.control.release);
  a.find("Revoke & delete local memory").click();
  shared.control.release(); await flush(); await a.tick(2000); await b.tick(2000);
  assert.equal(shared.db[memKey("A")], undefined);
  assert.equal(shared.db[permKey("A")].granted, false);
  assert.equal(a.activeObservers, 0); assert.equal(b.activeObservers, 0);
  assert.equal(a.field("objective").value, ""); assert.equal(b.field("objective").value, "");
});

await test("missing selectors produce actionable capture diagnostics instead of generic active guidance", async () => {
  const t = tab();
  t.main.childNodes = [];
  append(t.main, "p", {}, "Unsupported structure, not a message");
  await t.allow(); await t.tick(3000);
  assert.match(t.text(), /Nothing captured:/);
  assert.equal(t.shared.db[memKey("A")].messages.length, 0);
});

await test("cloud mentor chat is separately consent-gated and sends only approved context", async () => {
  const t = tab(); await t.allow(); await t.tick(3000);
  const all = node => [node, ...node.children.flatMap(all)];
  const findText = value => all(t.shadow).find(node => node.textContent === value || node.textContent.startsWith(value));
  const radios = all(t.shadow).filter(node => node.tagName === "INPUT" && node.type === "radio");
  const checkboxes = all(t.shadow).filter(node => node.tagName === "INPUT" && node.type === "checkbox");
  const mentorInput = all(t.shadow).find(node => node.tagName === "TEXTAREA" && node.className === "bob-question-input" && node !== undefined && node.parentElement?.className === "bob-composer-label");
  findText("Mentor chat").click(); await flush();
  assert.equal(radios.length >= 2, true);
  const cloud = radios.find(node => node.value === "cloud");
  cloud.checked = true; cloud.fire("change"); await flush();
  mentorInput.value = "What should I secure first?"; mentorInput.fire("input"); await flush();
  const send = findText("Send to Bob");
  send.click(); await flush();
  assert.equal(t.fetchCalls.length, 0, "cloud request must not happen before cloud consent");
  const cloudCheckbox = checkboxes.at(-1);
  cloudCheckbox.checked = true; cloudCheckbox.fire("change"); await flush();
  send.click(); await flush();
  assert.equal(t.fetchCalls.length, 1);
  assert.match(t.fetchCalls[0].url, /127\.0\.0\.1:8787\/v1\/mentor\/respond/);
  assert.equal(t.fetchCalls[0].body.cloudConsent, true);
  assert.equal(t.fetchCalls[0].body.conversationKey, "chatgpt:A");
  assert.ok(Array.isArray(t.fetchCalls[0].body.messages));
  assert.ok(t.fetchCalls[0].body.project);
  assert.equal(t.fetchCalls[0].body.userMessage, "What should I secure first?");
});

console.log(`\n${passed} simulated lifecycle checks passed. No real browser verification claimed.`);
