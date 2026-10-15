(function (global) {
  "use strict";

  /*
   * Bob Agent hackathon demo
   *
   * This file intentionally has no dependencies. Persistence uses only the
   * same-origin workspace routes when they are available. The page may provide
   * only some of the selectors below; every renderer is written to be useful
   * when its corresponding element is absent.
   */

  var documentRef = global && global.document;
  var workspaceModel = global && global.BobWorkspaceModel;
  var initialized = false;
  var runTimer = null;
  var state = null;
  var persistenceTimer = null;
  var persistencePromise = null;
  var persistenceQueued = false;
  var persistenceRevision = 0;
  var persistenceEpoch = 0;
  var loadingPromise = null;
  var deleting = false;
  var PERSISTENCE_DEBOUNCE = 350;

  var SELECTORS = {
    status: ["#agent-status", "#status-agent", "[data-agent-status]", ".agent-status"],
    progress: ["#agent-progress", "#progress-agent", "[data-agent-progress]", ".agent-progress"],
    stage: ["#agent-stage", "[data-agent-stage]", ".agent-stage"],
    progressLabel: ["#agent-progress-label", "[data-agent-progress-label]", ".agent-progress-label"],
    flowNodes: "[data-flow-node], [data-risk-node], .flow-node, .risk-node",
    flowConnectors: "[data-flow-connector], .flow-connector",
    intentCurrent: ["#intent-current", "[data-intent-current]", ".intent-current"],
    intentReplaced: ["#intent-replaced", "[data-intent-replaced]", ".intent-replaced"],
    intentUncertain: ["#intent-uncertain", "[data-intent-uncertain]", ".intent-uncertain"],
    clarification: ["#clarification-prompt", "[data-clarification-prompt]", "[data-clarification]", ".clarification-prompt"],
    lesson: ["#lesson-panel", "[data-lesson-panel]", "[data-risk-lesson]", ".lesson-panel"],
    checklist: ["#verification-checklist", "#verify-checklist", "[data-verification-checklist]", ".verification-checklist", ".verify-checklist"],
    timeline: ["#agent-timeline", "[data-agent-timeline]", ".agent-timeline"],
    composer: ["#mentor-composer", "[data-mentor-composer]", ".mentor-composer"],
    mentorInput: ["#mentor-input", "#mentor-question", "[data-mentor-input]", "[data-chat-input]", ".mentor-input", "[name=mentor-message]"],
    chatLog: ["#chat-log", "[data-chat-log]", ".chat-log"],
    replay: ["#replay-flow", "#replay", "[data-action=replay-flow]", "[data-action=flow-replay]", ".replay-flow"],
    riskNodes: "[data-risk-node], [data-risk], .risk-node, .flow-node--risk, [data-flow-node='auth'], [data-flow-node='security'], #risk-node"
  };

  var STAGES = [
    { id: "observe", label: "Observed", title: "Reading the seeded login-app brief", progress: 14 },
    { id: "interpret", label: "Likely", title: "Mapping the login flow and inputs", progress: 32 },
    { id: "clarify", label: "Not verified", title: "One deployment-scope decision is needed", progress: 50 },
    { id: "security", label: "Not verified", title: "Reviewing the security boundary", progress: 70 },
    { id: "verify", label: "Not verified", title: "Preparing checks Bob cannot run", progress: 88 },
    { id: "ready", label: "Not verified", title: "Flow ready for a human review", progress: 100 }
  ];

  var SEED = {
    current: [
      { id: "project", claim: "Observed", text: "Build a login app for a hackathon demo." },
      { id: "feature", claim: "Observed", text: "Include a sign-in screen and a clear success or failure response." },
      { id: "boundary", claim: "Likely", text: "Treat the login form as an input and authentication boundary." }
    ],
    replaced: [
      { id: "initial-scope", claim: "Observed · Replaced", text: "Public deployment was the unconfirmed default scope." }
    ],
    uncertain: [
      { id: "deployment-scope", claim: "Not verified", text: "Choose between a private demo and a public deployment plan." },
      { id: "credential-store", claim: "Not verified", text: "No real account store or password handling has been checked." }
    ]
  };

  var FLOW_SEED = {
    intent: { claim: "Observed", text: "The brief names a login app for a hackathon demo." },
    feature: { claim: "Observed", text: "A sign-in screen and response states are in the seeded brief." },
    inputs: { claim: "Likely", text: "Email and password fields are likely inputs." },
    auth: { claim: "Not verified", text: "Authentication behavior has not been run or inspected." },
    data: { claim: "Not verified", text: "Credential storage and account data are not verified." },
    secrets: { claim: "Not verified", text: "No secret-handling implementation is verified by this demo." },
    deployment: { claim: "Not verified", text: "The deployment target is awaiting one user choice." },
    security: { claim: "Not verified", text: "Security controls need evidence from a human-run check." },
    verification: { claim: "Not verified", text: "Bob does not run tests or prove readiness." }
  };

  var CHECK_SEED = [
    { id: "invalid-password", text: "Try an invalid password and check the response does not reveal account details." },
    { id: "secret-boundary", text: "Confirm demo credentials are not committed or embedded as real secrets." },
    { id: "session-boundary", text: "Confirm the session boundary and logout behavior match the chosen scope." },
    { id: "deployment-choice", text: "Record whether this remains a private demo or needs a public deployment review." }
  ];

  function cloneItems(items) {
    return (items || []).map(function (item) {
      return { id: item.id, claim: item.claim, text: item.text };
    });
  }

  function cloneFlow() {
    var copy = {};
    Object.keys(FLOW_SEED).forEach(function (key) {
      copy[key] = { claim: FLOW_SEED[key].claim, text: FLOW_SEED[key].text };
    });
    return copy;
  }

  function newState() {
    var workspace = workspaceModel && typeof workspaceModel.createWorkspace === "function"
      ? workspaceModel.createWorkspace({ id: "login-demo", name: "Login security demo", brief: workspaceModel.DEMO_BRIEF, now: new Date().toISOString() })
      : null;
    var next = {
      runId: 0,
      stageIndex: -1,
      choice: null,
      intents: {
        current: cloneItems(SEED.current),
        replaced: cloneItems(SEED.replaced),
        uncertain: cloneItems(SEED.uncertain)
      },
      flow: cloneFlow(),
      checks: CHECK_SEED.map(function (item) {
        return { id: item.id, text: item.text, checked: false };
      }),
      timeline: [],
      chat: [],
      lesson: null,
      workspace: workspace,
      analysis: null,
      cloudConsent: false,
      providerConfigured: null,
      providerModel: "",
      paused: false
    };
    syncModelState(next);
    return next;
  }

  function modelClaim(status) {
    if (status === "observed" || status === "user-reported") return "Observed";
    if (status === "mentioned") return "Likely";
    return "Not verified";
  }

  function syncModelState(target) {
    var current = target || state;
    if (!current || !current.workspace || !workspaceModel || typeof workspaceModel.analyzeWorkspace !== "function") return;
    current.analysis = workspaceModel.analyzeWorkspace(current.workspace);
    var analysis = current.analysis;
    current.intents = {
      current: (analysis.intent.current || []).map(function (item) { return { id: item.id, claim: modelClaim(item.status), text: item.text }; }),
      replaced: (analysis.intent.replaced || []).map(function (item) { return { id: item.id, claim: "Observed · Replaced", text: item.text }; }),
      uncertain: (analysis.intent.uncertain || []).map(function (item) { return { id: item.id, claim: "Not verified", text: item.text }; })
    };
    var flow = {};
    (analysis.flow || []).forEach(function (node) {
      var key = node.id === "experience" ? "feature" : node.id;
      flow[key] = { claim: modelClaim(node.status), text: node.summary };
    });
    current.flow = Object.assign(cloneFlow(), flow);
    current.checks = (analysis.checks || []).map(function (check) {
      return { id: check.id, text: check.text, checked: !!check.checked };
    });
    current.choice = current.workspace.scope === "unspecified" ? null : current.workspace.scope;
  }

  function safeQuery(selector) {
    if (!documentRef) return null;
    if (documentRef.querySelector) {
      try { return documentRef.querySelector(selector); } catch (error) { return null; }
    }
    if (documentRef.querySelectorAll) {
      try {
        var matches = documentRef.querySelectorAll(selector);
        return matches && matches.length ? matches[0] : null;
      } catch (error) { return null; }
    }
    return null;
  }

  function safeQueryAll(selector) {
    if (!documentRef || !documentRef.querySelectorAll) return [];
    try { return Array.prototype.slice.call(documentRef.querySelectorAll(selector)); } catch (error) { return []; }
  }

  function first(selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    for (var index = 0; index < list.length; index += 1) {
      var found = safeQuery(list[index]);
      if (found) return found;
    }
    return null;
  }

  function all(selectors) {
    var list = Array.isArray(selectors) ? selectors : [selectors];
    var result = [];
    list.forEach(function (selector) {
      safeQueryAll(selector).forEach(function (node) {
        if (result.indexOf(node) < 0) result.push(node);
      });
    });
    return result;
  }

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function claim(claimLabel, message) {
    return text(claimLabel) + " · " + text(message);
  }

  function normalizeClaim(value) {
    var normalized = text(value).toLowerCase();
    if (normalized.indexOf("not verified") === 0 || normalized.indexOf("needs review") === 0) return "not-verified";
    if (normalized.indexOf("likely") === 0) return "likely";
    if (normalized.indexOf("observed") === 0) return "observed";
    return "not-verified";
  }

  function setText(node, value) {
    if (node) node.textContent = text(value);
  }

  function setVisible(node, visible) {
    if (!node) return;
    node.hidden = !visible;
    if (node.setAttribute) node.setAttribute("aria-hidden", visible ? "false" : "true");
    if (node.classList) {
      node.classList.toggle("is-visible", !!visible);
      node.classList.toggle("is-hidden", !visible);
    }
  }

  function setData(node, name, value) {
    if (!node) return;
    if (node.setAttribute) node.setAttribute("data-" + name, String(value));
    if (node.dataset) node.dataset[name] = String(value);
  }

  function clearNode(node) {
    if (!node) return;
    if ("textContent" in node) {
      node.textContent = "";
      return;
    }
    while (node.firstChild && node.removeChild) node.removeChild(node.firstChild);
  }

  function addClass(node, name) {
    if (!node || !node.classList) return;
    if (typeof node.classList.add === "function") node.classList.add(name);
    else if (typeof node.classList.toggle === "function") node.classList.toggle(name, true);
  }

  function removeClass(node, name) {
    if (!node || !node.classList) return;
    if (typeof node.classList.remove === "function") node.classList.remove(name);
    else if (typeof node.classList.toggle === "function") node.classList.toggle(name, false);
  }

  function toggleClass(node, name, enabled) {
    if (!node || !node.classList) return;
    if (typeof node.classList.toggle === "function") node.classList.toggle(name, !!enabled);
    else if (enabled) addClass(node, name);
    else removeClass(node, name);
  }

  function makeElement(tag, className, value) {
    if (!documentRef || !documentRef.createElement) return null;
    var node = documentRef.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = text(value);
    return node;
  }

  function appendClaimItem(container, item, className) {
    if (!container) return;
    var itemNode = makeElement("li", className || "agent-claim-item");
    if (!itemNode) return;
    setData(itemNode, "claim", normalizeClaim(item.claim));
    setData(itemNode, "intent-id", item.id);
    var button = makeElement("button", "ledger-entry-button");
    if (button) {
      button.type = "button";
      button.setAttribute("data-action", "select-intent");
      button.setAttribute("aria-pressed", item.claim === "Observed" ? "true" : "false");
      var marker = makeElement("span", "entry-marker");
      var markerDot = makeElement("span", "");
      var copy = makeElement("span", "entry-copy");
      var title = makeElement("strong", "", item.text);
      var meta = makeElement("small", "", item.claim);
      var arrow = makeElement("span", "entry-chevron", "↗");
      if (marker && markerDot) marker.appendChild(markerDot);
      if (copy) { if (title) copy.appendChild(title); if (meta) copy.appendChild(meta); }
      [marker, copy, arrow].forEach(function (child) { if (child) button.appendChild(child); });
      itemNode.appendChild(button);
    } else {
      itemNode.textContent = claim(item.claim, item.text);
    }
    container.appendChild(itemNode);
  }

  function renderIntentList(selectors, items, emptyText) {
    var container = first(selectors);
    if (!container) return;
    clearNode(container);
    if (!items.length) {
      var empty = makeElement("li", "agent-claim-empty", emptyText);
      if (empty) container.appendChild(empty);
      return;
    }
    items.forEach(function (item) { appendClaimItem(container, item); });
  }

  function renderIntents() {
    if (!state) return;
    var focus = first(SELECTORS.intentCurrent);
    if (focus) {
      var current = state.intents.current[0] || { claim: "Not verified", text: "No current intent item is recorded." };
      var focusCopy = focus.querySelector ? focus.querySelector("#ledger-focus-copy, [data-focus-copy], .ledger-focus-copy") : null;
      var confidence = focus.querySelector ? focus.querySelector("#intent-confidence, [data-confidence]") : null;
      var fill = focus.querySelector ? focus.querySelector("[data-confidence-fill]") : null;
      setText(focusCopy, current.text);
      setText(confidence, current.claim === "Observed" ? "82%" : current.claim === "Likely" ? "62%" : "—");
      if (fill && fill.style) fill.style.width = current.claim === "Observed" ? "82%" : current.claim === "Likely" ? "62%" : "24%";
      setData(focus, "claim", normalizeClaim(current.claim));
    }
    var list = first("#intent-list, [data-intent-list], .intent-list");
    if (list) {
      var entries = state.intents.current.concat(state.intents.replaced, state.intents.uncertain);
      var existing = list.children ? Array.prototype.filter.call(list.children, function (node) { return String(node.tagName).toLowerCase() === "li"; }) : [];
      if (!entries.length) entries = [{ id: "empty", claim: "Not verified", text: "No explicit intent has been captured." }];
      entries.forEach(function (item, index) {
        var row = existing[index];
        if (!row) { appendClaimItem(list, item, "ledger-entry"); return; }
        row.hidden = false;
        setData(row, "claim", normalizeClaim(item.claim));
        setData(row, "intent-id", item.id);
        var button = row.querySelector ? row.querySelector("button") : null;
        var title = button && button.querySelector ? button.querySelector("strong") : null;
        var meta = button && button.querySelector ? button.querySelector("small") : null;
        if (title) setText(title, item.text); else setText(button || row, item.text);
        if (meta) setText(meta, item.claim);
      });
      existing.slice(entries.length).forEach(function (row) { row.hidden = true; });
    }
    var count = first("#intent-count, [data-intent-count]");
    setText(count, String(state.intents.current.length + state.intents.replaced.length + state.intents.uncertain.length).padStart(2, "0"));
  }

  function nodeFlowKey(node) {
    if (!node) return null;
    var value = "";
    if (node.getAttribute) {
      value = node.getAttribute("data-flow-node") || node.getAttribute("data-node") || node.id || "";
    }
    value = text(value).toLowerCase();
    if (value.indexOf("intent") >= 0 || value.indexOf("goal") >= 0) return "intent";
    if (value.indexOf("security") >= 0 || value.indexOf("risk") >= 0 || value.indexOf("auth") >= 0 || value.indexOf("session") >= 0) return "auth";
    if (value.indexOf("secret") >= 0) return "secrets";
    if (value.indexOf("data") >= 0 || value.indexOf("credential") >= 0 || value.indexOf("store") >= 0) return "data";
    if (value.indexOf("deploy") >= 0 || value.indexOf("public") >= 0) return "deployment";
    if (value.indexOf("verify") >= 0 || value.indexOf("test") >= 0 || value.indexOf("check") >= 0) return "verification";
    if (value.indexOf("feature") >= 0 || value.indexOf("flow") >= 0 || value.indexOf("experience") >= 0) return "feature";
    if (value.indexOf("input") >= 0 || value.indexOf("form") >= 0) return "inputs";
    return null;
  }

  function stateChild(node) {
    if (!node || !node.querySelector) return null;
    return node.querySelector("[data-flow-state], .flow-state, .node-state, .state-label");
  }

  function renderFlowNode(node, key) {
    if (!node || !state.flow[key]) return;
    var flowState = state.flow[key];
    var normalized = normalizeClaim(flowState.claim);
    setData(node, "state", normalized);
    setData(node, "claim-label", flowState.claim);
    if (node.setAttribute) node.setAttribute("aria-label", text(node.getAttribute("aria-label") || key) + ": " + claim(flowState.claim, flowState.text));
    if (node.classList) {
      ["is-observed", "is-likely", "is-not-verified", "state-observed", "state-likely", "state-not-verified"].forEach(function (className) {
        removeClass(node, className);
      });
      addClass(node, "is-" + normalized);
      addClass(node, "state-" + normalized);
    }
    var label = stateChild(node);
    if (!label && documentRef && documentRef.createElement) {
      label = makeElement("span", "flow-state", "");
      if (label) {
        setData(label, "flow-state", "");
        node.appendChild(label);
      }
    }
    setText(label, flowState.claim);
    if (label) setData(label, "claim-label", flowState.claim);
  }

  function connectorKey(connector) {
    if (!connector || !connector.getAttribute) return "";
    return (connector.getAttribute("data-flow-from") || "") + " " + (connector.getAttribute("data-flow-to") || "") + " " + (connector.id || "");
  }

  function renderFlow() {
    if (!state) return;
    all(SELECTORS.flowNodes).forEach(function (node) {
      var key = nodeFlowKey(node);
      if (key) renderFlowNode(node, key);
    });
    var stage = state.stageIndex;
    all(SELECTORS.flowConnectors).forEach(function (connector, index) {
      var name = connectorKey(connector).toLowerCase();
      var complete = state.choice && (name.indexOf("auth") >= 0 || name.indexOf("security") >= 0 || name.indexOf("deploy") >= 0) && stage >= 3;
      var active = stage >= Math.min(index, STAGES.length - 1);
      toggleClass(connector, "is-active", !!active);
      toggleClass(connector, "is-complete", !!complete || stage >= 5);
      setData(connector, "state", complete || stage >= 5 ? "observed" : active ? "likely" : "not-verified");
    });
  }

  function renderClarification() {
    var panel = first(SELECTORS.clarification);
    if (!panel) return;
    var prompt = panel.querySelector ? panel.querySelector("[data-clarification-copy], .clarification-copy") : null;
    if (!prompt) prompt = panel;
    var choices = all(["[data-clarify-choice]", "[data-clarification-choice]", "[data-action=choose-demo]", "[data-action=choose-public]", "[data-action=clarify-demo]", "[data-action=clarify-public]", "#choose-demo", "#choose-public", "#clarify-demo", "#clarify-public", ".clarify-demo", ".clarify-public"]);
    if (!state.choice) {
      setVisible(panel, true);
      if (prompt === panel && panel.children && panel.children.length === 0) {
        var copy = makeElement("p", "clarification-copy", "Not verified · The deployment scope needs one choice before Bob teaches the next step.");
        if (copy) panel.appendChild(copy);
      } else if (prompt !== panel) {
        setText(prompt, "Not verified · The deployment scope needs one choice before Bob teaches the next step.");
      }
      if (!choices.length && panel.appendChild) {
        ["demo", "public"].forEach(function (choice) {
          var button = makeElement("button", "clarification-choice clarification-choice--" + choice, choice === "demo" ? "Keep it as a demo" : "Plan public deployment");
          if (!button) return;
          button.type = "button";
          setData(button, "clarify-choice", choice);
          panel.appendChild(button);
        });
        choices = all(["[data-clarify-choice]", "[data-clarification-choice]", "[data-action=choose-demo]", "[data-action=choose-public]", "[data-action=clarify-demo]", "[data-action=clarify-public]", "#choose-demo", "#choose-public", "#clarify-demo", "#clarify-public", ".clarify-demo", ".clarify-public"]);
      }
      choices.forEach(function (button) {
        var choice = choiceFromNode(button);
        if (choice) {
          setVisible(button, true);
          if (!text(button.textContent)) setText(button, choice === "demo" ? "Keep it as a demo" : "Plan public deployment");
          setData(button, "choice-state", "available");
        }
      });
      return;
    }
    setVisible(panel, false);
    choices.forEach(function (button) {
      setData(button, "choice-state", buttonChoice(button) === state.choice ? "selected" : "replaced");
    });
  }

  function buttonChoice(node) {
    if (!node || !node.getAttribute) return "";
    var value = node.getAttribute("data-clarify-choice") || node.getAttribute("data-clarification-choice") || node.getAttribute("data-choice") || node.getAttribute("data-action") || node.id || node.className || "";
    value = text(value).toLowerCase();
    return value.indexOf("public") >= 0 ? "public" : value.indexOf("demo") >= 0 ? "demo" : "";
  }

  function choiceFromNode(node) {
    return buttonChoice(node);
  }

  function renderChecklist() {
    var container = first(SELECTORS.checklist);
    if (!container) return;
    var existing = all(["[data-verification-item]", "[data-check-id]", "[data-verify-item]", ".verification-item", ".verify-item"]).filter(function (node) {
      return !container.contains || container.contains(node);
    });
    if (!existing.length) {
      clearNode(container);
      state.checks.forEach(function (check) {
        var row = makeElement("li", "verification-item");
        if (!row) return;
        setData(row, "verification-item", check.id);
        var label = makeElement("label", "verification-label");
        var input = makeElement("input");
        var copy = makeElement("span", "verification-copy");
        if (input) {
          input.type = "checkbox";
          if (input.setAttribute) input.setAttribute("type", "checkbox");
          input.checked = !!check.checked;
          input.setAttribute("aria-label", claim("Not verified", check.text));
        }
        if (copy) copy.textContent = claim("Not verified", check.text);
        if (label) {
          if (input) label.appendChild(input);
          if (copy) label.appendChild(copy);
          row.appendChild(label);
        }
        var status = makeElement("span", "verification-status");
        setText(status, verificationStatus(check));
        if (status) row.appendChild(status);
        container.appendChild(row);
      });
      return;
    }
    existing.forEach(function (row, index) {
      var id = row.getAttribute("data-verification-item") || row.getAttribute("data-check-id") || row.getAttribute("data-verify-item") || (state.checks[index] && state.checks[index].id);
      var check = findCheck(id) || state.checks[index];
      if (!check) return;
      setData(row, "verification-item", check.id);
      var input = row.querySelector ? row.querySelector("input[type=checkbox]") : null;
      if (input) input.checked = !!check.checked;
      var status = row.querySelector ? row.querySelector("[data-verification-status], .verification-status") : null;
      if (!status && documentRef && documentRef.createElement) {
        status = makeElement("span", "verification-status", "");
        if (status) row.appendChild(status);
      }
      setText(status, verificationStatus(check));
      setData(row, "claim", check.checked ? "observed" : "not-verified");
    });
  }

  function findCheck(id) {
    for (var index = 0; index < state.checks.length; index += 1) {
      if (state.checks[index].id === id) return state.checks[index];
    }
    return null;
  }

  function verificationStatus(check) {
    return check.checked
      ? claim("Observed", "You marked this check complete; Bob did not execute it.")
      : claim("Not verified", "Waiting for a human-run check.");
  }

  function renderTimeline() {
    var container = first(SELECTORS.timeline);
    if (!container) return;
    clearNode(container);
    state.timeline.forEach(function (entry) {
      var row = makeElement("li", "timeline-entry", claim(entry.claim, entry.text));
      if (row) {
        setData(row, "claim", normalizeClaim(entry.claim));
        container.appendChild(row);
      }
    });
  }

  function addTimeline(claimLabel, message) {
    if (!state) return;
    state.timeline.push({ claim: claimLabel, text: message });
    if (state.timeline.length > 32) state.timeline.shift();
    renderTimeline();
  }

  function renderChat() {
    var container = first(SELECTORS.chatLog);
    if (!container) return;
    clearNode(container);
    state.chat.forEach(function (message) {
      var row = makeElement("article", "mentor-message mentor-message--" + message.role);
      if (!row) return;
      setData(row, "chat-role", message.role);
      var speaker = makeElement("strong", "mentor-speaker", message.role === "user" ? "You" : "Bob");
      var body = makeElement("p", "mentor-message-copy", message.text);
      if (speaker) row.appendChild(speaker);
      if (body) row.appendChild(body);
      container.appendChild(row);
    });
    if (container.scrollHeight !== undefined) container.scrollTop = container.scrollHeight;
  }

  function seedChat() {
    state.chat = [{
      role: "assistant",
      text: claim("Observed", "Seeded login-app brief loaded locally.") + "\n" +
        claim("Likely", "Start with a private demo boundary.") + "\n" +
        claim("Not verified", "No app code, test, or deployment has been run by Bob.")
    }];
  }

  function renderAgent() {
    if (!state) return;
    var stage = STAGES[state.stageIndex];
    var status = first(SELECTORS.status);
    var stageNode = first(SELECTORS.stage);
    var labelNode = first(SELECTORS.progressLabel);
    var progress = first(SELECTORS.progress);
    if (stage) {
      var statusText = claim(stage.label, stage.title);
      setText(status, statusText);
      setText(stageNode, statusText);
      setText(labelNode, statusText);
      setData(status, "claim", normalizeClaim(stage.label));
      setData(stageNode, "claim", normalizeClaim(stage.label));
      if (progress) {
        if ("value" in progress) progress.value = stage.progress;
        if (progress.style) progress.style.width = stage.progress + "%";
        if (progress.setAttribute) {
          progress.setAttribute("aria-valuenow", String(stage.progress));
          progress.setAttribute("aria-valuetext", statusText);
          progress.setAttribute("data-progress", String(stage.progress));
        }
      }
    }
    renderFlow();
    renderClarification();
  }

  function timelineStage(stage) {
    if (!stage) return;
    var already = state.timeline.some(function (entry) { return entry.stage === stage.id; });
    if (already) return;
    state.timeline.push({ stage: stage.id, claim: stage.label, text: stage.title });
    if (state.timeline.length > 32) state.timeline.shift();
    renderTimeline();
  }

  function delay() {
    if (typeof global.BOB_AGENT_STAGE_DELAY === "number") return Math.max(0, global.BOB_AGENT_STAGE_DELAY);
    try {
      if (global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches) return 40;
    } catch (error) { /* Reduced motion is optional in a plain standalone page. */ }
    return 480;
  }

  function schedule(callback, wait) {
    if (global && typeof global.setTimeout === "function") return global.setTimeout(callback, wait);
    return setTimeout(callback, wait);
  }

  function cancelTimer() {
    if (runTimer === null) return;
    if (global && typeof global.clearTimeout === "function") global.clearTimeout(runTimer);
    else clearTimeout(runTimer);
    runTimer = null;
  }

  function cancelPersistenceTimer() {
    if (persistenceTimer === null) return;
    if (global && typeof global.clearTimeout === "function") global.clearTimeout(persistenceTimer);
    else clearTimeout(persistenceTimer);
    persistenceTimer = null;
  }

  function setPersistenceStatus(label, detail) {
    var node = first("#persistence-status, [data-persistence-status]");
    if (!node) return;
    var labelNode = node.querySelector ? node.querySelector("[data-persistence-label]") : null;
    setText(labelNode || node, label);
    setData(node, "status", String(label).toLowerCase());
    if (node.setAttribute) node.setAttribute("title", detail || label);
  }

  function providerSummary() {
    if (!state || state.providerConfigured === null) return "providerConfigured: checking · model: checking";
    return "providerConfigured: " + (state.providerConfigured ? "true" : "false") + " · model: " + state.providerModel;
  }

  function setProviderStatus(label, detail) {
    var node = first("#provider-status, [data-provider-status]");
    if (!node) return;
    setText(node, label);
    if (state && state.providerConfigured !== null) setData(node, "provider-configured", state.providerConfigured ? "true" : "false");
    if (state && state.providerModel) setData(node, "provider-model", state.providerModel);
    if (node.setAttribute) node.setAttribute("title", detail || label);
  }

  function renderCloudStatus() {
    if (!state) return;
    var summary = providerSummary();
    setCloudStatus(state.cloudConsent
      ? "Cloud on · consent recorded; " + summary + ". Review responses before acting."
      : "Cloud off · local deterministic teaching is active; " + summary + ".");
  }

  function loadProviderHealth() {
    if (!state || !global || typeof global.fetch !== "function") {
      setProviderStatus("Provider health unavailable · GET /health", "The workspace server is unavailable; no credential was requested.");
      return;
    }
    setProviderStatus("Checking provider · GET /health…", "Checking provider availability and model only; no conversation data or credential is sent.");
    Promise.resolve().then(function () {
      return global.fetch("/health", { method: "GET", headers: { "Accept": "application/json" } });
    }).then(function (response) {
      if (!response || !response.ok || typeof response.json !== "function") throw new Error("health_unavailable");
      return response.json();
    }).then(function (body) {
      if (!body || body.ok !== true || typeof body.providerConfigured !== "boolean" || typeof body.model !== "string" || !text(body.model)) {
        throw new Error("invalid_health");
      }
      state.providerConfigured = body.providerConfigured;
      state.providerModel = text(body.model);
      setProviderStatus(providerSummary(), "Reported by GET /health. The server returns availability and model only; it never returns the API key.");
      renderCloudStatus();
    }).catch(function () {
      state.providerConfigured = null;
      state.providerModel = "";
      setProviderStatus("Provider health unavailable · GET /health", "The health response could not be read; no credential was requested.");
      renderCloudStatus();
    });
  }

  function workspaceRoute(id, suffix) {
    var safeId = encodeURIComponent(String(id || "login-demo"));
    return "/api/workspaces/" + safeId + (suffix || "");
  }

  function canonicalWorkspace(value) {
    if (!workspaceModel || typeof workspaceModel.restoreWorkspace !== "function") return null;
    try { return workspaceModel.restoreWorkspace(value); } catch (error) { return null; }
  }

  function chatFromWorkspace(workspace) {
    return workspace && Array.isArray(workspace.messages)
      ? workspace.messages.map(function (message) { return { role: message.role, text: message.text }; })
      : [];
  }

  function adoptCanonicalWorkspace(value, revision) {
    var canonical = canonicalWorkspace(value);
    if (!canonical || !state || deleting || revision !== persistenceRevision) return false;
    state.workspace = canonical;
    syncModelState();
    renderAll();
    return true;
  }

  function schedulePersistence() {
    if (!state || !state.workspace || deleting) return;
    persistenceRevision += 1;
    persistenceQueued = true;
    setPersistenceStatus("Saving", "Workspace changes are queued for same-origin persistence.");
    cancelPersistenceTimer();
    persistenceTimer = schedule(function () {
      persistenceTimer = null;
      flushPersistence();
    }, PERSISTENCE_DEBOUNCE);
  }

  function flushPersistence() {
    if (!state || !state.workspace || deleting || !persistenceQueued) return;
    if (persistencePromise) return;
    if (!global || typeof global.fetch !== "function") {
      persistenceQueued = false;
      setPersistenceStatus("Offline", "Workspace persistence is unavailable; local changes remain in this session.");
      return;
    }

    persistenceQueued = false;
    var revision = persistenceRevision;
    var epoch = persistenceEpoch;
    var workspace = state.workspace;
    setPersistenceStatus("Saving", "Workspace changes are being saved.");
    var request = Promise.resolve().then(function () {
      return global.fetch(workspaceRoute(workspace.id), {
        method: "PUT",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify(workspace)
      });
    }).then(function (response) {
      if (!response || !response.ok || typeof response.json !== "function") throw new Error("persistence_failed");
      return response.json();
    }).then(function (body) {
      if (epoch !== persistenceEpoch || deleting) return;
      if (revision !== persistenceRevision) {
        persistenceQueued = true;
        setPersistenceStatus("Saving", "New workspace changes are waiting to be saved.");
        return;
      }
      if (!adoptCanonicalWorkspace(body, revision)) throw new Error("invalid_canonical_workspace");
      setPersistenceStatus("Saved", "Workspace is saved to the local workspace server.");
    }).catch(function () {
      if (epoch === persistenceEpoch && !deleting && revision === persistenceRevision) {
        setPersistenceStatus("Offline", "Workspace could not be saved; local changes remain in this session.");
      }
    }).then(function () {
      persistencePromise = null;
      if (persistenceQueued && !deleting && persistenceTimer === null) {
        persistenceTimer = schedule(function () {
          persistenceTimer = null;
          flushPersistence();
        }, PERSISTENCE_DEBOUNCE);
      }
    });
    persistencePromise = request;
  }

  function loadWorkspace() {
    if (!state || !state.workspace || !global || typeof global.fetch !== "function") {
      setPersistenceStatus("Offline", "Workspace server unavailable; using the local demo model.");
      return;
    }
    var revision = persistenceRevision;
    var epoch = persistenceEpoch;
    loadingPromise = Promise.resolve().then(function () {
      return global.fetch(workspaceRoute("login-demo"), { headers: { "Accept": "application/json" } });
    }).then(function (response) {
      if (response && response.status === 404) {
        if (revision === persistenceRevision && epoch === persistenceEpoch && !deleting) {
          setPersistenceStatus("Offline", "No saved workspace was found; the local demo model is active.");
        }
        return null;
      }
      if (!response || !response.ok || typeof response.json !== "function") throw new Error("workspace_load_failed");
      return response.json();
    }).then(function (body) {
      if (!body || revision !== persistenceRevision || epoch !== persistenceEpoch || deleting) return;
      var canonical = canonicalWorkspace(body);
      if (!canonical) throw new Error("invalid_workspace");
      state.workspace = canonical;
      state.chat = chatFromWorkspace(canonical);
      syncModelState();
      renderAll();
      setPersistenceStatus("Saved", "Canonical workspace restored from the local workspace server.");
    }).catch(function () {
      if (revision === persistenceRevision && epoch === persistenceEpoch && !deleting) {
        setPersistenceStatus("Offline", "Workspace could not be loaded; using the local demo model.");
      }
    }).then(function () {
      loadingPromise = null;
    });
  }

  function exportWorkspace() {
    if (!state || !state.workspace || !global || typeof global.fetch !== "function") {
      setPersistenceStatus("Offline", "Workspace export is unavailable; the local workspace is still open.");
      return false;
    }
    var id = state.workspace.id;
    global.fetch(workspaceRoute(id, "/export.md"), { headers: { "Accept": "text/markdown" } }).then(function (response) {
      if (!response || !response.ok) throw new Error("export_failed");
      if (typeof response.blob === "function") return response.blob();
      if (typeof response.text === "function") return response.text().then(function (body) { return new Blob([body], { type: "text/markdown" }); });
      throw new Error("export_unavailable");
    }).then(function (blob) {
      if (!documentRef || !documentRef.createElement || !global.URL || typeof global.URL.createObjectURL !== "function") throw new Error("download_unavailable");
      var link = documentRef.createElement("a");
      var url = global.URL.createObjectURL(blob);
      link.href = url;
      link.download = "bob-workspace-" + id + ".md";
      link.hidden = true;
      if (documentRef.body && documentRef.body.appendChild) documentRef.body.appendChild(link);
      if (typeof link.click === "function") link.click();
      if (link.remove) link.remove();
      if (typeof global.URL.revokeObjectURL === "function") schedule(function () { global.URL.revokeObjectURL(url); }, 1000);
      toast("Workspace export downloaded.");
    }).catch(function () {
      setPersistenceStatus("Offline", "Workspace export is unavailable; the local workspace is still open.");
    });
    return true;
  }

  function resetToFreshWorkspace() {
    cancelTimer();
    state = newState();
    seedChat();
    renderAll();
    addTimeline("Observed", "A fresh local workspace is ready after deletion.");
    setPersistenceStatus("Offline", "The saved workspace was deleted; a fresh local demo is active.");
    animateRun(state.runId);
  }

  function deleteWorkspace() {
    if (!state || !state.workspace || deleting) return false;
    if (typeof global.confirm === "function" && !global.confirm("Delete this workspace and start a fresh one?")) return false;
    if (!global || typeof global.fetch !== "function") {
      setPersistenceStatus("Offline", "Workspace deletion is unavailable; your local workspace was kept.");
      return false;
    }
    deleting = true;
    persistenceEpoch += 1;
    persistenceQueued = false;
    cancelPersistenceTimer();
    setPersistenceStatus("Saving", "Deleting the workspace.");
    var id = state.workspace.id;
    var waitForSave = persistencePromise || Promise.resolve();
    waitForSave.then(function () {
      return global.fetch(workspaceRoute(id), { method: "DELETE", headers: { "Accept": "application/json" } });
    }).then(function (response) {
      if (!response || response.status !== 404 && !response.ok) throw new Error("delete_failed");
      persistenceRevision += 1;
      persistenceEpoch += 1;
      deleting = false;
      resetToFreshWorkspace();
    }, function () {
      deleting = false;
      setPersistenceStatus("Offline", "Workspace could not be deleted; your local workspace was kept.");
    });
    return true;
  }

  function animateRun(runId) {
    if (!state || state.runId !== runId) return;
    state.stageIndex += 1;
    if (state.stageIndex >= STAGES.length) {
      state.stageIndex = STAGES.length - 1;
      renderAgent();
      return;
    }
    var stage = STAGES[state.stageIndex];
    timelineStage(stage);
    renderAgent();
    runTimer = schedule(function () { animateRun(runId); }, delay());
  }

  function replay() {
    cancelTimer();
    state = newState();
    state.runId += 1;
    seedChat();
    renderAll();
    addTimeline("Observed", "Replay started from the seeded login-app brief.");
    schedulePersistence();
    animateRun(state.runId);
  }

  function updateFlowForChoice(choice) {
    if (choice === "demo") {
      state.flow.deployment = { claim: "Observed", text: "The user selected a private/local hackathon demo." };
      state.flow.auth = { claim: "Likely", text: "A demo authentication boundary can use clearly fake credentials." };
      state.flow.data = { claim: "Likely", text: "The selected scope suggests no real account data should be used." };
      state.flow.secrets = { claim: "Not verified", text: "Fake demo values still need a human check for secret handling." };
      state.flow.security = { claim: "Not verified", text: "Demo security controls still need evidence; selection is not proof." };
      state.flow.verification = { claim: "Not verified", text: "No test or deployment result is verified by Bob." };
    } else {
      state.flow.deployment = { claim: "Observed", text: "The user selected public deployment planning." };
      state.flow.auth = { claim: "Not verified", text: "Public authentication, sessions, and account recovery need review." };
      state.flow.data = { claim: "Not verified", text: "Public data access and credential storage are not verified." };
      state.flow.secrets = { claim: "Not verified", text: "Production secret storage and rotation are not verified." };
      state.flow.security = { claim: "Not verified", text: "A public boundary needs security evidence before release." };
      state.flow.verification = { claim: "Not verified", text: "Public readiness is not verified; Bob does not deploy or test." };
    }
  }

  function chooseDeployment(choice) {
    if (!state || (choice !== "demo" && choice !== "public")) return false;
    if (state.choice === choice) return true;
    if (state.workspace && workspaceModel && typeof workspaceModel.chooseScope === "function") {
      state.workspace = workspaceModel.chooseScope(state.workspace, choice === "public" ? "production" : "demo", { now: new Date().toISOString() });
      syncModelState();
    }
    state.choice = choice;
    var selected = choice === "demo" ? "private/local hackathon demo" : "public deployment planning";
    var replaced = choice === "demo" ? "Public deployment as the immediate goal." : "A private-only demo scope.";
    state.intents.current.push({ id: "deployment-choice", claim: "Observed", text: "The user selected " + selected + "." });
    state.intents.replaced.push({ id: "scope-" + choice, claim: "Observed · Replaced", text: replaced });
    state.intents.uncertain = state.intents.uncertain.filter(function (item) { return item.id !== "deployment-scope"; });
    if (!state.workspace) updateFlowForChoice(choice);
    renderIntents();
    renderAgent();
    bindEvents();
    addTimeline("Observed", "The user selected " + selected + "; the alternate scope is marked replaced.");
    schedulePersistence();
    return true;
  }

  function lessonText(key) {
    if (key === "deployment") {
      return [
        claim("Observed", "The scope choice changes the security boundary."),
        claim("Likely", "A public service needs stronger authentication, data, secret, and abuse-control review than a local demo."),
        claim("Not verified", "This demo has not inspected code or confirmed a deployable service."),
        claim("Not verified", "Check the chosen boundary before treating the flow as ready.")
      ].join("\n");
    }
    return [
      claim("Observed", "The seeded brief includes a login flow."),
      claim("Likely", "The login form is an input boundary and the session is an authentication boundary."),
      claim("Not verified", "Bob has not run the app or inspected its authentication code."),
      claim("Not verified", "Try a wrong-password case and confirm the response does not reveal account details.")
    ].join("\n");
  }

  function isRiskNode(node) {
    if (!node || !node.getAttribute) return false;
    var value = (node.getAttribute("data-risk-node") || node.getAttribute("data-flow-node") || node.id || "").toLowerCase();
    return value.indexOf("risk") >= 0 || value.indexOf("auth") >= 0 || value.indexOf("security") >= 0 || value.indexOf("session") >= 0 || value.indexOf("deploy") >= 0;
  }

  function showLesson(node) {
    var panel = first(SELECTORS.lesson);
    var key = nodeFlowKey(node) || "auth";
    state.lesson = key;
    if (panel) {
      clearNode(panel);
      var heading = makeElement("h3", "lesson-title", "Risk node lesson");
      var body = makeElement("p", "lesson-copy", lessonText(key));
      if (heading) panel.appendChild(heading);
      if (body) panel.appendChild(body);
      setVisible(panel, true);
      setData(panel, "lesson-node", key);
    }
    addTimeline("Not verified", "Risk lesson opened for the " + (key === "deployment" ? "deployment" : "authentication") + " boundary.");
  }

  function showLessonKey(key) {
    var node = first('[data-flow-node="' + key + '"], [data-risk-node="' + key + '"]');
    if (node) { showLesson(node); return; }
    showLesson({ getAttribute: function (name) { return name === "data-flow-node" ? key : ""; } });
  }

  function switchView(view) {
    var selected = view === "timeline" ? "timeline" : "flow";
    all("[data-view-panel]").forEach(function (panel) { setVisible(panel, panel.getAttribute("data-view-panel") === selected); });
    all("[data-view]").forEach(function (tab) {
      var active = tab.getAttribute("data-view") === selected;
      toggleClass(tab, "is-active", active);
      if (tab.setAttribute) tab.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function focusMentor(prompt) {
    var input = first(SELECTORS.mentorInput);
    if (!input) return;
    if (prompt && "value" in input) input.value = prompt;
    if (input.focus) input.focus();
    if (input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function toast(message) {
    var region = first("#toast-region, [data-toast-region]");
    setText(region, message);
    if (region) schedule(function () { setText(region, ""); }, 2600);
  }

  function bindDataActions() {
    all("[data-action]").forEach(function (node) {
      if (!node || node.getAttribute("data-bob-bound") === "true") return;
      var action = node.getAttribute("data-action");
      if (["replay-flow", "choose-demo", "choose-public", "submit-mentor", "send-mentor"].indexOf(action) !== -1) return;
      setData(node, "bob-bound", "true");
      if (!node.addEventListener) return;
      node.addEventListener("click", function (event) {
        if (action === "go-home") { if (event && event.preventDefault) event.preventDefault(); global.scrollTo?.(0, 0); return; }
        if (action === "toggle-menu") { toast("Bob is running locally in this demo. No project data was sent."); return; }
        if (action === "toggle-pause") {
          if (state.stageIndex >= STAGES.length - 1) { replay(); return; }
          if (runTimer !== null) { cancelTimer(); setData(node, "state", "paused"); setText(node.querySelector?.("[data-pause-label]"), "Resume"); toast("Agent paused. Your evidence remains unchanged."); }
          else { setData(node, "state", "ready"); setText(node.querySelector?.("[data-pause-label]"), "Pause"); animateRun(state.runId); }
          return;
        }
        if (action === "add-intent") { focusMentor("I want to clarify the current project goal: "); return; }
        if (action === "select-intent") { toast("Intent selected. Review its evidence label before treating it as settled."); return; }
        if (action === "switch-view") { switchView(node.getAttribute("data-view")); return; }
        if (action === "open-lesson") { showLessonKey(node.getAttribute("data-target") || "auth"); return; }
        if (action === "focus-mentor") { focusMentor("What is the smallest next security step?"); return; }
        if (action === "toggle-evidence-filters") { toast("Evidence filters: Observed, Likely, and Not verified."); return; }
        if (action === "show-all-evidence") { var list = first("#evidence-list"); toggleClass(list, "is-expanded", true); return; }
        if (action === "save-lesson") { addTimeline("Observed", "Lesson saved locally for this demo session."); toast("Lesson saved locally for this demo session."); return; }
        if (action === "start-lesson") { showLessonKey(state.lesson || "auth"); focusMentor("Walk me through this security boundary step by step."); return; }
        if (action === "use-prompt") { focusMentor(node.getAttribute("data-prompt") || node.textContent); return; }
        if (action === "export-workspace") { if (event && event.preventDefault) event.preventDefault(); exportWorkspace(); return; }
        if (action === "delete-workspace") { if (event && event.preventDefault) event.preventDefault(); deleteWorkspace(); return; }
        if (action === "import-transcript") { if (event && event.preventDefault) event.preventDefault(); importTranscript(); return; }
      });
    });
  }

  function verifyCheck(id, checked) {
    var check = findCheck(id);
    if (!check) return false;
    check.checked = checked === undefined ? !check.checked : !!checked;
    if (state.workspace && workspaceModel && typeof workspaceModel.recordCheck === "function") {
      state.workspace = workspaceModel.recordCheck(state.workspace, id, check.checked, { now: new Date().toISOString() });
      syncModelState();
    }
    renderChecklist();
    addTimeline(check.checked ? "Observed" : "Not verified", check.checked
      ? "The user marked “" + check.text + "” complete; Bob did not execute it."
      : "The check is open again: " + check.text);
    schedulePersistence();
    return true;
  }

  function answerFor(question) {
    var input = text(question);
    var lower = input.toLowerCase();
    if (/public|deploy|production|release/.test(lower)) {
      return [
        claim("Observed", "You asked about public deployment."),
        claim("Likely", "Review authentication, sessions, credential storage, secret rotation, abuse controls, and HTTPS before release."),
        claim("Not verified", "Bob cannot confirm deployment readiness or perform the deployment.")
      ].join("\n");
    }
    if (/security|password|secret|auth|login|session/.test(lower)) {
      return [
        claim("Observed", "The demo has a login boundary and password-like input."),
        claim("Likely", "Use fake credentials, avoid exposing secrets, and test an invalid-password response."),
        claim("Not verified", "The implementation and error behavior have not been inspected or run.")
      ].join("\n");
    }
    if (/test|verify|check|ready/.test(lower)) {
      return [
        claim("Observed", "The verification checklist is available."),
        claim("Likely", "Start with invalid-password behavior and the secret boundary."),
        claim("Not verified", "Checking a box records your review action; it is not a test result from Bob.")
      ].join("\n");
    }
    if (/demo|hackathon|scope/.test(lower)) {
      return [
        claim("Observed", "The seeded project is a login-app hackathon demo."),
        claim("Likely", "A private demo is the smallest teachable boundary."),
        claim("Not verified", "Choose the scope above before treating deployment work as settled.")
      ].join("\n");
    }
    return [
      claim("Observed", "Bob received your question in the local demo."),
      claim("Likely", "Take one small, testable step around the login boundary."),
      claim("Not verified", "This deterministic answer is guidance, not evidence that the app works.")
    ].join("\n");
  }

  function addChat(role, message) {
    state.chat.push({ role: role, text: text(message).replace(/ · /g, " · ").replace(/\s*\n\s*/g, "\n") });
    if (state.chat.length > 24) state.chat.shift();
    renderChat();
  }

  function ask(question) {
    var input = text(question);
    if (!input) return false;
    if (state.workspace && workspaceModel && typeof workspaceModel.appendUserMessage === "function") {
      state.workspace = workspaceModel.appendUserMessage(state.workspace, input, { now: new Date().toISOString(), source: "user" });
      syncModelState();
      schedulePersistence();
    }
    addChat("user", claim("Observed", "You asked: " + input));
    addTimeline("Observed", "The user asked Bob a local deterministic mentor question.");
    if (state.cloudConsent && state.workspace && workspaceModel && typeof workspaceModel.toCloudPayload === "function") {
      var payload;
      try { payload = workspaceModel.toCloudPayload(state.workspace, input); } catch (error) { payload = null; }
      if (payload) {
        setCloudStatus("Cloud on · asking the configured Bob server…");
        fetch("/v1/mentor/respond", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json" },
          body: JSON.stringify(payload)
        }).then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.json();
        }).then(function (body) {
          var reply = text(body && body.reply) || "The cloud mentor returned no readable reply.";
          if (state.workspace && workspaceModel && typeof workspaceModel.appendAssistantMessage === "function") {
            state.workspace = workspaceModel.appendAssistantMessage(state.workspace, reply, { now: new Date().toISOString(), source: "cloud" });
            syncModelState();
            schedulePersistence();
          }
          addChat("assistant", claim("Likely", reply) + "\n" + claim("Not verified", "Cloud output is a review-only suggestion; Bob did not run tests or change code."));
          addTimeline("Likely", "Cloud mentor response received; review-only and not independently verified.");
          setCloudStatus("Cloud on · response received; review it before acting.");
          renderAll();
        }).catch(function (error) {
          setCloudStatus("Cloud on · request failed (" + (error && error.message ? error.message : "server unavailable") + "). No local fallback was hidden.");
          addChat("assistant", claim("Not verified", "The optional cloud mentor was unavailable. Nothing was changed; switch cloud off to use local deterministic teaching."));
          renderAll();
        });
        return true;
      }
    }
    var localReply = answerFor(input);
    if (state.workspace && workspaceModel && typeof workspaceModel.appendAssistantMessage === "function") {
      state.workspace = workspaceModel.appendAssistantMessage(state.workspace, localReply, { now: new Date().toISOString(), source: "local" });
      syncModelState();
      schedulePersistence();
    }
    addChat("assistant", localReply);
    return true;
  }

  function importTranscript() {
    var input = first("#transcript-input, [data-transcript-input]");
    var transcript = input && "value" in input ? input.value : "";
    if (!text(transcript)) {
      toast("Paste User:/Assistant: transcript lines first.");
      return false;
    }
    if (!state || !state.workspace || !workspaceModel || typeof workspaceModel.importTranscript !== "function") {
      setPersistenceStatus("Offline", "Transcript import is unavailable in this local page.");
      return false;
    }
    try {
      state.workspace = workspaceModel.importTranscript(state.workspace, transcript, { now: new Date().toISOString() });
    } catch (error) {
      toast("Transcript could not be imported.");
      return false;
    }
    state.chat = chatFromWorkspace(state.workspace);
    syncModelState();
    renderAll();
    if (input && "value" in input) input.value = "";
    addTimeline("Observed", "A transcript was imported with explicit user and assistant roles.");
    schedulePersistence();
    toast("Transcript imported; saving workspace.");
    return true;
  }

  function setCloudStatus(value) {
    var node = first("#cloud-status, [data-cloud-status]");
    setText(node, value);
  }

  function composerInput(composer) {
    var explicit = first(SELECTORS.mentorInput);
    if (explicit) return explicit;
    if (composer && (String(composer.tagName).toLowerCase() === "textarea" || String(composer.tagName).toLowerCase() === "input")) return composer;
    if (composer && composer.querySelector) return composer.querySelector("textarea, input:not([type=submit]):not([type=button])");
    return null;
  }

  function bindComposer() {
    var composer = first(SELECTORS.composer);
    if (!composer || composer.getAttribute && composer.getAttribute("data-bob-bound") === "true") return;
    setData(composer, "bob-bound", "true");
    var submit = function (event) {
      if (event && event.preventDefault) event.preventDefault();
      var input = composerInput(composer);
      if (!input) return;
      var value = input.value || input.textContent || "";
      if (ask(value)) {
        if ("value" in input) input.value = "";
        else input.textContent = "";
      }
    };
    if (composer.addEventListener) composer.addEventListener("submit", submit);
    var button = composer.querySelector ? composer.querySelector("button[type=submit], [data-action=mentor-send], .mentor-send") : null;
    if (button && button.addEventListener) button.addEventListener("click", submit);
  }

  function closestWithin(target, selector) {
    var current = target;
    while (current && current !== documentRef) {
      if (current.matches) {
        try { if (current.matches(selector)) return current; } catch (error) { return null; }
      }
      current = current.parentElement;
    }
    return null;
  }

  function bindEvents() {
    all(SELECTORS.replay).forEach(function (button) {
      if (button.getAttribute && button.getAttribute("data-bob-bound") === "true") return;
      setData(button, "bob-bound", "true");
      if (button.addEventListener) button.addEventListener("click", function () { replay(); });
    });
    all(SELECTORS.riskNodes).forEach(function (node) {
      if (!isRiskNode(node) || (node.getAttribute && node.getAttribute("data-bob-bound") === "true")) return;
      setData(node, "bob-bound", "true");
      if (node.addEventListener) node.addEventListener("click", function () { showLesson(node); });
      if (node.addEventListener) node.addEventListener("keydown", function (event) {
        if (event && (event.key === "Enter" || event.key === " ")) {
          if (event.preventDefault) event.preventDefault();
          showLesson(node);
        }
      });
      if (node.setAttribute && !node.getAttribute("role")) node.setAttribute("role", "button");
      if (node.setAttribute && !node.getAttribute("tabindex")) node.setAttribute("tabindex", "0");
    });
    all(["[data-clarify-choice]", "[data-clarification-choice]", "[data-action=choose-demo]", "[data-action=choose-public]", "[data-action=clarify-demo]", "[data-action=clarify-public]", "#choose-demo", "#choose-public", "#clarify-demo", "#clarify-public", ".clarify-demo", ".clarify-public"]).forEach(function (button) {
      if (button.getAttribute && button.getAttribute("data-bob-bound") === "true") return;
      var choice = choiceFromNode(button);
      if (!choice) return;
      setData(button, "bob-bound", "true");
      if (button.addEventListener) button.addEventListener("click", function () { chooseDeployment(choice); });
    });
    var checklist = first(SELECTORS.checklist);
    if (checklist && checklist.addEventListener && checklist.getAttribute("data-bob-bound") !== "true") {
      setData(checklist, "bob-bound", "true");
      checklist.addEventListener("change", function (event) {
        var input = event && event.target;
        if (!input || String(input.type).toLowerCase() !== "checkbox") return;
        var row = closestWithin(input, "[data-verification-item], [data-check-id], [data-verify-item], .verification-item, .verify-item");
        var id = row && row.getAttribute ? (row.getAttribute("data-verification-item") || row.getAttribute("data-check-id") || row.getAttribute("data-verify-item")) : "";
        if (id) verifyCheck(id, input.checked);
      });
      checklist.addEventListener("click", function (event) {
        var target = event && event.target;
        if (!target || String(target.type).toLowerCase() === "checkbox") return;
        var row = closestWithin(target, "[data-verification-item], [data-check-id], [data-verify-item], .verification-item, .verify-item");
        if (!row || !row.getAttribute) return;
        var id = row.getAttribute("data-verification-item") || row.getAttribute("data-check-id") || row.getAttribute("data-verify-item");
        if (!id) return;
        var input = row.querySelector ? row.querySelector("input[type=checkbox]") : null;
        verifyCheck(id, input ? !input.checked : undefined);
      });
    }
    var cloudConsent = first("#cloud-consent, [data-cloud-consent]");
    if (cloudConsent && cloudConsent.getAttribute("data-bob-bound") !== "true") {
      setData(cloudConsent, "bob-bound", "true");
      cloudConsent.addEventListener("change", function () {
        state.cloudConsent = !!cloudConsent.checked;
        renderCloudStatus();
      });
    }
    bindComposer();
    bindDataActions();
  }

  function renderAll() {
    syncModelState();
    var projectName = state.workspace && state.workspace.name ? state.workspace.name : "Login demo";
    all("[data-project-name]").forEach(function (node) { setText(node, projectName); });
    var cloudConsent = first("#cloud-consent, [data-cloud-consent]");
    if (cloudConsent) cloudConsent.checked = !!state.cloudConsent;
    renderIntents();
    renderAgent();
    renderChecklist();
    renderTimeline();
    renderChat();
    setProviderStatus(providerSummary(), "Provider status is read from GET /health; the client never receives the API key.");
    renderCloudStatus();
    bindEvents();
  }

  function getState() {
    if (!state) return null;
    return {
      stage: state.stageIndex < 0 ? null : STAGES[state.stageIndex].id,
      stageLabel: state.stageIndex < 0 ? null : STAGES[state.stageIndex].label,
      choice: state.choice,
      intents: {
        current: cloneItems(state.intents.current),
        replaced: cloneItems(state.intents.replaced),
        uncertain: cloneItems(state.intents.uncertain)
      },
      flow: cloneFlowState(),
      checks: state.checks.map(function (check) { return { id: check.id, checked: check.checked }; }),
      lesson: state.lesson,
      timeline: state.timeline.map(function (entry) { return { claim: entry.claim, text: entry.text }; }),
      chat: state.chat.map(function (message) { return { role: message.role, text: message.text }; })
    };
  }

  function cloneFlowState() {
    var copy = {};
    Object.keys(state.flow).forEach(function (key) {
      copy[key] = { claim: state.flow[key].claim, text: state.flow[key].text };
    });
    return copy;
  }

  function init() {
    if (initialized) return global.BobAgentDemo;
    initialized = true;
    state = newState();
    seedChat();
    renderAll();
    setPersistenceStatus("Saved", "Local demo workspace is ready.");
    addTimeline("Observed", "Seeded login-app demo loaded; workspace persistence status is shown above.");
    loadWorkspace();
    loadProviderHealth();
    animateRun(state.runId);
    return global.BobAgentDemo;
  }

  var api = {
    init: init,
    replay: replay,
    chooseDeployment: chooseDeployment,
    verifyCheck: verifyCheck,
    showLesson: showLesson,
    ask: ask,
    importTranscript: importTranscript,
    exportWorkspace: exportWorkspace,
    deleteWorkspace: deleteWorkspace,
    getState: getState,
    selectors: SELECTORS
  };

  global.BobAgentDemo = api;
  global.BobAgentApp = api;

  if (documentRef && documentRef.readyState === "loading" && documentRef.addEventListener) {
    documentRef.addEventListener("DOMContentLoaded", init);
  } else if (documentRef) {
    init();
  }
}(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this));
