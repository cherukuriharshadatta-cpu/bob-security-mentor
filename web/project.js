(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../src/core.js"));
  } else {
    root.BobWorkspaceModel = factory(root.BobMentorCore);
  }
}(typeof globalThis !== "undefined" ? globalThis : this, function (core) {
  "use strict";

  if (!core || typeof core.memoryFromObservation !== "function") {
    throw new Error("Load BobMentorCore before BobWorkspaceModel.");
  }

  // All clocks, IDs and persistence belong to the caller. No timer, random
  // number, storage, DOM access or request is used by this pure model.
  var VERSION = 1;
  var MAX_MESSAGES = core.MAX_MEMORY_TURNS;
  var MAX_TEXT = core.MAX_TURN_LENGTH;
  var MAX_SOURCES = 40;
  var DEMO_BRIEF = "Goal: Build a login app for a hackathon demo.\nFeatures: A sign-in screen with clear success and failure responses.\nConstraint: Use fake accounts and keep this a private demo.";
  var LIMITATIONS = "Deterministic local rules read bounded user/assistant text, not running code. Topic mentions and rule flags are not proof of implementation, exploitability or safety. Bob does not trace runtime behavior, execute tests, verify checklist reports or prove deployment readiness. Only the latest 40 messages (1800 characters each) and up to 40 relevant earlier user sources are retained; this is not a complete transcript.";
  var CHECK_DEFINITIONS = [
    { id: "scope-confirmed", nodeId: "intent", text: "Confirm the demo or production scope and which data and users are involved." },
    { id: "input-validation", nodeId: "inputs", text: "Try empty, oversized and unexpected inputs; check server validation and text-only output." },
    { id: "auth-required", nodeId: "auth", text: "Request a protected resource while signed out; check that the server rejects it." },
    { id: "record-ownership", nodeId: "auth", text: "With two test accounts, request and change account B's record as account A; check that both operations are denied." },
    { id: "session-logout", nodeId: "auth", text: "Log out and try reusing the old session; check expiry, invalidation and the chosen cookie/CSRF settings." },
    { id: "secrets-server", nodeId: "data", text: "Inspect the client bundle, repository and logs for secrets; keep real credentials on the server." },
    { id: "data-parameterized", nodeId: "data", text: "Inspect queries for bound parameters and server-derived owner IDs; test reads and writes with another account." },
    { id: "failure-response", nodeId: "verification", text: "Exercise failed sign-in and service errors; check that responses and logs do not expose account details or secrets." }
  ];

  function object(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
  function own(value, key) { return object(value) && Object.prototype.hasOwnProperty.call(value, key); }
  function text(value, limit) {
    if (typeof value !== "string") { return ""; }
    var result = value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
    return result.length > limit ? result.slice(0, limit - 1).trimEnd() + "…" : result;
  }
  function timestamp(value) { return text(value, 80).replace(/\s+/g, " "); }
  function freeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
      Object.keys(value).forEach(function (key) { freeze(value[key]); });
      Object.freeze(value);
    }
    return value;
  }
  function hash(value) {
    var result = 2166136261;
    for (var i = 0; i < value.length; i += 1) { result = Math.imul(result ^ value.charCodeAt(i), 16777619); }
    return (result >>> 0).toString(36);
  }
  function validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(value); }
  function sequence(id) {
    if (typeof id !== "string" || !/^m[1-9][0-9]{0,15}$/.test(id)) { return 0; }
    var value = Number(id.slice(1));
    return Number.isSafeInteger(value) && value < Number.MAX_SAFE_INTEGER - 1 ? value : 0;
  }
  function sourceKind(role, source) {
    if (source === "transcript" || role === "user" && (source === "brief" || source === "user") ||
        role === "assistant" && (source === "local" || source === "cloud")) { return source; }
    return role === "user" ? "user" : "transcript";
  }
  function sanitizeMessages(input, archive) {
    if (!Array.isArray(input)) { return []; }
    var result = [];
    input.forEach(function (item) {
      if (!object(item) || item.role !== "user" && item.role !== "assistant" || archive && item.role !== "user") { return; }
      var body = text(item.text, MAX_TEXT);
      if (!body || !sequence(item.id)) { return; }
      result.push({ id: item.id, role: item.role, text: body, source: sourceKind(item.role, item.source), createdAt: timestamp(item.createdAt) });
    });
    var seen = Object.create(null);
    // Later occurrences win; a retained message wins over its archive copy.
    return result.reverse().filter(function (item) {
      if (seen[item.id]) { return false; }
      seen[item.id] = true;
      return true;
    }).reverse().slice(-(archive ? MAX_SOURCES : MAX_MESSAGES));
  }
  function sourceRef(message, messages) {
    return {
      kind: "message", messageId: message.id, role: message.role, source: message.source,
      reference: "workspace-message:" + message.id,
      label: message.role === "user" ? "User message (" + message.source + ")" : "Assistant text (" + message.source + "; not user intent)",
      retained: messages.some(function (item) { return item.id === message.id; })
    };
  }
  function allSources(messages, sources) {
    var index = Object.create(null);
    sources.concat(messages).forEach(function (item) { index[item.id] = item; });
    return Object.keys(index).map(function (id) { return index[id]; }).sort(function (a, b) { return sequence(a.id) - sequence(b.id); });
  }
  function scopeFromUser(body) {
    // Do not turn questions, negations or tentative possibilities into a choice.
    var lines = body.split(/\n|[.!?]\s+|;\s*/);
    var selected = "";
    lines.forEach(function (line) {
      if (/\?|\b(?:maybe|might|could|perhaps|possibly|not sure|uncertain|undecided|not|never|without)\b/i.test(line)) { return; }
      var explicit = line.match(/\b(?:scope\s*:\s*|use\s+|choose\s+)(demo|production)\b/i);
      if (explicit) { selected = explicit[1].toLowerCase(); return; }
      var demo = /\b(?:demo|hackathon|prototype|proof[ -]of[ -]concept)\b/i.test(line);
      var production = /\b(?:production|public deployment|real users)\b/i.test(line);
      if (demo !== production && /^(?:goal|objective|constraint|decision|scope)\s*:|\b(?:build|create|make|develop|want|plan|intend|keep|remain|deploy|ship)\b/i.test(line)) {
        selected = demo ? "demo" : "production";
      }
    });
    return selected;
  }
  function normalizeChecks(input) {
    return CHECK_DEFINITIONS.map(function (definition) {
      var reported = Array.isArray(input) ? input.find(function (item) { return object(item) && item.id === definition.id; }) : null;
      var valid = reported && reported.reported === true && typeof reported.checked === "boolean" &&
        (reported.scope === "demo" || reported.scope === "production" || reported.scope === "unspecified");
      return {
        id: definition.id, checked: valid ? reported.checked : false, reported: !!valid,
        scope: valid ? reported.scope : "unspecified", source: "user-reported",
        updatedAt: valid ? timestamp(reported.updatedAt) : ""
      };
    });
  }
  function scopeChoiceSource(scope, at) {
    return {
      kind: "scope-choice", messageId: null, role: "user", source: "user-choice",
      reference: "workspace-scope:" + scope, label: "User-selected scope: " + scope, retained: true,
      updatedAt: timestamp(at)
    };
  }

  function build(input, pruned) {
    var messages = sanitizeMessages(input.messages, false);
    var sources = sanitizeMessages(input.sources, true);
    var ordered = allSources(messages, sources);
    var key = "workspace:" + input.id;
    var memory = core.memoryFromObservation(null, key, [], input.createdAt);
    var projectSources = {};
    var scope = "unspecified";
    var scopeSource = null;
    ordered.forEach(function (message) {
      var previousProject = memory.project;
      var next = core.memoryFromObservation(memory, key, [{ role: message.role, text: message.text }], message.createdAt);
      // Core receives a single new turn, then its local turn references are
      // mapped to stable workspace IDs before the next turn is processed.
      next.intentLedger.items.forEach(function (item) {
        if (/^user-turn:/.test(item.source.reference)) {
          item.source = Object.assign(sourceRef(message, messages), { turnIndex: sequence(message.id) - 1 });
        } else {
          var origin = ordered.find(function (candidate) { return "workspace-message:" + candidate.id === item.source.reference; });
          if (origin) { item.source = Object.assign(sourceRef(origin, messages), { turnIndex: sequence(origin.id) - 1 }); }
        }
      });
      if (message.role === "user") {
        core.PROJECT_FIELDS.forEach(function (field) {
          if (previousProject[field.key] !== next.project[field.key]) { projectSources[field.key] = sourceRef(message, messages); }
        });
        var chosen = scopeFromUser(message.text);
        if (chosen) { scope = chosen; scopeSource = sourceRef(message, messages); }
      }
      memory = next;
    });
    if (input.scope === "demo" || input.scope === "production") {
      scope = input.scope;
      scopeSource = object(input.scopeSource) ? scopeChoiceSource(scope, input.scopeSource.updatedAt || input.updatedAt) : scopeChoiceSource(scope, input.updatedAt);
    }
    var needed = Object.create(null);
    memory.intentLedger.items.forEach(function (item) { needed[item.source.messageId] = true; });
    Object.keys(projectSources).forEach(function (field) { needed[projectSources[field].messageId] = true; });
    if (scopeSource) { needed[scopeSource.messageId] = true; }
    var archive = ordered.filter(function (message) {
      return message.role === "user" && needed[message.id] && !messages.some(function (item) { return item.id === message.id; });
    }).slice(-MAX_SOURCES);
    // If source bounds evict an old source, recompute so derived values cannot
    // outlive their evidence, including across JSON save/restore.
    if (!pruned && ordered.some(function (message) {
      return message.role === "user" && needed[message.id] && !messages.some(function (item) { return item.id === message.id; }) &&
        !archive.some(function (item) { return item.id === message.id; });
    })) { return build(Object.assign({}, input, { messages: messages, sources: archive }), true); }
    memory.messages = messages.map(function (message) { return { role: message.role, text: message.text }; });
    memory.guidance = core.deriveGuidance(memory.messages, memory.project.objective);
    var goal = memory.intentLedger.items.filter(function (item) { return item.type === "goal" && item.status === "current"; }).pop();
    memory.guidance.currentGoal = goal ? goal.text : memory.project.objective || "No explicit user goal recorded yet.";
    memory.guidance.clarificationCue = "";
    memory.security = { checks: core.securityChecksFromMemoryOrMessages(memory.messages, memory.project), summary: null };
    memory.security.summary = core.securitySummary(memory.security.checks);
    memory.createdAt = input.createdAt;
    memory.updatedAt = input.updatedAt;
    memory.consentGranted = false;
    // Core's extension-specific Markdown describes browser storage. Export
    // here has its own honest, caller-managed persistence description.
    memory.markdown = "";
    var nextSequence = ordered.reduce(function (maximum, message) { return Math.max(maximum, sequence(message.id) + 1); }, 1);
    if (Number.isSafeInteger(input.nextSequence) && input.nextSequence >= nextSequence && input.nextSequence < Number.MAX_SAFE_INTEGER - 1) {
      nextSequence = input.nextSequence;
    }
    return freeze({
      schemaVersion: VERSION, id: input.id, name: text(input.name, 120) || memory.project.projectName || "Untitled workspace",
      createdAt: input.createdAt, updatedAt: input.updatedAt, nextSequence: nextSequence,
      messages: messages, sources: archive, memory: memory, projectSources: projectSources,
      scope: scope, scopeSource: scopeSource, checks: normalizeChecks(input.checks)
    });
  }

  function restoreWorkspace(parsed) {
    if (!object(parsed) || parsed.schemaVersion !== VERSION || !validId(parsed.id) || !Array.isArray(parsed.messages)) { return null; }
    // Derived memory, provenance, scope and any unknown fields are never
    // trusted. Rebuild them solely from bounded explicit-role source records.
    return build({
      id: parsed.id, name: text(parsed.name, 120), createdAt: timestamp(parsed.createdAt), updatedAt: timestamp(parsed.updatedAt),
      nextSequence: parsed.nextSequence, messages: parsed.messages, sources: parsed.sources, checks: parsed.checks,
      scope: parsed.scope, scopeSource: parsed.scopeSource
    });
  }
  function requireState(state) {
    var restored = restoreWorkspace(state);
    if (!restored) { throw new TypeError("A valid Bob workspace is required."); }
    return restored;
  }
  function add(state, role, body, options) {
    var safe = requireState(state);
    options = object(options) ? options : {};
    var bounded = text(body, MAX_TEXT);
    if (!bounded) { return safe; }
    var at = own(options, "now") ? timestamp(options.now) : safe.updatedAt;
    var message = { id: "m" + safe.nextSequence, role: role, text: bounded, source: sourceKind(role, options.source), createdAt: at };
    // Add current user evidence before an old message leaves the recent window.
    return build(Object.assign({}, safe, {
      updatedAt: at, nextSequence: safe.nextSequence + 1,
      sources: safe.sources.concat(safe.messages.filter(function (item) { return item.role === "user"; })).slice(-MAX_SOURCES),
      messages: safe.messages.concat([message]).slice(-MAX_MESSAGES)
    }));
  }
  function appendUserMessage(state, body, options) { return add(state, "user", body, options); }
  function appendAssistantMessage(state, body, options) { return add(state, "assistant", body, options); }
  function chooseScope(state, scope, options) {
    if (scope !== "demo" && scope !== "production") { throw new TypeError("Scope must be demo or production."); }
    var safe = requireState(state);
    options = object(options) ? options : {};
    var at = own(options, "now") ? timestamp(options.now) : safe.updatedAt;
    return build(Object.assign({}, safe, { updatedAt: at, scope: scope, scopeSource: scopeChoiceSource(scope, at) }));
  }
  function recordCheck(state, id, checked, options) {
    var safe = requireState(state);
    if (!CHECK_DEFINITIONS.some(function (item) { return item.id === id; }) || typeof checked !== "boolean") {
      throw new TypeError("Use a known checklist ID and a boolean report.");
    }
    var at = object(options) && own(options, "now") ? timestamp(options.now) : safe.updatedAt;
    return freeze(Object.assign({}, safe, {
      updatedAt: at,
      checks: safe.checks.map(function (check) {
        return check.id === id ? { id: id, checked: checked, reported: true, scope: safe.scope, source: "user-reported", updatedAt: at } : check;
      })
    }));
  }
  function createWorkspace(options) {
    options = object(options) ? options : {};
    var at = timestamp(options.now);
    var requestedName = own(options, "name") ? options.name : options.workspaceName;
    var requestedBrief = own(options, "brief") ? options.brief : options.userBrief;
    var id = validId(options.id) ? options.id : validId(options.workspaceId) ? options.workspaceId : "ws-" + hash(text(requestedName, 120) + "\n" + text(requestedBrief, MAX_TEXT) + "\n" + at);
    var state = build({ id: id, name: text(requestedName, 120), createdAt: at, updatedAt: at, messages: [], sources: [], checks: options.checks });
    if (text(requestedBrief, MAX_TEXT)) { state = appendUserMessage(state, requestedBrief, { now: at, source: "brief" }); }
    if (Array.isArray(options.messages)) { state = importTranscript(state, options.messages, { now: at }); }
    if (typeof options.transcript === "string") { state = importTranscript(state, options.transcript, { now: at }); }
    if (options.scope === "demo" || options.scope === "production") { state = chooseScope(state, options.scope, { now: at }); }
    return state;
  }
  function importTranscript(state, input, options) {
    var safe = requireState(state);
    var messages = [];
    if (Array.isArray(input)) {
      messages = input.filter(function (message) {
        return object(message) && (message.role === "user" || message.role === "assistant") && typeof message.text === "string";
      }).slice(-MAX_MESSAGES);
    } else if (typeof input === "string") {
      // Only explicit line-start labels establish roles. Unlabelled text is
      // not silently promoted to a user request; use the brief for that case.
      var bounded = input.slice(-MAX_MESSAGES * (MAX_TEXT + 100));
      var pattern = /^(User|Assistant):[ \t]*/gim;
      var match;
      var previous = null;
      while ((match = pattern.exec(bounded))) {
        if (previous) { messages.push({ role: previous.role, text: bounded.slice(previous.start, match.index) }); }
        previous = { role: match[1].toLowerCase(), start: pattern.lastIndex };
      }
      if (previous) { messages.push({ role: previous.role, text: bounded.slice(previous.start) }); }
      messages = messages.slice(-MAX_MESSAGES);
    }
    messages.forEach(function (message) {
      safe = add(safe, message.role, message.text, { now: object(options) && own(options, "now") ? options.now : safe.updatedAt, source: "transcript" });
    });
    return safe;
  }

  function evidenceChecks(state) {
    var ordered = allSources(state.messages, state.sources);
    var checks = core.securityChecksFromMemoryOrMessages([]).map(function (check) { return Object.assign({}, check, { sources: [] }); });
    function merge(results, reference) {
      results.forEach(function (candidate, index) {
        if (candidate.status === "unknown") { return; }
        var check = checks[index];
        if (candidate.status === "needs-review" || check.status === "unknown") {
          check.status = candidate.status; check.evidence = candidate.evidence; check.detail = candidate.detail;
        }
        if (check.sources.length < MAX_SOURCES) { check.sources.push(reference); }
      });
    }
    ordered.forEach(function (message) {
      merge(core.securityChecksFromMemoryOrMessages([{ role: message.role, text: message.text }]), sourceRef(message, state.messages));
    });
    core.PROJECT_FIELDS.forEach(function (field) {
      if (!state.memory.project[field.key]) { return; }
      var project = {};
      project[field.key] = state.memory.project[field.key];
      var origin = state.projectSources[field.key];
      merge(core.securityChecksFromMemoryOrMessages([], project), {
        kind: "project", field: field.key, messageId: origin ? origin.messageId : null, role: "user", source: origin ? origin.source : "user",
        reference: origin ? origin.reference : "", label: "User-labelled project field: " + field.label, retained: origin ? origin.retained : false
      });
    });
    return checks.map(function (check) {
      return Object.assign(check, { label: check.status === "needs-review" ? "Local rule flag" : check.status === "mentioned" ? "Topic mentioned" : "No local evidence", verified: false });
    });
  }
  function analyzeWorkspace(state) {
    var safe = requireState(state);
    var findings = evidenceChecks(safe);
    var summary = core.securitySummary(findings);
    var ledger = safe.memory.intentLedger;
    var current = ledger.items.filter(function (item) { return item.status === "current"; });
    var goal = current.filter(function (item) { return item.type === "goal"; }).pop();
    var checks = CHECK_DEFINITIONS.map(function (definition, index) {
      var record = safe.checks[index];
      var stale = record.reported && record.scope !== safe.scope;
      return Object.assign({}, definition, record, {
        status: stale ? "needs-repeat" : record.reported ? "user-reported" : "not-recorded",
        label: stale ? "Scope changed — repeat this check" : record.reported ? "User-reported, not verified" : "Not recorded",
        verified: false
      });
    });
    var checkCounts = {
      total: checks.length, reported: checks.filter(function (item) { return item.reported; }).length,
      checked: checks.filter(function (item) { return item.checked && item.status === "user-reported"; }).length,
      needsRepeat: checks.filter(function (item) { return item.status === "needs-repeat"; }).length,
      verified: 0
    };
    var securityRelevant = findings.some(function (item) {
      return item.status !== "unknown" && /^(?:identity|input-output|data|secrets|web-session|privacy|abuse)$/.test(item.category);
    }) || allSources(safe.messages, safe.sources).some(function (message) {
      return message.role === "user" && /\b(?:accounts?|passwords?|credentials?|private data|personal data|record ownership|sign[ -]?in|log[ -]?in)\b/i.test(message.text);
    });
    var clarification = safe.scope === "unspecified" && securityRelevant ? {
      id: "scope", question: "Is this a private demo with fake accounts/data, or a production app for real users?",
      reason: "The answer changes the authentication, record-ownership, secret-handling and deployment checks to plan. Text alone cannot verify those controls.",
      choices: [{ value: "demo", label: "Private demo" }, { value: "production", label: "Production app" }]
    } : null;
    function node(id, title, ids, fallback) {
      var related = findings.filter(function (item) { return ids.indexOf(item.id) >= 0; });
      var flagged = related.find(function (item) { return item.status === "needs-review"; });
      var mentioned = related.find(function (item) { return item.status === "mentioned"; });
      var signal = flagged || mentioned;
      return {
        id: id, title: title, status: signal ? signal.status : "unknown", label: signal ? signal.label : "Not verified",
        summary: signal ? signal.detail : fallback, evidence: signal ? signal.evidence : "No matching local rule evidence.",
        sources: related.reduce(function (list, item) { return list.concat(item.sources); }, []).slice(0, MAX_SOURCES), ruleIds: ids, verified: false
      };
    }
    var intent = {
      id: "intent", title: "Project intent", status: goal ? "observed" : "unknown", label: goal ? "User-stated intent" : "Not specified",
      summary: goal ? goal.text : "Add a brief with an explicit goal, such as Goal: Build a timer.",
      evidence: goal ? "Explicit user goal; interpretation uses deterministic rules." : "No explicit user goal was detected.",
      sources: goal ? [goal.source] : [], ruleIds: [], verified: false
    };
    var experienceItems = current.filter(function (item) { return item.type === "requirement"; });
    var experienceFields = ["features", "requirements", "designPreferences"].filter(function (field) { return !!safe.memory.project[field]; });
    var experience = {
      id: "experience", title: "User experience", status: experienceItems.length || experienceFields.length ? "observed" : "unknown",
      label: experienceItems.length || experienceFields.length ? "User-stated requirements" : "Not specified",
      summary: experienceItems.length ? experienceItems.map(function (item) { return item.text; }).join("; ") : experienceFields.length ? safe.memory.project[experienceFields[0]] : "Describe what someone should be able to do and the success and failure states.",
      evidence: "A conceptual feature flow, not a runtime trace.",
      sources: experienceItems.map(function (item) { return item.source; }).concat(experienceFields.map(function (field) { return safe.projectSources[field]; }).filter(Boolean)).slice(0, MAX_SOURCES),
      ruleIds: [], verified: false
    };
    var verification = {
      id: "verification", title: "Human verification", status: checkCounts.reported ? "user-reported" : "unknown",
      label: checkCounts.reported ? "User-reported, not verified" : "Not verified",
      summary: checkCounts.checked + " current-scope check(s) marked by the user; " + checkCounts.needsRepeat + " need repeating after a scope change. Bob has run no tests.",
      evidence: "Manual checklist reports only; no execution results are collected by this model.", sources: [], ruleIds: [], verified: false
    };
    var flow = [
      intent, experience,
      node("inputs", "Inputs and output", ["input-output", "error-handling"], "Identify inputs, validation and safe display behavior; implementation is unknown."),
      node("auth", "Authentication and ownership", ["authentication-authorization", "cors-csrf-session", "rate-abuse"], "Identify who is signed in and who may read or change each record; implementation is unknown."),
      node("data", "Data and secrets", ["database-data-access", "secrets-env", "logging-pii"], "Identify stored data, server-side secrets and logging boundaries; implementation is unknown."),
      verification
    ];
    return freeze({
      workspaceId: safe.id, mode: "deterministic-local", flowKind: "conceptual", scope: safe.scope, scopeSource: safe.scopeSource,
      intent: { current: current, replaced: ledger.items.filter(function (item) { return item.status === "replaced"; }), uncertain: ledger.items.filter(function (item) { return item.status === "uncertain"; }), currentGoal: intent.summary },
      flow: flow, edges: flow.slice(1).map(function (item, index) { return { from: flow[index].id, to: item.id, label: "Conceptual relationship" }; }),
      findings: findings, findingCounts: summary.counts, summary: summary, clarification: clarification,
      checks: checks, checkCounts: checkCounts, limitations: LIMITATIONS
    });
  }

  function lessonFor(nodeId, state) {
    var analysis = analyzeWorkspace(state);
    var node = analysis.flow.find(function (item) { return item.id === nodeId; });
    if (!node) { return null; }
    var lessons = {
      intent: {
        explanation: "A brief states the outcome. A question or an assistant suggestion is not a new agreed goal.",
        why: "Keeping user decisions separate prevents a teaching reply from silently changing the project.",
        recommendedChange: "Write one Goal: statement, one user action and its expected result. Choose demo or production when accounts or data boundaries are involved.",
        secureExample: "Goal: Build a private fake-account demo.\nRequirement: Show a generic error for failed sign-in.\nConstraint: Do not use real credentials.",
        verification: ["Compare the recorded goal and source message with your brief.", "When the goal changes, make the replacement explicit; review the replaced ledger item."]
      },
      experience: {
        explanation: "A feature flow describes what a person does and sees; it does not show code executing.",
        why: "Success, failure and permission-denied paths are easier to implement when they are written down first.",
        recommendedChange: "Describe one action and its success, invalid-input and access-denied outcomes.",
        secureExample: "Action: Open my own record.\nSuccess: Return only my record.\nDenied: Return a generic not-found response for someone else's record.",
        verification: ["Walk through each written outcome with fake test data.", "Compare the displayed result with the requirements; Bob cannot perform that walkthrough."]
      },
      inputs: {
        explanation: "User input crosses a trust boundary. Validate it on the server and render untrusted text as text.",
        why: "Browser validation can be bypassed, and rendering text as HTML can execute unintended markup.",
        recommendedChange: "Apply type, length and format limits on the server; use a text-only output API for pasted content.",
        secureExample: "if (typeof body.title !== 'string' || body.title.length > 120) return badRequest();\nelement.textContent = body.title; // not innerHTML",
        verification: ["Send missing, oversized and wrong-type values directly to the server.", "Display HTML-like input and check that it remains visible text rather than executing."]
      },
      auth: {
        explanation: "Authentication asks who you are. Authorization asks whether that signed-in person owns or may access this particular record.",
        why: "A login screen alone does not stop account A from changing an ID and reading or editing account B's data.",
        recommendedChange: "Require a server-validated session on protected routes and enforce ownership on every read and write. Derive the owner from the session, never from request body userId or role.",
        secureExample: "// Illustrative server-side pseudocode; session and db adapters are required.\nconst actor = requireValidatedSession(request); // reject signed-out callers\nconst record = await db.oneOrNone(\n  'SELECT id, title FROM records WHERE id = $1 AND owner_id = $2',\n  [validatedRecordId(request), actor.id]\n);\nif (!record) return notFound();\n// Apply the same owner_id predicate to UPDATE and DELETE.",
        verification: ["Create two fake accounts A and B with separate records.", "Signed out, request a protected record and confirm rejection.", "As A, substitute B's record ID for both read and write requests; confirm denial and unchanged B data.", "Try sending B's userId or an admin role in the body; check the server ignores it.", "Log out and replay the old session; inspect session expiry, invalidation and relevant cookie/CSRF controls."]
      },
      data: {
        explanation: "Data access, secrets and logs are separate boundaries even when they share a server.",
        why: "A parameterized query can still expose another user's data if ownership is missing; a frontend key is visible to its users.",
        recommendedChange: "Bind query values, derive owner IDs from validated sessions, keep provider keys in server configuration and log only the minimum non-sensitive details.",
        secureExample: "await db.execute(\n  'UPDATE records SET title = $1 WHERE id = $2 AND owner_id = $3',\n  [validatedTitle, validatedId, session.user.id]\n);\nconst providerKey = process.env.PROVIDER_KEY; // server only\nlogger.info({ requestId, outcome: 'denied' }); // no passwords or tokens",
        verification: ["Inspect queries for bound values and ownership predicates on reads and writes.", "Test another account's record ID and confirm that its data remains unchanged.", "Inspect the built client bundle and logs for real keys, passwords and session values."]
      },
      verification: {
        explanation: "A checkbox records what you report. It is not an independent test result.",
        why: "Scope or implementation changes can invalidate earlier checks, and text cannot establish deployment readiness.",
        recommendedChange: "Run the relevant checks yourself, keep results in your own test records and repeat scope-dependent checks after a scope change.",
        secureExample: "Human test record: account A cannot read/update account B's fixture.\nRecord the environment, expected result and actual result outside Bob.\nA Bob checkbox remains user-reported, not verified.",
        verification: ["Use fake fixtures and run the signed-out and cross-account read/write cases.", "Record actual results and check the server-side implementation.", "Mark only checks you performed, and repeat them when scope or implementation changes."]
      }
    };
    return freeze(Object.assign({ nodeId: nodeId, title: node.title, context: node.summary, label: node.label, sources: node.sources, scope: analysis.scope, limitations: LIMITATIONS }, lessons[nodeId], {
      scopeGuidance: analysis.scope === "demo" ? "For a private demo, use fake accounts and data and label simulated behavior. A demo is not evidence of production authentication." : analysis.scope === "production" ? "For real users, plan server-side sessions, per-record authorization, validated inputs, secret handling and abuse controls, then independently review the implementation." : "Scope is unspecified; ask about demo versus production only when it changes the security plan."
    }));
  }
  function localReply(question, state) {
    var safe = requireState(state);
    var asked = text(question, MAX_TEXT);
    var analysis = analyzeWorkspace(safe);
    if (!asked) { return "Deterministic local teaching: ask about your goal, inputs, authentication, data or verification. No question was provided and no workspace decision was changed."; }
    var nodeId = /\b(?:auth\w*|login|log[ -]?in|sign[ -]?in|session|cookie|permission|owner\w*|ownership|account\w*|record(?:s)?|access control)\b/i.test(asked) ? "auth" :
      /\b(?:database|sql|query|data|secret|key|logging|privacy)\b/i.test(asked) ? "data" :
      /\b(?:input|validat\w*|xss|html|sanitiz\w*|encod\w*)\b/i.test(asked) ? "inputs" :
      /\b(?:test\w*|check\w*|verif\w*|ready|readiness|deploy\w*|secure|security)\b/i.test(asked) ? "verification" :
      /\b(?:feature|experience|screen|flow|design)\b/i.test(asked) ? "experience" : "intent";
    var lesson = lessonFor(nodeId, safe);
    var goal = safe.memory.guidance.currentGoal;
    return text([
      "Deterministic local teaching (no AI inference; no workspace decision changed).",
      "Workspace: " + safe.name + ". User goal: " + goal + ". Scope: " + safe.scope + ".",
      lesson.explanation, "Why: " + lesson.why, "Suggested next change: " + lesson.recommendedChange,
      "Human verification: " + lesson.verification.slice(0, 2).join(" "),
      analysis.clarification ? "Clarification: " + analysis.clarification.question : "",
      "Local signals: " + analysis.findingCounts.needsReview + " rule flag(s); " + analysis.checkCounts.checked + " current-scope user-marked check(s), 0 verified."
    ].filter(Boolean).join("\n\n"), MAX_TEXT);
  }
  function toCloudPayload(state, question) {
    // Invoke only after the caller obtains separate cloud-processing consent.
    // This constructs data; it does not obtain consent or send a request.
    var safe = requireState(state);
    var asked = text(question, MAX_TEXT);
    if (!asked) { throw new TypeError("A non-empty cloud question is required."); }
    var project = {};
    core.PROJECT_FIELDS.forEach(function (field) { project[field.key] = text(safe.memory.project[field.key], MAX_TEXT); });
    project.projectName = safe.name;
    return freeze({
      conversationKey: "workspace:" + safe.id,
      messages: safe.messages.map(function (message) { return { role: message.role, text: message.text }; }),
      project: project, userMessage: asked, cloudConsent: true
    });
  }
  function markdown(value) {
    return String(value == null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/([\\`*_{}\[\]()#+.!|~-])/g, "\\$1");
  }
  function sourceLabel(source) {
    return source ? source.label + "; " + source.reference + (source.retained ? " (recent message)" : " (earlier user source)") : "No source recorded";
  }
  function exportMarkdown(state) {
    var safe = requireState(state);
    var analysis = analyzeWorkspace(safe);
    var lines = [
      "# Bob workspace: " + markdown(safe.name), "", "- Workspace key: workspace:" + safe.id,
      "- Scope: " + safe.scope, "- Scope source: " + markdown(sourceLabel(safe.scopeSource)),
      "- Created: " + markdown(safe.createdAt || "Not supplied"), "- Updated: " + markdown(safe.updatedAt || "Not supplied"),
      "- Persistence: caller-managed; this model writes no storage and sends no requests.",
      "", "## Interpretation and limitations", "", LIMITATIONS,
      "", "Only explicit user messages establish intent. Assistant text is reference material, never a user decision or verified implementation.",
      "", "## User-derived project fields", ""
    ];
    core.PROJECT_FIELDS.forEach(function (field) {
      var value = safe.memory.project[field.key];
      if (value) { lines.push("- " + field.label + ": " + markdown(value) + " — source: " + markdown(sourceLabel(safe.projectSources[field.key])) + "; user-stated, not verified."); }
    });
    lines.push("", "## Intent ledger", "");
    if (!safe.memory.intentLedger.items.length) { lines.push("No explicit user intent recorded."); }
    safe.memory.intentLedger.items.forEach(function (item) {
      lines.push("- [" + item.status + "] " + item.type + ": " + markdown(item.text) + " — source: " + markdown(sourceLabel(item.source)) + "; rule confidence: " + item.confidence + " (qualitative, not a probability).");
    });
    if (analysis.clarification) { lines.push("", "## Scope clarification", "", analysis.clarification.question, analysis.clarification.reason); }
    lines.push("", "## Conceptual flow", "", "Conceptual relationships only; no runtime trace.", "");
    analysis.flow.forEach(function (node) { lines.push("- " + node.title + " [" + node.label + "]: " + markdown(node.summary)); });
    lines.push("", "## Local rule signals", "", analysis.summary.headline, "");
    analysis.findings.forEach(function (finding) {
      lines.push("- " + finding.title + " [" + finding.status + "]: " + markdown(finding.evidence || finding.detail));
      finding.sources.forEach(function (source) { lines.push("  - Source: " + markdown(sourceLabel(source))); });
    });
    lines.push("", "## User-reported checks", "", "Marked checks are user reports. Verified checks: 0.", "");
    analysis.checks.forEach(function (check) {
      lines.push("- [" + (check.checked ? "x" : " ") + "] " + check.id + ": " + markdown(check.text) + " — " + check.label + "; reported scope: " + check.scope + "; source: user-reported.");
    });
    function appendMessages(title, messages) {
      lines.push("", "## " + title, "");
      if (!messages.length) { lines.push("None retained."); }
      messages.forEach(function (message) {
        lines.push("### " + message.id + " — " + message.role + " (" + message.source + ")", "", "Source: workspace-message:" + message.id, "");
        message.text.split("\n").forEach(function (line) { lines.push("> " + markdown(line)); });
        lines.push("");
      });
    }
    appendMessages("Latest messages", safe.messages);
    appendMessages("Earlier retained user sources", safe.sources);
    return lines.join("\n") + "\n";
  }

  return freeze({
    SCHEMA_VERSION: VERSION, MAX_MESSAGES: MAX_MESSAGES, MAX_TEXT_LENGTH: MAX_TEXT, MAX_SOURCES: MAX_SOURCES,
    DEMO_BRIEF: DEMO_BRIEF, CHECK_DEFINITIONS: CHECK_DEFINITIONS,
    createWorkspace: createWorkspace, appendUserMessage: appendUserMessage, appendAssistantMessage: appendAssistantMessage,
    chooseScope: chooseScope, recordCheck: recordCheck, importTranscript: importTranscript,
    analyzeWorkspace: analyzeWorkspace, lessonFor: lessonFor, localReply: localReply,
    toCloudPayload: toCloudPayload, exportMarkdown: exportMarkdown, restoreWorkspace: restoreWorkspace
  });
}));
