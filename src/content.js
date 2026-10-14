(function () {
  "use strict";
  var core = window.BobMentorCore;
  var TERMS_VERSION = "2026-10-13.7";
  var MEMORY_PREFIX = "bob.memory.";
  var PERMISSION_PREFIX = "bob.permission.";
  var MENTOR_PREFIX = "bob.mentor.";
  var CONFIG_KEY = "bob.mentor.config";
  var DEFAULT_BACKEND = "http://127.0.0.1:8787";
  var MENTOR_HISTORY_LIMIT = 40;
  var MENTOR_TIMEOUT = 28000;
  var FALLBACK_EXTENSION_VERSION = "0.5.0";
  var MENTOR_FIELDS = [
    ["projectUnderstanding", "Project understanding"],
    ["changedRequirements", "Changed requirements"],
    ["nextStep", "Next step"],
    ["securityReview", "Security review"],
    ["openQuestions", "Open questions"],
    ["uncertainty", "Uncertainty"],
    ["verificationNeeded", "Verification needed"]
  ];
  var state = {
    key: null, url: "", generation: 0, active: false, memory: null,
    permission: null, observer: null, timer: null, open: false,
    loading: false, busy: false, deleting: false, error: "", warning: "", captures: 0,
    blockedNodes: [], candidate: null, settledAt: 0, dirty: new Set(),
    ownWrites: new Set(), ownRemovals: new Set(), lastFingerprint: "",
    lastCapture: { status: "waiting", source: "", userCount: 0, assistantCount: 0, current: false, diagnostic: "" },
    capturePending: null, captureAgain: false, view: "dashboard",
    backendUrl: DEFAULT_BACKEND, configError: "", settingsTesting: false,
    settingsStatus: "", mentor: null, ownMentorWrites: new Set(),
    mentorController: null, questionDraft: "", questionAnswer: "", questionBusy: false
  };
  var queue = Promise.resolve();
  var fields = {};
  var fieldSources = {};
  var ui = {};
  function element(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function append(parent, tag, className, text) {
    var node = element(tag, className, text);
    parent.appendChild(node);
    return node;
  }
  function button(parent, label, handler, className) {
    var node = append(parent, "button", className || "bob-secondary", label);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  }
  function timestamp() { return new Date().toISOString(); }
  function uniqueId() { return crypto.randomUUID(); }
  function memoryKey(key) { return MEMORY_PREFIX + key; }
  function permissionKey(key) { return PERMISSION_PREFIX + key; }
  function mentorKey(key) { return MENTOR_PREFIX + key; }
  function token() { return { key: state.key, generation: state.generation, url: state.url }; }
  function extensionVersion() {
    try {
      if (window.chrome && chrome.runtime && typeof chrome.runtime.getManifest === "function") {
        var manifest = chrome.runtime.getManifest();
        if (manifest && typeof manifest.version === "string" && manifest.version.trim()) return manifest.version.trim();
      }
    } catch (error) { /* Use the bundled fallback when the runtime manifest is unavailable. */ }
    return FALLBACK_EXTENSION_VERSION;
  }
  function resetLastCapture() {
    state.lastCapture = { status: "waiting", source: "", userCount: 0, assistantCount: 0, current: false, diagnostic: "" };
  }
  function captureCounts(observation) {
    var messages = observation && Array.isArray(observation.messages) ? observation.messages : [];
    var counts = { userCount: 0, assistantCount: 0 };
    messages.forEach(function (message) {
      if (!message) return;
      if (message.role === "user") counts.userCount += 1;
      else if (message.role === "assistant") counts.assistantCount += 1;
    });
    return counts;
  }
  function diagnosticNumber(value) {
    return typeof value === "number" && isFinite(value) && value >= 0 ? value : null;
  }
  function rejectedRoleCount(diagnostics, role) {
    if (!diagnostics || typeof diagnostics !== "object") return null;
    var capitalized = role.charAt(0).toUpperCase() + role.slice(1);
    function objectTotal(value) {
      if (!value || typeof value !== "object") return null;
      var total = 0;
      var found = false;
      Object.keys(value).forEach(function (key) {
        var number = diagnosticNumber(value[key]);
        if (number !== null) { total += number; found = true; }
      });
      return found ? total : null;
    }
    var direct = [
      diagnostics["rejected" + capitalized + "Roles"],
      diagnostics["roleRejections" + capitalized],
      diagnostics[role + "RoleRejections"],
      diagnostics["rejected" + capitalized],
      diagnostics["rejected" + capitalized + "s"]
    ];
    for (var index = 0; index < direct.length; index += 1) {
      var number = diagnosticNumber(direct[index]);
      if (number !== null) return number;
      number = objectTotal(direct[index]);
      if (number !== null) return number;
    }
    var grouped = diagnostics.rejectedRoles || diagnostics.roleRejections || diagnostics.rejectedByRole;
    if (grouped && typeof grouped === "object") return diagnosticNumber(grouped[role]);
    return null;
  }
  function captureDiagnostic(observation, counts) {
    var diagnostics = observation && observation.diagnostics || {};
    var text = observation && observation.diagnostic ? String(observation.diagnostic) : "Capture completed.";
    var capturedUsers = diagnosticNumber(diagnostics.capturedUsers);
    var capturedAssistants = diagnosticNumber(diagnostics.capturedAssistants);
    var userRejected = rejectedRoleCount(diagnostics, "user");
    var assistantRejected = rejectedRoleCount(diagnostics, "assistant");
    var details = "Live role counts: " + counts.userCount + " user, " + counts.assistantCount + " assistant.";
    if (capturedUsers !== null || capturedAssistants !== null) {
      details += " Diagnostic totals: " + (capturedUsers === null ? counts.userCount : capturedUsers) + " user, " + (capturedAssistants === null ? counts.assistantCount : capturedAssistants) + " assistant.";
    }
    if (userRejected !== null || assistantRejected !== null) {
      details += " Role-rejected: " + (userRejected === null ? 0 : userRejected) + " user, " + (assistantRejected === null ? 0 : assistantRejected) + " assistant.";
    }
    return text + " " + details;
  }
  function setLastCapture(status, observation, diagnostic) {
    var counts = captureCounts(observation);
    var source = observation && observation.source || observation && observation.diagnostics && observation.diagnostics.source || "unknown";
    state.lastCapture = {
      status: status,
      source: source,
      userCount: counts.userCount,
      assistantCount: counts.assistantCount,
      current: status === "success" && counts.userCount > 0,
      diagnostic: diagnostic || ""
    };
    if (!state.lastCapture.current && state.mentor) {
      state.mentor.cloudConsent = false;
    }
  }
  function cloudCaptureValid() {
    return !!(state.active && state.lastCapture && state.lastCapture.status === "success" && state.lastCapture.current && state.lastCapture.userCount > 0);
  }
  function currentCapture() {
    return !!(state.lastCapture && state.lastCapture.current);
  }
  function memoryForRules() {
    if (!state.memory || currentCapture()) return state.memory;
    var memory = Object.assign({}, state.memory);
    memory.guidance = Object.assign({}, state.memory.guidance || {}, { currentGoal: "" });
    return memory;
  }
  function memoryForStorage(memory) {
    if (!memory || currentCapture()) return memory;
    var stored = Object.assign({}, memory);
    stored.guidance = Object.assign({}, memory.guidance || {}, { currentGoal: "" });
    if (core && typeof core.markdownFromMemory === "function") stored.markdown = core.markdownFromMemory(stored);
    return stored;
  }
  function valid(ticket) {
    checkUrl();
    return ticket.key && ticket.key === state.key && ticket.url === state.url && ticket.generation === state.generation;
  }
  function permitted(permission) {
    return permission && permission.granted === true && permission.version === TERMS_VERSION;
  }
  function newMentorState() {
    return {
      conversationKey: state.key,
      messages: [],
      draft: "",
      mode: "local",
      cloudConsent: false,
      response: null,
      status: "",
      error: "",
      busy: false,
      orb: "idle",
      unread: false
    };
  }
  function mentorRecord(mentor) {
    var record = mentor || newMentorState();
    var messages = Array.isArray(record.messages) ? record.messages : [];
    return {
      conversationKey: state.key,
      messages: messages.slice(-MENTOR_HISTORY_LIMIT).map(function (message) {
        return {
          role: message && message.role === "user" ? "user" : "assistant",
          content: typeof (message && message.content) === "string" ? message.content : securityText(message && message.content),
          structured: message && message.structured && typeof message.structured === "object" ? message.structured : null
        };
      }),
      draft: typeof record.draft === "string" ? record.draft.slice(0, (core && core.MAX_TURN_LENGTH) || 1800) : "",
      mode: record.mode === "cloud" ? "cloud" : "local",
      updatedAt: timestamp()
    };
  }
  function normalizeMentorRecord(record, key) {
    var value = record || {};
    if (value.conversationKey && value.conversationKey !== key) return newMentorState();
    var next = newMentorState();
    next.conversationKey = key;
    next.messages = Array.isArray(value.messages) ? value.messages.slice(-MENTOR_HISTORY_LIMIT).map(function (message) {
      return {
        role: message && message.role === "user" ? "user" : "assistant",
        content: typeof (message && message.content) === "string" ? message.content : securityText(message && message.content),
        structured: message && message.structured && typeof message.structured === "object" ? message.structured : null
      };
    }) : [];
    next.draft = typeof value.draft === "string" ? value.draft.slice(0, (core && core.MAX_TURN_LENGTH) || 1800) : "";
    next.mode = value.mode === "cloud" ? "cloud" : "local";
    // Cloud permission is deliberately session-only, never restored on reload.
    next.cloudConsent = false;
    return next;
  }
  function normalizeBackendUrl(value) {
    if (typeof value !== "string" || !value.trim()) return null;
    var raw = value.trim();
    // Validate the literal authority too: URL normalization accepts alternate
    // loopback spellings such as 127.1, decimal IPs and backslashes.
    if (!/^http:\/\/(127\.0\.0\.1|localhost)(?::[0-9]{1,5})?(?:\/[^\s\\?#]*)?$/i.test(raw)) return null;
    try {
      var parsed = new URL(raw);
      var host = String(parsed.hostname || "").toLowerCase();
      if (parsed.protocol !== "http:" || (host !== "127.0.0.1" && host !== "localhost")) return null;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
      return parsed.href.replace(/\/+$/, "");
    } catch (error) { return null; }
  }
  function configRecord() { return { backendUrl: state.backendUrl }; }
  function environmentError() {
    if (!core || typeof core.extractConversation !== "function" || typeof core.applyProjectEdits !== "function") return "Bob's local core is unavailable. Reload the extension.";
    if (!window.chrome || !chrome.runtime || !chrome.runtime.getURL || !chrome.storage || !chrome.storage.local || !chrome.storage.onChanged || !chrome.storage.onChanged.addListener) return "Browser extension storage or notifications are unavailable. Bob cannot safely activate.";
    if (!navigator.locks || typeof navigator.locks.request !== "function") return "Safe cross-tab storage locking is unavailable. Bob cannot activate.";
    // Web Locks are origin-scoped; supporting a second hostname with the same
    // extension storage keys would defeat cross-tab write serialization.
    if (window.location.origin !== "https://chatgpt.com") return "Open this conversation on https://chatgpt.com. Bob uses one canonical site origin for safe cross-tab storage.";
    return "";
  }
  function storage(method, value) {
    return new Promise(function (resolve, reject) {
      if (!window.chrome || !chrome.storage || !chrome.storage.local || !chrome.runtime) {
        reject(new Error("Extension storage is unavailable. Reload the extension and this page."));
        return;
      }
      try {
        chrome.storage.local[method](value, function (result) {
          var error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message || "Browser storage failed."));
          else resolve(result);
        });
      } catch (error) { reject(error); }
    });
  }
  // One queue here, one origin-wide lock across tabs. Revocation tombstones
  // survive deletion so delayed writes cannot resurrect a deleted memory.
  function transaction(key, work) {
    var operation = queue.then(function () {
      if (!navigator.locks || typeof navigator.locks.request !== "function") {
        throw new Error("Safe cross-tab storage locking is unavailable. Bob cannot activate.");
      }
      return navigator.locks.request("bob-mentor-storage:" + key, function () { return work(); });
    });
    queue = operation.catch(function () {});
    return operation;
  }
  function stop() {
    state.active = false;
    state.generation += 1;
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    clearTimeout(state.timer);
    state.timer = null;
    state.candidate = null;
    state.capturePending = null;
    state.captureAgain = false;
    state.questionBusy = false;
    if (state.mentor) state.mentor.cloudConsent = false;
    if (state.mentorController) {
      try { state.mentorController.abort(); } catch (error) { /* Request is already stopping. */ }
      state.mentorController = null;
      if (state.mentor && state.mentor.busy) {
        state.mentor.busy = false;
        state.mentor.orb = "concerned";
        state.mentor.status = "Cloud request stopped because capture was paused or the conversation changed.";
      }
    }
  }
  function failure(error, ticket) {
    if (ticket && !valid(ticket)) return;
    stop();
    setLastCapture("failed", null, "Capture failed: " + (error && error.message ? error.message : "an unexpected operation failed") + ". Saved memory was preserved and is stale.");
    state.busy = false;
    state.deleting = false;
    state.loading = false;
    state.error = "Stopped safely: " + (error && error.message ? error.message : "An unexpected operation failed.");
    state.warning = "Capture failed. Saved memory was preserved but is stale; cloud mentoring is disabled until a successful current capture includes a user message.";
    render();
  }
  function readRecord(key) {
    return storage("get", [memoryKey(key), permissionKey(key)]).then(function (record) {
      var memory = record[memoryKey(key)] || null;
      if (memory && memory.conversationKey !== key) throw new Error("Stored conversation identity does not match. Revoke and delete it.");
      return { memory: memory, permission: record[permissionKey(key)] || null };
    });
  }
  function readMentorRecord(key) {
    return storage("get", [mentorKey(key)]).then(function (record) {
      return normalizeMentorRecord(record[mentorKey(key)], key);
    });
  }
  function writeMemory(key, memory) {
    var updated = Object.assign({}, memory, { bobRevision: uniqueId() });
    var values = {};
    values[memoryKey(key)] = updated;
    state.ownWrites.add(updated.bobRevision);
    if (state.ownWrites.size > 100) state.ownWrites.delete(state.ownWrites.values().next().value);
    return storage("set", values).then(function () { return updated; });
  }
  function writeMentor(key, snapshot) {
    var updated = Object.assign({}, snapshot);
    updated.bobRevision = uniqueId();
    var values = {};
    values[mentorKey(key)] = updated;
    state.ownMentorWrites.add(updated.bobRevision);
    if (state.ownMentorWrites.size > 100) state.ownMentorWrites.delete(state.ownMentorWrites.values().next().value);
    return storage("set", values);
  }
  function persistMentor() {
    if (!state.key || !state.mentor || state.mentor.conversationKey !== state.key || !permitted(state.permission)) return Promise.resolve();
    var key = state.key;
    var epoch = state.permission.epoch;
    var snapshot = mentorRecord(state.mentor);
    var mentor = state.mentor;
    return transaction(key, async function () {
      var record = await readRecord(key);
      if (!permitted(record.permission) || record.permission.epoch !== epoch) return;
      return writeMentor(key, snapshot);
    }).catch(function () {
      if (state.key !== key || state.mentor !== mentor) return;
      mentor.error = "Bob chat could not be saved to local storage. The visible history is available only in this tab until storage works again.";
      renderMentor();
    });
  }
  function loadConfig() {
    return storage("get", [CONFIG_KEY]).then(function (record) {
      var value = record[CONFIG_KEY] ? normalizeBackendUrl(record[CONFIG_KEY].backendUrl) : DEFAULT_BACKEND;
      state.backendUrl = value || "";
      state.configError = value ? "" : "Saved backend URL is invalid. Cloud requests are disabled until it is replaced.";
      if (ui.backendInput && !ui.backendInput.matches(":focus")) ui.backendInput.value = record[CONFIG_KEY] && record[CONFIG_KEY].backendUrl || state.backendUrl;
      render();
    }).catch(function () {
      state.configError = "Bob could not read local backend settings. Cloud requests are disabled until storage is available.";
      render();
    });
  }

  var host = element("div");
  host.id = "bob-mentor-root";
  var shadow = host.attachShadow({ mode: "closed" });
  var sheet = append(shadow, "link");
  sheet.rel = "stylesheet";
  var styleReady = false;
  sheet.addEventListener("load", function () { styleReady = true; render(); });
  sheet.addEventListener("error", function () { failure(new Error("Bob's bundled stylesheet could not load. Check the extension installation.")); });
  if (window.chrome && chrome.runtime && chrome.runtime.getURL) sheet.href = chrome.runtime.getURL("src/styles.css");
  else state.error = "Extension APIs are unavailable. Bob cannot activate.";
  var shell = append(shadow, "div", "bob-shell");
  var panel = append(shell, "section", "bob-panel");
  panel.id = "bob-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Bob project mentor");
  var header = append(panel, "header", "bob-header");
  var brand = append(header, "div", "bob-brand-lockup");
  append(brand, "strong", "bob-brand", "Bob");
  append(brand, "span", "bob-subtitle", "Your project mentor");
  var headerRight = append(header, "div", "bob-header-actions");
  ui.privacyBadge = append(headerRight, "span", "bob-header-private", "Cloud off");
  var close = button(headerRight, "Close", function () { setOpen(false); }, "bob-close");
  close.setAttribute("aria-label", "Close Bob panel");

  var body = append(panel, "div", "bob-body");
  var nav = append(body, "aside", "bob-nav");
  append(nav, "p", "bob-nav-kicker", "Workspace");
  var navList = append(nav, "nav", "bob-nav-list");
  navList.setAttribute("aria-label", "Bob views");
  ui.views = {};
  [["dashboard", "Dashboard"], ["mentor", "Mentor chat"], ["settings", "Settings"]].forEach(function (item) {
    var link = button(navList, item[1], function () { setView(item[0]); }, "bob-nav-item");
    link.setAttribute("aria-controls", "bob-view-" + item[0]);
    ui.views[item[0]] = link;
  });
  ui.unread = append(ui.views.mentor, "span", "bob-unread", "New");
  ui.unread.hidden = true;
  append(nav, "p", "bob-nav-kicker bob-nav-recent-kicker", "Recent session");
  ui.recent = append(nav, "p", "bob-nav-recent");
  append(nav, "p", "bob-nav-note", "Local notebook. Optional cloud mentoring requires separate consent before sending context.");

  var main = append(body, "main", "bob-main");
  var workspaceHeader = append(main, "div", "bob-workspace-header");
  var workspaceHeading = append(workspaceHeader, "div");
  append(workspaceHeading, "p", "bob-eyebrow", "Conversation workspace");
  ui.workspaceTitle = append(workspaceHeading, "h1", "bob-workspace-title", "Dashboard");
  ui.disclosure = append(workspaceHeader, "span", "bob-disclosure", "Local rules · Cloud off");
  ui.key = append(main, "p", "bob-key");
  var activeBar = append(main, "section", "bob-active-bar");
  ui.status = append(activeBar, "p", "bob-status");
  ui.status.setAttribute("role", "status");
  ui.activeDetails = append(activeBar, "p", "bob-active-details", "Read-only capture is scoped to this approved conversation.");
  ui.controls = append(activeBar, "div", "bob-actions bob-active-actions");
  ui.pause = button(ui.controls, "Pause", pause);
  ui.resume = button(ui.controls, "Resume this conversation", activate);
  ui.reload = button(ui.controls, "Retry local storage", function () { checkUrl(); loadCurrent(); });
  ui.remove = button(ui.controls, "Revoke & delete local memory", revoke, "bob-danger");
  ui.error = append(main, "p", "bob-error");
  ui.error.setAttribute("role", "alert");
  ui.warning = append(main, "p", "bob-warning");
  ui.warning.setAttribute("role", "status");

  ui.consent = append(main, "section", "bob-consent bob-card");
  append(ui.consent, "p", "bob-section-kicker", "Private by choice");
  append(ui.consent, "h2", "", "Allow this conversation");
  append(ui.consent, "p", "bob-muted", "Bob starts with an empty local notebook. Approve this conversation before any rendered message text can be read; your ChatGPT input and other conversations remain out of scope.");
  var terms = append(ui.consent, "details", "bob-terms");
  terms.open = true;
  append(terms, "summary", "", "Terms & privacy · version " + TERMS_VERSION);
  var termsList = append(terms, "ul");
  [
    "Only after approval, Bob reads rendered user and assistant message text in this conversation. It does not read sidebar chats, input values, credentials, or private APIs.",
    "Captured messages, rule-based suggestions, your project edits, Bob chat history, and consent records are stored in chrome.storage.local on this browser profile. There is no page localStorage fallback, cloud sync, or telemetry. Optional cloud mentoring has its own separate consent; this approval alone never authorizes a model request.",
    "Memory includes up to 40 recent rendered messages (1800 characters each) and 40 change summaries. Local storage is not encrypted by Bob. Avoid secrets; browser-profile backups or exported files in synced folders can leave this device outside Bob's control.",
    "Browser site permission permits the extension to run on ChatGPT pages. Bob's separate code-level permission limits capture to the exact conversation key shown here; it is not a browser-enforced per-conversation permission.",
    "Approval does not override ChatGPT's terms or policies. You are responsible for checking applicable terms and having permission to process the conversation.",
    "Pause stops capture and cancels any pending Bob request. Navigation and reload require explicit activation again. Revoke & delete stops all Bob tabs for this key and removes its local project memory and Bob chat history; a minimal revocation record remains to block delayed writes. Exported files must be deleted separately. Revocation cannot recall data already sent to a backend or model provider.",
    "Dashboard suggestions use local rules. Mentor chat offers local rules or optional cloud AI. Neither builds, tests, deploys, or verifies your application. All suggestions may be incomplete or wrong; review them yourself."
  ].forEach(function (text) { append(termsList, "li", "", text); });
  var consentLabel = append(ui.consent, "label", "bob-checkbox");
  ui.checkbox = append(consentLabel, "input");
  ui.checkbox.type = "checkbox";
  append(consentLabel, "span", "", "I accept Bob's terms and privacy notice version " + TERMS_VERSION + " and authorize reading THIS CONVERSATION only.");
  ui.checkbox.addEventListener("change", render);
  ui.allow = button(ui.consent, "Allow THIS CONVERSATION", activate, "bob-primary");

  ui.dashboard = append(main, "section", "bob-dashboard");
  ui.dashboard.id = "bob-view-dashboard";
  ui.dashboardEmpty = append(main, "p", "bob-muted", "Approve a conversation to start its project dashboard, or open Mentor chat to review the available modes.");
  var guidanceBanner = append(ui.dashboard, "section", "bob-guidance-banner");
  append(guidanceBanner, "span", "bob-guidance-mark", "◎");
  var guidanceCopy = append(guidanceBanner, "div");
  append(guidanceCopy, "p", "bob-section-kicker", "Active milestone guidance");
  ui.guidanceBannerText = append(guidanceCopy, "p", "bob-guidance-banner-text");
  var guidanceHeader = append(ui.dashboard, "div", "bob-section-heading");
  append(guidanceHeader, "div", "", "");
  append(guidanceHeader, "h2", "", "Guidance dashboard");
  ui.counts = append(guidanceHeader, "p", "bob-muted");
  ui.guidance = {};
  var guidanceGrid = append(ui.dashboard, "div", "bob-guidance-grid");
  [["currentGoal", "Current goal"], ["openQuestions", "Open questions"], ["nextStep", "Suggested next step"]].forEach(function (item) {
    var card = append(guidanceGrid, "div", "bob-insight");
    append(card, "h3", "", item[1]);
    ui.guidance[item[0]] = append(card, "p");
  });
  append(ui.dashboard, "p", "bob-muted bob-provenance", "Suggestions come from deterministic local rules over captured text. Unknown project details remain unknown; progress is self-reported, not independently verified.");

  ui.intentLedger = append(ui.dashboard, "section", "bob-intent-ledger bob-card");
  ui.intentLedger.setAttribute("aria-labelledby", "bob-intent-ledger-title");
  var intentLedgerHeading = append(ui.intentLedger, "div", "bob-section-heading bob-intent-ledger-heading");
  var intentLedgerHeadingCopy = append(intentLedgerHeading, "div");
  append(intentLedgerHeadingCopy, "p", "bob-section-kicker", "Intent ledger");
  var intentLedgerTitle = append(intentLedgerHeadingCopy, "h2", "", "What we think you are building");
  intentLedgerTitle.id = "bob-intent-ledger-title";
  ui.intentLedgerStatus = append(intentLedgerHeading, "p", "bob-muted", "Local snapshot");
  ui.intentLedgerStatus.setAttribute("role", "status");
  var intentLedgerGrid = append(ui.intentLedger, "div", "bob-intent-ledger-grid");
  var currentIntentCard = append(intentLedgerGrid, "article", "bob-intent-current");
  append(currentIntentCard, "p", "bob-intent-label", "Current intent");
  ui.intentCurrent = append(currentIntentCard, "p", "bob-intent-current-value");
  ui.intentCurrent.setAttribute("aria-live", "polite");
  ui.intentSource = append(currentIntentCard, "p", "bob-intent-source");
  var scopeCard = append(intentLedgerGrid, "article", "bob-intent-metric");
  append(scopeCard, "p", "bob-intent-label", "Scope");
  ui.intentScope = append(scopeCard, "p", "bob-intent-metric-value");
  var confidenceCard = append(intentLedgerGrid, "article", "bob-intent-metric bob-intent-confidence");
  append(confidenceCard, "p", "bob-intent-label", "Confidence");
  ui.intentConfidence = append(confidenceCard, "p", "bob-intent-metric-value");
  ui.intentConfidenceMeter = append(confidenceCard, "span", "bob-intent-confidence-meter");
  ui.intentConfidenceFill = append(ui.intentConfidenceMeter, "span", "bob-intent-confidence-fill");
  var intentLedgerColumns = append(ui.intentLedger, "div", "bob-intent-ledger-columns");
  var changedIntent = append(intentLedgerColumns, "section", "bob-intent-list bob-intent-changed");
  append(changedIntent, "h3", "", "Replaced or changed");
  ui.intentChangedList = append(changedIntent, "ul");
  var uncertainIntent = append(intentLedgerColumns, "section", "bob-intent-list bob-intent-uncertain");
  append(uncertainIntent, "h3", "", "Uncertain");
  ui.intentUncertainList = append(uncertainIntent, "ul");
  ui.intentClarification = append(ui.intentLedger, "aside", "bob-intent-clarification");
  ui.intentClarification.setAttribute("role", "note");
  append(ui.intentClarification, "span", "bob-intent-clarification-mark", "?");
  var clarificationCopy = append(ui.intentClarification, "div");
  append(clarificationCopy, "p", "bob-intent-label", "Clarification cue");
  ui.intentClarificationText = append(clarificationCopy, "p", "bob-intent-clarification-text");

  ui.brief = append(ui.dashboard, "section", "bob-brief bob-card");
  var briefHeading = append(ui.brief, "div", "bob-brief-heading");
  var briefHeadingCopy = append(briefHeading, "div");
  append(briefHeadingCopy, "p", "bob-section-kicker", "Project brief");
  ui.briefTitle = append(briefHeadingCopy, "h2", "", "Untitled local project");
  ui.briefDescription = append(ui.brief, "p", "bob-muted");
  ui.briefStatus = append(briefHeading, "span", "bob-project-status", "Local notebook");
  ui.briefGrid = append(ui.brief, "div", "bob-brief-grid");
  append(ui.brief, "p", "bob-muted bob-unknown-note", "Blank or unknown fields are intentional. Add confirmed details in Project memory & progress below.");
  append(ui.brief, "p", "bob-section-kicker bob-milestone-kicker", "Initial milestones");
  ui.milestones = append(ui.brief, "div", "bob-milestones");

  ui.security = append(ui.dashboard, "section", "bob-security bob-card");
  var securityHeading = append(ui.security, "div", "bob-section-heading");
  append(securityHeading, "h2", "", "Security & readiness");
  ui.securityNotice = append(securityHeading, "p", "bob-muted", "Signals are local hints, not a security audit.");
  ui.securitySummary = append(ui.security, "p", "bob-security-summary");
  ui.securityList = append(ui.security, "div", "bob-security-grid");
  ui.securityReadiness = append(ui.security, "p", "bob-muted bob-security-footnote");

  ui.flow = append(ui.dashboard, "section", "bob-flow bob-card");
  var flowHeading = append(ui.flow, "div", "bob-section-heading");
  var flowHeadingCopy = append(flowHeading, "div");
  append(flowHeadingCopy, "p", "bob-section-kicker", "Evidence map");
  append(flowHeadingCopy, "h2", "", "Security flow");
  ui.flowStatus = append(flowHeading, "p", "bob-muted", "Animated review path");
  append(ui.flow, "p", "bob-flow-intro", "Bob follows the project story from intent to implementation to verification. Red nodes are review signals, not proof of an exploitable vulnerability.");
  ui.flowTrack = append(ui.flow, "div", "bob-flow-track");
  ui.flowDetail = append(ui.flow, "div", "bob-flow-detail");
  ui.flowDetail.setAttribute("role", "status");
  var flowActions = append(ui.flow, "div", "bob-actions bob-flow-actions");
  ui.flowReplay = button(flowActions, "Replay flow", function () {
    ui.flowTrack.classList.toggle("is-replaying", false);
    void ui.flowTrack.offsetWidth;
    ui.flowTrack.classList.toggle("is-replaying", true);
  }, "bob-secondary");
  ui.flowLesson = button(flowActions, "Open security lesson", function () {
    if (state.mentor) {
      state.mentor.draft = "Teach me the highest-priority security concern in this project and how to verify the fix.";
      setView("mentor");
      renderMentor();
    }
  }, "bob-primary");

  ui.question = append(ui.dashboard, "section", "bob-question bob-card");
  append(ui.question, "p", "bob-section-kicker", "Local rules quick answer");
  append(ui.question, "h2", "", "A private notebook question");
  append(ui.question, "p", "bob-muted", "This existing local-rules composer never writes to ChatGPT, never uses cloud AI, and is not saved to local memory. Use Mentor chat for bounded local history or optional cloud AI.");
  var questionForm = append(ui.question, "form", "bob-question-form");
  var questionLabel = append(questionForm, "label", "bob-sr-label", "Ask Bob about this local project");
  ui.questionInput = append(questionLabel, "textarea", "bob-question-input");
  ui.questionInput.rows = 2;
  ui.questionInput.maxLength = (core && core.MAX_TURN_LENGTH) || 1800;
  ui.questionInput.placeholder = "Ask Bob about your project…";
  ui.questionInput.setAttribute("aria-label", "Ask Bob about this local project");
  ui.questionInput.addEventListener("input", function () { if (!checkUrl()) state.questionDraft = ui.questionInput.value; });
  var questionActions = append(questionForm, "div", "bob-question-actions");
  ui.ask = button(questionActions, "Ask Bob", askBob, "bob-primary");
  ui.ask.type = "submit";
  ui.questionAnswer = append(ui.question, "p", "bob-question-answer");
  ui.questionAnswer.setAttribute("role", "status");
  questionForm.addEventListener("submit", function (event) { event.preventDefault(); askBob(); });

  ui.editor = append(ui.dashboard, "details", "bob-editor bob-card");
  append(ui.editor, "summary", "", "Project memory & progress");
  append(ui.editor, "p", "bob-muted", "Edit the structured notebook. Empty unconfirmed fields mean unknown; clearing and saving a field intentionally keeps it blank. Only edited fields are saved; streaming never replaces your unsaved input. Saved corrections stay authoritative even when later chat messages differ—review the suggestions below each field.");
  var form = append(ui.editor, "form");
  ((core && core.PROJECT_FIELDS) || []).forEach(function (field) {
    var label = append(form, "label", "bob-field");
    append(label, "span", "", field.label);
    var input = append(label, "textarea");
    input.name = field.key;
    input.rows = field.key === "projectName" ? 1 : 2;
    input.maxLength = (core && core.MAX_TURN_LENGTH) || 1800;
    input.placeholder = "Unknown — add a confirmed detail";
    input.addEventListener("input", function () { if (checkUrl()) return; state.dirty.add(field.key); render(); });
    fields[field.key] = input;
    fieldSources[field.key] = append(label, "small", "bob-field-source");
  });
  var editorActions = append(form, "div", "bob-actions");
  ui.save = button(editorActions, "Save edited fields", saveEdits, "bob-primary");
  ui.discard = button(editorActions, "Discard unsaved edits", function () { state.dirty.clear(); syncFields(); render(); });
  ui.editStatus = append(form, "p", "bob-muted");
  form.addEventListener("submit", function (event) { event.preventDefault(); saveEdits(); });

  ui.markdownSection = append(ui.dashboard, "details", "bob-markdown bob-card");
  append(ui.markdownSection, "summary", "", "Local notebook snapshot");
  append(ui.markdownSection, "p", "bob-muted", "Includes saved project details and captured text. Downloaded files may contain sensitive conversation content.");
  ui.export = button(ui.markdownSection, "Download Markdown", exportMemory);
  ui.markdown = append(ui.markdownSection, "pre");

  ui.mentor = append(main, "section", "bob-mentor");
  ui.mentor.id = "bob-view-mentor";
  var mentorWelcome = append(ui.mentor, "div", "bob-mentor-welcome");
  ui.orb = append(mentorWelcome, "div", "bob-orb");
  ui.orb.setAttribute("role", "img");
  ui.orb.setAttribute("aria-label", "Bob is idle");
  var face = append(ui.orb, "span", "bob-face");
  face.setAttribute("aria-hidden", "true");
  append(face, "i", "bob-eye bob-eye-left");
  append(face, "i", "bob-eye bob-eye-right");
  append(face, "i", "bob-mouth");
  var mentorIntro = append(mentorWelcome, "div");
  append(mentorIntro, "p", "bob-section-kicker", "A little clarity, one step at a time");
  append(mentorIntro, "h2", "", "Let’s work through it.");
  ui.mentorStatus = append(mentorIntro, "p", "bob-muted");
  ui.mentorStatus.setAttribute("role", "status");
  var modeBox = append(ui.mentor, "fieldset", "bob-mode-box bob-card");
  append(modeBox, "legend", "", "Choose Bob’s mode");
  ui.modes = {};
  [["local", "Local rules", "Deterministic hints on this device"], ["cloud", "Cloud AI", "Bob backend → OpenRouter · Nemotron"]].forEach(function (item) {
    var label = append(modeBox, "label", "bob-mode-option");
    var radio = append(label, "input");
    radio.type = "radio";
    radio.name = "bob-mentor-mode";
    radio.value = item[0];
    var copy = append(label, "span");
    append(copy, "strong", "", item[1]);
    append(copy, "small", "", item[2]);
    radio.addEventListener("change", function () { chooseMentorMode(item[0]); });
    ui.modes[item[0]] = radio;
  });
  ui.cloudPanel = append(ui.mentor, "section", "bob-cloud-consent bob-card");
  append(ui.cloudPanel, "h3", "", "Optional cloud permission · separate from capture");
  ui.cloudDestination = append(ui.cloudPanel, "p", "bob-muted");
  var cloudTerms = append(ui.cloudPanel, "details", "bob-terms");
  cloudTerms.open = true;
  append(cloudTerms, "summary", "", "Before enabling cloud AI");
  var cloudList = append(cloudTerms, "ul");
  [
    "On Send, your question, approved conversation context and saved project memory are sent to the configured Bob backend, which can send them to OpenRouter in Nemotron mode. Check that backend’s configuration and provider policies. Bob chat history is stored locally, separate from captured messages; it is not written into ChatGPT.",
    "Cloud AI is optional. Free tokens do not make data local or private. Provider processing and retention may apply. Avoid sending secrets or sensitive material.",
    "Model output is untrusted, review-only suggestions. It can be wrong, unsafe, or incomplete. Bob provides no guarantee of security and does not automatically change project memory or run model instructions.",
    "Uncheck permission or switch to Local rules to disable cloud and cancel a pending request. Conversation pause, navigation, reload or backend changes also require fresh cloud permission. Revoking stops future requests but cannot recall data already sent."
  ].forEach(function (text) { append(cloudList, "li", "", text); });
  var cloudLabel = append(ui.cloudPanel, "label", "bob-checkbox");
  ui.cloudCheckbox = append(cloudLabel, "input");
  ui.cloudCheckbox.type = "checkbox";
  append(cloudLabel, "span", "", "I agree to these cloud terms and allow this approved conversation context, project memory and my question to be sent to the configured Bob backend / OpenRouter Nemotron mode. I understand that free tokens are not local/private, output is untrusted, and security is not guaranteed. I can revoke by unchecking.");
  ui.cloudCheckbox.addEventListener("change", changeCloudConsent);
  button(ui.cloudPanel, "Configure backend", function () { setView("settings"); });
  ui.mentorError = append(ui.mentor, "p", "bob-error");
  ui.mentorError.setAttribute("role", "alert");
  ui.mentorLog = append(ui.mentor, "div", "bob-mentor-log");
  ui.mentorLog.setAttribute("role", "log");
  ui.mentorLog.setAttribute("aria-label", "Bob conversation history, stored locally");
  ui.mentorLog.setAttribute("aria-live", "polite");
  ui.mentorLog.setAttribute("aria-relevant", "additions");
  ui.mentorEmpty = append(ui.mentor, "p", "bob-mentor-empty", "Ask about the next step, an unclear requirement, or a security concern. Bob’s advice stays review-only.");
  var mentorForm = append(ui.mentor, "form", "bob-mentor-composer bob-card");
  var mentorLabel = append(mentorForm, "label", "bob-composer-label", "Message Bob");
  ui.mentorInput = append(mentorLabel, "textarea", "bob-question-input");
  ui.mentorInput.rows = 3;
  ui.mentorInput.maxLength = (core && core.MAX_TURN_LENGTH) || 1800;
  ui.mentorInput.placeholder = "What should we figure out next?";
  ui.mentorInput.addEventListener("input", function () {
    if (checkUrl() || !state.mentor) return;
    state.mentor.draft = ui.mentorInput.value;
    state.mentor.orb = state.mentor.busy ? "thinking" : "listening";
    renderMentor();
  });
  ui.mentorInput.addEventListener("focus", function () { if (state.mentor && !state.mentor.busy) { state.mentor.orb = "listening"; renderMentor(); } });
  ui.mentorInput.addEventListener("blur", function () { if (state.mentor && !state.mentor.busy && state.mentor.orb === "listening") { state.mentor.orb = "idle"; renderMentor(); } persistMentor(); });
  ui.mentorInput.addEventListener("keydown", function (event) {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendMentor(); }
  });
  var mentorActions = append(mentorForm, "div", "bob-mentor-actions");
  append(mentorActions, "small", "bob-muted", "Enter to send · Shift+Enter for newline");
  ui.mentorSend = button(mentorActions, "Send to Bob", sendMentor, "bob-primary");
  ui.mentorSend.type = "button";
  mentorForm.addEventListener("submit", function (event) { event.preventDefault(); sendMentor(); });
  append(ui.mentor, "p", "bob-muted", "Up to 20 exchanges are saved in this browser profile, separately from project memory. Bob never writes to ChatGPT. Review suggestions before manually editing confirmed project details on the Dashboard.");

  ui.settings = append(main, "section", "bob-settings bob-card");
  ui.settings.id = "bob-view-settings";
  append(ui.settings, "p", "bob-section-kicker", "Optional cloud AI");
  append(ui.settings, "h2", "", "Bob backend");
  append(ui.settings, "p", "bob-muted", "Run the Bob backend locally, then enable Cloud AI and its separate consent in Mentor chat. The backend manages OpenRouter / Nemotron credentials. Never enter an API key here; Bob stores only the backend URL.");
  var backendLabel = append(ui.settings, "label", "bob-field");
  append(backendLabel, "span", "", "Backend URL");
  ui.backendInput = append(backendLabel, "input", "bob-backend-input");
  ui.backendInput.type = "url";
  ui.backendInput.value = DEFAULT_BACKEND;
  ui.backendInput.maxLength = 512;
  ui.backendInput.autocomplete = "off";
  ui.backendInput.spellcheck = false;
  append(ui.settings, "p", "bob-muted", "Allowed: http://127.0.0.1 or http://localhost, with an optional port and base path. Credentials, query strings, fragments, other hosts and protocols are rejected. Changing settings revokes cloud permission.");
  var settingsActions = append(ui.settings, "div", "bob-actions");
  ui.saveBackend = button(settingsActions, "Save backend", saveBackend);
  ui.testBackend = button(settingsActions, "Test connection", testBackend);
  ui.settingsStatus = append(ui.settings, "p", "bob-settings-status");
  ui.settingsStatus.setAttribute("role", "status");
  append(ui.settings, "p", "bob-muted", "Test connection calls GET /health on the saved backend, with no conversation context. A healthy backend does not verify model output or guarantee security. Cross-origin requests require the extension’s localhost host permissions and the backend’s CORS support.");
  append(main, "p", "bob-footer", "Capture depends on ChatGPT's rendered page structure and may miss unloaded or unsupported messages. No complete-history guarantee. Closed shadow DOM limits casual page access; it is not encryption or protection from privileged extensions. Bob v" + extensionVersion() + ".");
  var launcher = button(shell, "Bob", function () { setOpen(!state.open); }, "bob-launcher");
  launcher.setAttribute("aria-controls", "bob-panel");
  launcher.setAttribute("aria-expanded", "false");
  (document.body || document.documentElement).appendChild(host);
  function setOpen(open) {
    checkUrl();
    state.open = open;
    panel.hidden = !open;
    launcher.setAttribute("aria-expanded", String(open));
    if (open) close.focus();
    else launcher.focus();
    render();
  }
  shadow.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && state.open) { event.stopPropagation(); setOpen(false); }
  });
  function show(node, visible) { node.hidden = !visible; }
  function displayValue(value) {
    if (Array.isArray(value)) return value.length ? value.join("\n") : "Unknown";
    return typeof value === "string" && value.trim() ? value : "Unknown";
  }
  function securityText(value) {
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(securityText).filter(function (item) { return item !== "Unknown"; }).join(" · ") || "Unknown";
    if (value && typeof value === "object") {
      return securityText(value.summary || value.message || value.detail || value.text || value.value || value.status || "Unknown");
    }
    return "Unknown";
  }
  function securityEntries(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.map(function (item, index) {
      if (item && typeof item === "object") {
        return { label: item.label || item.name || item.key || "Signal " + (index + 1), value: securityText(item.value || item.detail || item.message || item.status || item) };
      }
      return { label: "Local signal " + (index + 1), value: securityText(item) };
    });
    if (value.checks || value.signals) return securityEntries(value.checks || value.signals);
    if (typeof value === "object") return Object.keys(value).map(function (key) {
      return { label: key.replace(/([A-Z])/g, " $1").replace(/^./, function (letter) { return letter.toUpperCase(); }), value: securityText(value[key]) };
    });
    return [{ label: "Local signal", value: securityText(value) }];
  }
  function intentHasValue(value) {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === "object") return Object.keys(value).length > 0;
    return value !== null && value !== undefined && String(value).trim() !== "";
  }
  function intentText(value) {
    if (value === null || value === undefined) return "";
    if (typeof value === "string") return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(intentText).filter(Boolean).join(" · ");
    if (typeof value === "object") {
      var preferred = ["text", "value", "summary", "detail", "message", "label", "goal", "objective", "whatIsBeingBuilt"];
      for (var index = 0; index < preferred.length; index += 1) {
        if (intentHasValue(value[preferred[index]])) return intentText(value[preferred[index]]);
      }
    }
    return "";
  }
  function firstIntentValue(values) {
    for (var index = 0; index < values.length; index += 1) {
      if (intentHasValue(values[index])) return values[index];
    }
    return null;
  }
  function intentApiSnapshot(memory) {
    if (!memory) return {};
    if (memory.intentLedger && typeof memory.intentLedger === "object") return memory.intentLedger;
    if (!core) return {};
    var methods = ["intentLedgerFromMemory", "deriveIntentLedger", "getIntentLedger", "extractIntentLedger"];
    for (var index = 0; index < methods.length; index += 1) {
      var method = core[methods[index]];
      if (typeof method !== "function") continue;
      try {
        var result = method(memory);
        if (result && typeof result === "object") return result.ledger || result;
      } catch (error) { /* Intent APIs are optional; use the existing memory shape below. */ }
    }
    if (typeof core.intentLedgerFromMessages === "function") {
      try {
        var derived = core.intentLedgerFromMessages(memory.messages || [], null, memory.updatedAt || timestamp());
        if (derived && typeof derived === "object") return derived;
      } catch (error) { /* The bundled core may predate the intent ledger API. */ }
    }
    return {};
  }
  function intentScopeLabel(value) {
    var text = intentText(value);
    if (text === "demo") return "Demo / prototype";
    if (text === "production") return "Production";
    if (text === "unspecified") return "Unspecified";
    return text;
  }
  function intentLedgerStatusItems(items, status) {
    return (Array.isArray(items) ? items : []).filter(function (item) {
      return item && item.status === status && intentText(item.text);
    }).slice(-4).map(function (item) {
      var meta = [
        item.scope && item.scope !== "unspecified" ? "Scope: " + intentScopeLabel(item.scope) : "",
        item.confidence ? "Confidence: " + intentConfidenceText(item.confidence) : "",
        status === "replaced" ? (item.reason ? intentText(item.reason) : "Superseded by a later user statement") : ""
      ].filter(Boolean).join(" · ");
      return { text: intentText(item.text), meta: meta };
    });
  }
  function intentConfidenceText(value) {
    if (value && typeof value === "object") {
      value = firstIntentValue([value.label, value.name, value.value, value.score, value.confidence]);
    }
    if (typeof value === "number" && isFinite(value)) {
      var number = value <= 1 ? value * 100 : value;
      return Math.round(Math.max(0, Math.min(100, number))) + "%";
    }
    return intentText(value);
  }
  function intentConfidencePercent(value) {
    if (value && typeof value === "object") value = firstIntentValue([value.score, value.confidence, value.value]);
    if (typeof value === "number" && isFinite(value)) return value <= 1 ? value * 100 : value;
    if (typeof value === "string") {
      var match = value.match(/(\d+(?:\.\d+)?)\s*%/);
      if (match) return Number(match[1]);
    }
    return null;
  }
  function intentItems(value, kind) {
    if (!intentHasValue(value)) return [];
    var values = Array.isArray(value) ? value : [value];
    return values.map(function (item) {
      if (!item || typeof item !== "object") return { text: intentText(item), meta: "" };
      var text = intentText(firstIntentValue([item.change, item.item, item.text, item.title, item.question, item.reason, item.detail, item.value]));
      var meta = kind === "changed"
        ? [intentText(item.impact) ? "Impact: " + intentText(item.impact) : "", intentConfidenceText(item.confidence) ? "Confidence: " + intentConfidenceText(item.confidence) : ""].filter(Boolean).join(" · ")
        : intentText(firstIntentValue([item.reason, item.detail, item.impact]));
      return { text: text || intentText(item), meta: meta };
    }).filter(function (item) { return !!item.text; }).slice(0, 4);
  }
  function intentClarificationText(value) {
    var text = intentText(value);
    if (!text || /^(?:no explicit user question detected|not provided|unknown)\.?$/i.test(text)) return "";
    return text.replace(/^Most recent user question \(possibly already answered\):\s*/i, "");
  }
  function intentLedgerSnapshot(memory) {
    var project = memory && memory.project || {};
    var guidance = memory && memory.guidance || {};
    if ((!guidance || !guidance.currentGoal) && core && typeof core.deriveGuidance === "function") {
      try { guidance = core.deriveGuidance(memory.messages || [], memory.suggestions && memory.suggestions.objective); } catch (error) { /* Keep the bounded memory fallback. */ }
    }
    var api = intentApiSnapshot(memory);
    var ledgerItems = Array.isArray(api.items) ? api.items : [];
    var currentLedgerItem = ledgerItems.slice().reverse().find(function (item) {
      return item && item.status === "current" && item.type === "goal";
    }) || ledgerItems.slice().reverse().find(function (item) { return item && item.status === "current"; });
    var response = state.mentor && state.mentor.response || responseFromHistory();
    var understanding = response && response.projectUnderstanding || {};
    var confirmed = !!(memory && memory.overrides && Object.prototype.hasOwnProperty.call(memory.overrides, "objective"));
    var current = intentText(firstIntentValue([
      api.currentIntent, api.current, api.intent, api.goal, api.objective,
      memory && memory.intent && memory.intent.current, currentLedgerItem && currentLedgerItem.text,
      project.objective, guidance.currentGoal, understanding.whatIsBeingBuilt, project.description
    ]));
    var scope = intentScopeLabel(intentText(firstIntentValue([api.scope, api.intentScope, currentLedgerItem && currentLedgerItem.scope, project.scope, project.boundary])));
    if (!scope || scope === "Unspecified") {
      scope = "";
      var scopeParts = [];
      if (intentHasValue(project.audience)) scopeParts.push("Audience: " + intentText(project.audience));
      if (intentHasValue(project.currentStage)) scopeParts.push("Stage: " + intentText(project.currentStage));
      if (intentHasValue(project.requirements)) scopeParts.push("Requirements: " + intentText(project.requirements));
      scope = scopeParts.join(" · ");
    }
    if (!scope) scope = "One approved conversation · local memory";
    var rawConfidence = firstIntentValue([api.confidence, api.intentConfidence, currentLedgerItem && currentLedgerItem.confidence, project.confidence, project.intentConfidence, understanding.confidence]);
    var confidence = intentConfidenceText(rawConfidence);
    if (!confidence) confidence = confirmed ? "User-confirmed" : current ? "Suggested / unconfirmed" : "Unknown";
    var changed = intentLedgerStatusItems(ledgerItems, "replaced");
    if (!changed.length) changed = intentItems(firstIntentValue([api.replacedItems, api.replaced, api.replacements, api.changedRequirements, response && response.changedRequirements]), "changed");
    if (!changed.length && confirmed && memory.suggestions && memory.suggestions.objective && memory.suggestions.objective !== memory.project.objective) {
      changed.push({ text: "Objective replaced by a saved correction", meta: "Saved by you · automatic suggestion retained for review" });
    }
    var uncertain = intentLedgerStatusItems(ledgerItems, "uncertain");
    if (!uncertain.length) uncertain = intentItems(firstIntentValue([api.uncertainItems, api.uncertain, api.uncertainties, api.uncertainty, response && response.uncertainty]), "uncertain");
    var clarification = intentClarificationText(firstIntentValue([
      api.clarificationCue, api.clarification, api.openQuestions,
      guidance.clarificationCue, response && response.openQuestions, guidance.openQuestions
    ]));
    return {
      current: current || "No current intent captured yet.",
      hasCurrent: !!current,
      scope: scope,
      confidence: confidence,
      confidencePercent: intentConfidencePercent(rawConfidence),
      source: intentText(firstIntentValue([api.source, api.provenance, guidance.source])) || (confirmed ? "Saved by you · not independently verified" : response ? "Optional mentor suggestion · review before relying on it" : "Deterministic local rules over bounded captured messages"),
      changed: changed,
      uncertain: uncertain,
      clarification: clarification
    };
  }
  function renderIntentItems(parent, items, emptyText) {
    parent.textContent = "";
    if (!items.length) {
      var empty = append(parent, "li", "bob-intent-empty", emptyText);
      empty.setAttribute("role", "status");
      return;
    }
    items.forEach(function (item) {
      var row = append(parent, "li", "bob-intent-item");
      append(row, "span", "bob-intent-item-mark", "•");
      var copy = append(row, "div");
      append(copy, "p", "bob-intent-item-text", item.text);
      if (item.meta) append(copy, "p", "bob-intent-item-meta", item.meta);
    });
  }
  function renderIntentLedger(memory) {
    var ledger = intentLedgerSnapshot(memory);
    ui.intentLedgerStatus.textContent = ledger.hasCurrent ? "Live local snapshot" : "Waiting for captured intent";
    ui.intentCurrent.textContent = ledger.current;
    ui.intentSource.textContent = ledger.source;
    ui.intentScope.textContent = ledger.scope;
    ui.intentConfidence.textContent = ledger.confidence;
    var percent = ledger.confidencePercent;
    show(ui.intentConfidenceMeter, percent !== null);
    ui.intentConfidenceMeter.classList.toggle("is-unknown", percent === null);
    ui.intentConfidenceFill.style.width = percent === null ? "0%" : Math.max(0, Math.min(100, percent)) + "%";
    renderIntentItems(ui.intentChangedList, ledger.changed, "No replaced items recorded yet.");
    renderIntentItems(ui.intentUncertainList, ledger.uncertain, "No explicit uncertainty recorded yet.");
    ui.intentClarificationText.textContent = ledger.clarification;
    show(ui.intentClarification, !!ledger.clarification);
  }
  function securitySnapshot(memory) {
    var memorySecurity = memory && memory.security;
    var checks = memorySecurity && (memorySecurity.checks || memorySecurity.signals) || null;
    var summary = memorySecurity && securityText(memorySecurity.summary);
    if (core && typeof core.securityChecksFromMemoryOrMessages === "function") {
      try {
        var rawChecks = core.securityChecksFromMemoryOrMessages.length > 1
          ? core.securityChecksFromMemoryOrMessages(memory.messages || [], memory)
          : core.securityChecksFromMemoryOrMessages(memory);
        if (rawChecks) {
          checks = rawChecks.checks || rawChecks.signals || rawChecks;
          if (!summary && rawChecks.summary) summary = securityText(rawChecks.summary);
        }
      } catch (error) { /* Optional local API; fixed signals remain visible. */ }
    }
    if (core && typeof core.securitySummary === "function") {
      try {
        var source = checks || memorySecurity || memory;
        var rawSummary = core.securitySummary.length > 1 ? core.securitySummary(source, memory) : core.securitySummary(source);
        if (rawSummary) summary = securityText(rawSummary);
      } catch (error) { /* Optional local API; fixed signals remain visible. */ }
    }
    var entries = [
      { label: "Capture scope", value: "One approved conversation only" },
      { label: "Storage", value: "chrome.storage.local on this browser profile" },
      { label: "Page access", value: "Rendered role markers only · no private APIs" },
      { label: "Network", value: state.mentor && state.mentor.mode === "cloud" && state.mentor.cloudConsent
        ? "Optional cloud backend enabled for explicitly consented mentor requests"
        : "No model or backend request from Dashboard; no telemetry" }
    ];
    securityEntries(checks).forEach(function (entry) { entries.push(entry); });
    return {
      summary: summary || "Local signals are available for this notebook. Review the source conversation and your environment yourself.",
      entries: entries,
      readiness: memory && memory.project && memory.project.deploymentReadiness
        ? "Deployment readiness is self-reported: " + memory.project.deploymentReadiness
        : "Deployment readiness: Unknown. Bob does not verify tests, security, or deployment."
    };
  }
  function briefItem(parent, label, value) {
    var item = append(parent, "div", "bob-brief-item");
    append(item, "span", "bob-brief-label", label);
    append(item, "p", "", displayValue(value));
  }
  function renderBrief(memory) {
    var project = memory && memory.project || {};
    var projectName = displayValue(project.projectName);
    ui.briefTitle.textContent = projectName === "Unknown" ? "Untitled local project" : projectName;
    ui.briefDescription.textContent = displayValue(project.description || project.objective || "No project description captured yet. First capture may still be settling.");
    ui.briefStatus.textContent = state.active && currentCapture() ? "Current local capture" : state.memory ? "Saved memory · capture not current" : "Notebook paused";
    ui.briefGrid.textContent = "";
    briefItem(ui.briefGrid, "Concept & scope", project.objective || project.description);
    briefItem(ui.briefGrid, "Stack & design", project.technologyStack || project.designPreferences);
    briefItem(ui.briefGrid, "Architecture", project.architecture || project.requirements);
    ui.milestones.textContent = "";
    [
      ["Phase 01", "Scope & foundation", project.requirements || project.objective, project.completedMilestones ? "Recorded" : "Review"],
      ["Phase 02", "Build the next step", project.features || project.pendingTasks || project.nextSteps, project.pendingTasks || project.nextSteps ? "Current" : "Unknown"],
      ["Phase 03", "Readiness review", project.knownIssues || project.deploymentReadiness, project.deploymentReadiness ? "Self-reported" : "Unknown"]
    ].forEach(function (milestone) {
      var card = append(ui.milestones, "div", "bob-milestone");
      append(card, "span", "bob-milestone-phase", milestone[0]);
      append(card, "strong", "", milestone[1]);
      append(card, "p", "", displayValue(milestone[2]));
      append(card, "small", "bob-milestone-status", milestone[3]);
    });
  }
  function flowChecks(memory) {
    if (!memory || !core || typeof core.securityChecksFromMemoryOrMessages !== "function") return [];
    try {
      var result = core.securityChecksFromMemoryOrMessages(memory.messages || [], memory.project || memory);
      return Array.isArray(result) ? result : (result && Array.isArray(result.checks) ? result.checks : []);
    } catch (error) { return []; }
  }
  function flowCheck(checks, ids) {
    var matched = checks.filter(function (check) { return check && ids.indexOf(check.id) !== -1; });
    if (matched.some(function (check) { return check.status === "needs-review"; })) return { status: "needs-review", check: matched.find(function (check) { return check.status === "needs-review"; }) };
    if (matched.some(function (check) { return check.status === "mentioned"; })) return { status: "mentioned", check: matched.find(function (check) { return check.status === "mentioned"; }) };
    return { status: "unknown", check: matched[0] || null };
  }
  function flowStatusLabel(status) {
    return { evidence: "Observed", mentioned: "Mentioned", "needs-review": "Needs review", unknown: "Not verified", self: "Self-reported" }[status] || "Not verified";
  }
  function renderSecurityFlow(memory) {
    var project = memory && memory.project || {};
    var checks = flowChecks(memory);
    var auth = flowCheck(checks, ["authentication-authorization", "cors-csrf-session"]);
    var input = flowCheck(checks, ["input-output"]);
    var data = flowCheck(checks, ["database-data-access", "secrets-env", "logging-pii"]);
    var nodes = [
      { title: "Project intent", icon: "◎", status: project.objective || project.description ? "evidence" : "unknown", detail: displayValue(project.objective || project.description) },
      { title: "Feature flow", icon: "↯", status: project.features || project.requirements ? "evidence" : "unknown", detail: displayValue(project.features || project.requirements) },
      { title: "Inputs", icon: "⌁", status: input.status, detail: input.check ? input.check.detail : "No local input-validation evidence was captured." },
      { title: "Auth boundary", icon: "◇", status: auth.status, detail: auth.check ? auth.check.detail : "No local authentication or authorization evidence was captured." },
      { title: "Data & secrets", icon: "▣", status: data.status, detail: data.check ? data.check.detail : "No local data-access or secret-handling evidence was captured." },
      { title: "Verification", icon: "✓", status: project.deploymentReadiness ? "self" : "unknown", detail: project.deploymentReadiness ? "Self-reported: " + project.deploymentReadiness : "Bob has not verified tests, runtime behavior, or deployment." }
    ];
    var risk = nodes.find(function (node) { return node.status === "needs-review"; });
    var mentioned = nodes.filter(function (node) { return node.status === "mentioned"; }).length;
    ui.flowStatus.textContent = risk ? "Risk signal at " + risk.title : mentioned ? mentioned + " topic(s) need a closer look" : "Evidence path ready for review";
    ui.flowTrack.textContent = "";
    nodes.forEach(function (node, index) {
      var item = append(ui.flowTrack, "div", "bob-flow-node is-" + node.status);
      item.tabIndex = 0;
      item.setAttribute("role", "button");
      item.setAttribute("aria-label", node.title + ": " + flowStatusLabel(node.status));
      append(item, "span", "bob-flow-icon", node.icon);
      append(item, "strong", "", node.title);
      append(item, "small", "bob-flow-state", flowStatusLabel(node.status));
      item.addEventListener("click", function () {
        ui.flowDetail.textContent = node.title + " — " + node.detail;
      });
      item.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); item.click(); }
      });
      if (index < nodes.length - 1) append(ui.flowTrack, "span", "bob-flow-connector", "→");
    });
    var initial = risk || nodes.find(function (node) { return node.status === "mentioned"; }) || nodes[0];
    ui.flowDetail.textContent = initial.title + " — " + initial.detail;
    ui.flowTrack.classList.toggle("is-replaying", false);
    void ui.flowTrack.offsetWidth;
    ui.flowTrack.classList.toggle("is-replaying", true);
  }
  function renderSecurity(memory) {
    var security = securitySnapshot(memory);
    ui.securitySummary.textContent = security.summary;
    ui.securityList.textContent = "";
    security.entries.forEach(function (entry) {
      var item = append(ui.securityList, "div", "bob-security-item");
      append(item, "strong", "", entry.label);
      append(item, "p", "", entry.value);
    });
    ui.securityReadiness.textContent = security.readiness;
    renderSecurityFlow(memory);
  }
  function mentorValue(value) {
    if (value === null || value === undefined || value === "") return "Not provided";
    if (typeof value === "string") return value.trim() || "Not provided";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(mentorValue).join("\n") || "Not provided";
    if (typeof value === "object") {
      return Object.keys(value).map(function (key) {
        var label = String(key).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        label = label ? label.charAt(0).toUpperCase() + label.slice(1) : "Detail";
        return label + ": " + mentorValue(value[key]);
      }).join("\n") || "Not provided";
    }
    return String(value);
  }
  function normalizeMentorResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value) || !("reply" in value)) return null;
    var response = { reply: mentorValue(value.reply) };
    MENTOR_FIELDS.forEach(function (field) { response[field[0]] = mentorValue(value[field[0]]); });
    return response;
  }
  function responseFromHistory() {
    if (!state.mentor || !Array.isArray(state.mentor.messages)) return null;
    for (var index = state.mentor.messages.length - 1; index >= 0; index -= 1) {
      var message = state.mentor.messages[index];
      if (message && message.role === "assistant" && message.structured) return normalizeMentorResponse(message.structured);
    }
    return null;
  }
  function addMentorMessage(role, content, structured) {
    if (!state.mentor) return;
    state.mentor.messages.push({
      role: role === "user" ? "user" : "assistant",
      content: mentorValue(content),
      structured: structured || null
    });
    if (state.mentor.messages.length > MENTOR_HISTORY_LIMIT) state.mentor.messages = state.mentor.messages.slice(-MENTOR_HISTORY_LIMIT);
    state.mentor.response = structured || (role === "assistant" ? null : state.mentor.response);
  }
  function appendResponse(parent, response) {
    if (!response) return;
    var card = append(parent, "div", "bob-response-card");
    var reply = append(card, "p", "bob-response-reply", response.reply);
    reply.setAttribute("aria-label", "Bob reply");
    var grid = append(card, "div", "bob-response-grid");
    MENTOR_FIELDS.forEach(function (field) {
      var item = append(grid, "div", "bob-response-item");
      append(item, "strong", "", field[1]);
      append(item, "p", "", response[field[0]]);
    });
    var review = append(card, "p", "bob-review-only", "Review-only suggestion · Nothing above changes project memory automatically.");
    review.setAttribute("role", "note");
  }
  function renderMentorHistory() {
    ui.mentorLog.textContent = "";
    var messages = state.mentor && state.mentor.messages || [];
    messages.forEach(function (message) {
      var entry = append(ui.mentorLog, "article", "bob-mentor-message " + (message.role === "user" ? "is-user" : "is-bob"));
      append(entry, "span", "bob-message-role", message.role === "user" ? "You" : "Bob");
      append(entry, "p", "bob-message-content", message.content);
      if (message.role !== "user" && message.structured) appendResponse(entry, normalizeMentorResponse(message.structured));
    });
    ui.mentorEmpty.hidden = messages.length > 0;
  }
  function orbLabel(orb) {
    return {
      idle: "Bob is idle",
      listening: "Bob is listening",
      thinking: "Bob is thinking",
      speaking: "Bob is speaking",
      concerned: "Bob is concerned"
    }[orb] || "Bob is idle";
  }
  function renderMentor() {
    if (!state.mentor) return;
    var mentor = state.mentor;
    ui.mentor.className = "bob-mentor mode-" + mentor.mode;
    ui.orb.className = "bob-orb is-" + (mentor.orb || "idle");
    ui.orb.setAttribute("aria-label", orbLabel(mentor.orb));
    ui.mentorStatus.textContent = mentor.status || (mentor.mode === "cloud"
      ? "Cloud AI is optional and requires explicit permission before any request."
      : "Local rules mode: no conversation context leaves this browser.");
    ui.mentorError.textContent = mentor.error || "";
    show(ui.mentorError, !!mentor.error);
    ui.mentorInput.value = mentor.draft || "";
    ui.mentorInput.disabled = mentor.busy;
    ui.mentorSend.disabled = mentor.busy || !String(mentor.draft || "").trim() || !state.active || !permitted(state.permission)
      || (mentor.mode === "cloud" && !cloudCaptureValid());
    ui.modes.local.checked = mentor.mode === "local";
    ui.modes.cloud.checked = mentor.mode === "cloud";
    ui.cloudPanel.hidden = mentor.mode !== "cloud";
    ui.cloudCheckbox.checked = mentor.cloudConsent === true;
    ui.cloudCheckbox.disabled = mentor.busy || !cloudCaptureValid();
    ui.cloudDestination.textContent = state.backendUrl
      ? "Configured destination: " + state.backendUrl + "/v1/mentor/respond"
      : "No valid backend is configured. Cloud requests are disabled.";
    renderMentorHistory();
    ui.unread.hidden = !mentor.unread;
    ui.mentor.classList.toggle("is-busy", mentor.busy);
  }
  function setView(view) {
    if (["dashboard", "mentor", "settings"].indexOf(view) === -1) view = "dashboard";
    state.view = view;
    if (state.mentor && view === "mentor") state.mentor.unread = false;
    render();
    if (view === "mentor" && ui.mentorInput && !ui.mentorInput.disabled) ui.mentorInput.focus();
  }
  function chooseMentorMode(mode) {
    if (!state.mentor) return;
    state.mentor.mode = mode === "cloud" ? "cloud" : "local";
    state.mentor.status = state.mentor.mode === "cloud"
      ? "Cloud mode selected. Review and check the separate cloud permission before sending."
      : "Local rules mode selected. No request will leave this browser.";
    state.mentor.error = "";
    state.mentor.orb = "idle";
    persistMentor();
    renderMentor();
  }
  function changeCloudConsent() {
    if (!state.mentor) return;
    if (ui.cloudCheckbox.checked && !cloudCaptureValid()) {
      ui.cloudCheckbox.checked = false;
      state.mentor.cloudConsent = false;
      state.mentor.error = "Cloud AI is disabled until a successful current capture includes at least one user message.";
      state.mentor.orb = "concerned";
      renderMentor();
      return;
    }
    state.mentor.cloudConsent = !!ui.cloudCheckbox.checked;
    state.mentor.status = state.mentor.cloudConsent
      ? "Cloud permission is on for this active conversation until you revoke it or the conversation changes."
      : "Cloud permission revoked. No cloud request can be sent until you check the terms again.";
    state.mentor.error = "";
    state.mentor.orb = "idle";
    persistMentor();
    renderMentor();
  }
  function clearMentorTimer(timer) { if (timer) clearTimeout(timer); }
  function mentorFailureMessage(error) {
    if (error && error.kind === "timeout") return "Bob’s backend timed out after 28 seconds. No retry was made; check the backend and try again.";
    if (error && error.kind === "http") {
      if (error.status >= 400 && error.status < 500) return "Bob’s backend rejected the request (HTTP " + error.status + "). Review the backend configuration and cloud permission.";
      return "Bob’s backend is unavailable (HTTP " + error.status + "). Check that it is running and try again.";
    }
    if (error && error.kind === "malformed") return "Bob’s backend returned an unreadable response. It must return JSON with a reply and structured review fields.";
    return "Bob’s backend could not be reached. Check the saved localhost URL, extension host permission, backend CORS, and that the service is running.";
  }
  function postMentorRequest(ticket, userMessage) {
    var backend = normalizeBackendUrl(state.backendUrl);
    if (!backend) return Promise.reject({ kind: "config" });
    var controller = new AbortController();
    state.mentorController = controller;
    var timedOut = false;
    var timeout = setTimeout(function () { timedOut = true; controller.abort(); }, MENTOR_TIMEOUT);
    var memory = state.memory;
    if (!memory) {
      clearMentorTimer(timeout);
      return Promise.reject({ kind: "cancelled" });
    }
    var payload = {
      conversationKey: state.key,
      messages: memory.messages,
      project: memory.project,
      userMessage: userMessage,
      cloudConsent: true
    };
    return Promise.resolve().then(function () { return fetch(backend + "/v1/mentor/respond", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    }); }).then(function (response) {
      if (!response.ok) throw { kind: "http", status: response.status };
      return response.json().catch(function () { throw { kind: "malformed" }; });
    }).then(function (body) {
      var response = normalizeMentorResponse(body);
      if (!response) throw { kind: "malformed" };
      return response;
    }).catch(function (error) {
      if (timedOut) throw { kind: "timeout" };
      if (error && error.name === "AbortError") throw { kind: "cancelled" };
      throw error;
    }).finally(function () {
      clearMentorTimer(timeout);
      if (state.mentorController === controller) state.mentorController = null;
    });
  }
  function localMentorAnswer(question) {
    try {
      var result = core && typeof core.answerLocalQuestion === "function"
        ? core.answerLocalQuestion(question, memoryForRules())
        : "No local rule is available. Switch to Cloud AI only after reviewing its separate consent.";
      return Promise.resolve(result).then(function (answer) {
        return normalizeMentorResponse({
          reply: typeof answer === "string" ? answer : securityText(answer),
          projectUnderstanding: "Based on deterministic local rules and the approved conversation memory.",
          uncertainty: "Local rules are limited and may not understand the full project.",
          verificationNeeded: "Review the source conversation and verify any action yourself."
        });
      });
    } catch (error) {
      return Promise.reject({ kind: "local", message: error && error.message });
    }
  }
  function sendMentor() {
    if (checkUrl() || !state.mentor) return;
    if (!state.memory || !state.active || !permitted(state.permission)) {
      state.mentor.error = "Approve and actively resume this conversation before asking Bob.";
      state.mentor.orb = "concerned";
      renderMentor();
      return;
    }
    if (state.mentor.mode === "cloud" && !cloudCaptureValid()) {
      state.mentor.error = state.lastCapture && state.lastCapture.userCount === 0
        ? "Bob needs at least one captured user message before sending context to cloud AI. Replies alone do not establish project intent."
        : "Capture is not current. Wait for a successful capture with a user message before sending context to cloud AI.";
      state.mentor.orb = "concerned";
      renderMentor();
      return;
    }
    if (state.mentor.busy) return;
    var question = String(state.mentor.draft || "").trim();
    if (!question) {
      state.mentor.status = "Write a message first. Nothing was sent or saved.";
      state.mentor.orb = "concerned";
      renderMentor();
      return;
    }
    if (state.mentor.mode === "cloud") {
      if (!state.mentor.cloudConsent) {
        state.mentor.error = "Cloud permission is required before any cloud request. Review and check the terms above, or choose Local rules mode.";
        state.mentor.orb = "concerned";
        renderMentor();
        return;
      }
      if (!normalizeBackendUrl(state.backendUrl)) {
        state.mentor.error = "Cloud is disabled because the backend URL is missing or invalid. Configure a localhost backend in Settings.";
        state.mentor.orb = "concerned";
        renderMentor();
        return;
      }
    }
    var ticket = token();
    var mode = state.mentor.mode;
    state.mentor.draft = "";
    state.mentor.busy = true;
    state.mentor.error = "";
    state.mentor.status = mode === "cloud" ? "Sending only with your explicit cloud permission…" : "Working from local rules only…";
    state.mentor.orb = "thinking";
    addMentorMessage("user", question);
    persistMentor();
    renderMentor();
    var result = mode === "cloud" ? postMentorRequest(ticket, question) : localMentorAnswer(question);
    Promise.resolve(result).then(function (response) {
      if (!valid(ticket) || !state.mentor) return;
      addMentorMessage("assistant", response.reply, response);
      state.mentor.response = response;
      state.mentor.status = mode === "cloud" ? "Bob replied from the configured backend. Review-only suggestions are shown below." : "Local rules answered without sending conversation data anywhere.";
      state.mentor.orb = "speaking";
      state.mentor.busy = false;
      state.mentor.unread = state.view !== "mentor" || !state.open;
      persistMentor();
      renderMentor();
      setTimeout(function () { if (state.mentor && !state.mentor.busy && state.mentor.orb === "speaking") { state.mentor.orb = "idle"; renderMentor(); } }, 1200);
    }).catch(function (error) {
      if (!valid(ticket) || !state.mentor) return;
      state.mentor.busy = false;
      if (error && error.kind === "cancelled") {
        state.mentor.status = "Cloud request stopped. No retry was made.";
        state.mentor.orb = "concerned";
      } else if (error && error.kind === "local") {
        state.mentor.error = "Bob’s local rules could not answer. " + (error.message || "Try another question.");
        state.mentor.orb = "concerned";
      } else if (error && error.kind === "config") {
        state.mentor.error = "Cloud is not configured. Open Settings and save an allowed localhost backend, or choose Local rules mode.";
        state.mentor.orb = "concerned";
      } else {
        state.mentor.error = mentorFailureMessage(error);
        state.mentor.orb = "concerned";
      }
      persistMentor();
      renderMentor();
    });
  }
  function saveBackend() {
    var candidate = normalizeBackendUrl(ui.backendInput.value);
    if (!candidate) {
      state.configError = "Invalid backend URL. Use only http://127.0.0.1 or http://localhost with an optional port/path.";
      state.settingsStatus = "Cloud remains disabled until a valid backend URL is saved.";
      render();
      return;
    }
    state.backendUrl = candidate;
    state.configError = "";
    state.settingsStatus = "Backend saved locally. Cloud permission was revoked; review it again in Mentor chat before sending.";
    if (state.mentor) {
      if (state.mentorController) {
        try { state.mentorController.abort(); } catch (error) { /* Request is being revoked. */ }
        state.mentorController = null;
      }
      state.mentor.busy = false;
      state.mentor.cloudConsent = false;
      state.mentor.status = "Backend changed. Review the separate cloud terms before sending.";
      state.mentor.orb = "concerned";
    }
    storage("set", (function () { var values = {}; values[CONFIG_KEY] = configRecord(); return values; }())).then(function () { render(); }).catch(function () {
      state.settingsStatus = "Backend could not be saved locally. Cloud remains disabled.";
      render();
    });
    persistMentor();
    render();
  }
  function testBackend() {
    var candidate = normalizeBackendUrl(ui.backendInput.value);
    if (!candidate) {
      state.settingsStatus = "Cannot test an invalid backend URL. Save an allowed localhost URL first.";
      render();
      return;
    }
    state.settingsTesting = true;
    state.settingsStatus = "Testing GET /health…";
    render();
    var controller = new AbortController();
    var timeout = setTimeout(function () { controller.abort(); }, 8000);
    fetch(candidate + "/health", { method: "GET", headers: { "Accept": "application/json" }, signal: controller.signal }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      state.settingsStatus = "Backend health check passed (HTTP " + response.status + "). No conversation data was sent.";
    }).catch(function (error) {
      state.settingsStatus = error && error.name === "AbortError"
        ? "Health check timed out. No conversation data was sent."
        : "Health check failed. Check that the backend is running, permits this extension origin, and exposes GET /health.";
    }).finally(function () {
      clearMentorTimer(timeout);
      state.settingsTesting = false;
      render();
    });
  }
  function askBob(event) {
    if (event && event.preventDefault) event.preventDefault();
    if (checkUrl() || !state.memory || !permitted(state.permission) || state.questionBusy) return;
    var question = String(ui.questionInput.value || state.questionDraft || "").trim();
    state.questionDraft = ui.questionInput.value;
    if (!question) {
      state.questionAnswer = "Write a question first. Nothing has been saved.";
      render();
      return;
    }
    var ticket = token();
    state.questionBusy = true;
    state.questionAnswer = "Working from this local notebook only…";
    render();
    var result;
    try {
      result = core && typeof core.answerLocalQuestion === "function"
         ? core.answerLocalQuestion(question, memoryForRules())
        : "No local rule is available. Your question was not sent anywhere or saved.";
    } catch (error) {
      result = "Bob could not answer locally: " + (error && error.message ? error.message : "the optional local rule failed") + ". Your question was not saved.";
    }
    Promise.resolve(result).then(function (answer) {
      if (!valid(ticket)) return;
      var text = typeof answer === "string" ? answer : securityText(answer);
      state.questionAnswer = text && text !== "Unknown"
        ? text
        : "No local answer is available. Your question was not sent anywhere or saved.";
      state.questionBusy = false;
      render();
    }).catch(function (error) {
      if (!valid(ticket)) return;
      state.questionBusy = false;
      state.questionAnswer = "Bob could not answer locally: " + (error && error.message ? error.message : "the optional local rule failed") + ". Your question was not saved.";
      render();
    });
  }
  function syncFields() {
    Object.keys(fields).forEach(function (key) {
      if (!state.dirty.has(key)) {
        var value = state.memory && state.memory.project && state.memory.project[key];
        fields[key].value = typeof value === "string" ? value : "";
      }
      var confirmed = !!(state.memory && state.memory.overrides && Object.prototype.hasOwnProperty.call(state.memory.overrides, key));
      var suggestion = state.memory && state.memory.suggestions && state.memory.suggestions[key];
      var saved = state.memory && state.memory.project && state.memory.project[key];
      fieldSources[key].textContent = confirmed
        ? "Saved by you · not independently verified" + (suggestion && suggestion !== saved ? ". Different automatic suggestion: " + suggestion : "")
        : saved ? "Automatic suggestion · review before relying on it" : "Not yet provided";
    });
  }
  function render() {
    var approved = permitted(state.permission);
    var hasMemory = !!state.memory;
    var retainedMessages = state.memory && Array.isArray(state.memory.messages) ? state.memory.messages.length : 0;
    var guidance = state.memory && state.memory.guidance || {};
    var liveCapture = currentCapture();
    var lastCapture = state.lastCapture || { status: "waiting", source: "", userCount: 0, assistantCount: 0, current: false, diagnostic: "" };
    launcher.textContent = state.mentor && state.mentor.unread ? "Bob · new reply" : (state.active ? "Bob · active" : "Bob · paused");
    ui.recent.textContent = state.key || "No conversation selected";
    ui.key.textContent = "Conversation: " + (state.key || "None — open a chatgpt.com/c/… conversation");
    ui.status.textContent = state.loading ? "Loading local memory — capture is off" : state.busy ? "Updating local storage…" : state.active
      ? lastCapture.status === "failed" ? "Active · capture failed; saved memory is stale"
        : lastCapture.status === "partial" ? "Active · partial capture — user messages missing"
          : lastCapture.status === "success" ? "Active · last capture: " + lastCapture.userCount + " user, " + lastCapture.assistantCount + " assistant"
            : "Active · waiting for a successful capture"
      : retainedMessages ? "Paused · saved memory is not a current capture" : "Paused · no conversation text is being read";
    ui.activeDetails.textContent = approved
      ? lastCapture.status === "partial" ? "Bob captured replies but could not read your messages. Project intent is unavailable."
        : lastCapture.status === "failed" ? "The latest capture failed. Saved memory is preserved but stale until a successful capture."
          : lastCapture.status === "success" ? "Current capture: " + lastCapture.userCount + " user message(s), " + lastCapture.assistantCount + " assistant message(s) · source: " + lastCapture.source + "."
            : retainedMessages ? "Saved memory is editable, but not current until a successful capture from this conversation."
              : "Bob is listening only to this approved conversation; no message text has been saved yet."
      : "No message text is being read. Approve this conversation to begin.";
    ui.error.textContent = state.error;
    show(ui.error, !!state.error);
    ui.warning.textContent = state.warning;
    show(ui.warning, !!state.warning);
    show(ui.consent, !approved);
    ui.allow.textContent = "Allow THIS CONVERSATION: " + (state.key || "unavailable");
    ui.allow.disabled = !state.key || !ui.checkbox.checked || state.busy || state.loading || !!state.error || !styleReady;
    show(ui.pause, state.active);
    show(ui.resume, approved && !state.active);
    ui.pause.disabled = state.busy;
    ui.resume.disabled = state.busy || state.loading || !!state.error || !styleReady;
    show(ui.reload, !!state.error);
    ui.reload.disabled = state.busy;
    ui.remove.disabled = !state.key || state.deleting;
    Object.keys(ui.views).forEach(function (view) {
      var selected = state.view === view;
      ui.views[view].classList.toggle("is-active", selected);
      ui.views[view].setAttribute("aria-current", selected ? "page" : "false");
    });
    show(ui.dashboard, state.view === "dashboard" && hasMemory);
    show(ui.dashboardEmpty, state.view === "dashboard" && !hasMemory);
    show(ui.editor, hasMemory && state.view === "dashboard");
    show(ui.markdownSection, hasMemory && state.view === "dashboard");
    show(ui.mentor, state.view === "mentor" && hasMemory);
    show(ui.settings, state.view === "settings");
    ui.workspaceTitle.textContent = state.view === "mentor" ? "Mentor chat" : state.view === "settings" ? "Settings" : "Dashboard";
    var cloudConfigured = !!normalizeBackendUrl(state.backendUrl) && !state.configError;
    var cloudConsented = !!(state.mentor && state.mentor.mode === "cloud" && state.mentor.cloudConsent);
    ui.disclosure.textContent = state.mentor && state.mentor.busy
      ? "Cloud AI · Bob is thinking"
      : cloudConsented ? "Cloud AI · consented for this conversation"
        : cloudConfigured ? "Cloud optional · consent required"
          : "Local rules · cloud unavailable";
    ui.privacyBadge.textContent = cloudConsented ? "Cloud consent on" : "Cloud off";
    ui.settingsStatus.textContent = state.configError || state.settingsStatus;
    ui.saveBackend.disabled = state.settingsTesting;
    ui.testBackend.disabled = state.settingsTesting;
    ui.counts.textContent = state.captures + " changed capture(s) saved in this activation · " + ((state.memory && state.memory.messages) || []).length + " retained message(s) · " + ((state.memory && state.memory.turns) || []).length + " retained observation(s) · last live capture: " + lastCapture.userCount + " user / " + lastCapture.assistantCount + " assistant (" + lastCapture.status + ", " + (lastCapture.source || "none") + ")";
    Object.keys(ui.guidance).forEach(function (key) { ui.guidance[key].textContent = displayValue(guidance[key]); });
    if (lastCapture.status === "partial") ui.guidanceBannerText.textContent = "Bob captured replies but could not read your messages. Project intent is unavailable.";
    else if (!liveCapture) ui.guidanceBannerText.textContent = lastCapture.status === "failed"
      ? "Saved project memory is stale because the latest capture failed. Resume and wait for a successful user-message capture."
      : "No current goal captured yet. Approve and wait for a successful user-message capture.";
    else ui.guidanceBannerText.textContent = displayValue(guidance.currentGoal || "No goal captured yet. The current user messages did not state one.");
    if (!liveCapture) ui.guidance.currentGoal.textContent = "No current goal — waiting for a successful user-message capture.";
    ui.save.disabled = !hasMemory || !approved || !state.dirty.size || state.busy || state.loading || !!state.error;
    ui.discard.disabled = !state.dirty.size || state.busy;
    ui.editStatus.textContent = state.dirty.size ? state.dirty.size + " unsaved field(s)" : "All displayed edits saved locally";
    ui.export.disabled = !hasMemory;
    ui.questionInput.value = state.questionDraft;
    ui.ask.disabled = !hasMemory || state.questionBusy || !String(state.questionDraft || "").trim();
    ui.questionAnswer.textContent = state.questionAnswer;
    show(ui.questionAnswer, !!state.questionAnswer);
    if (hasMemory) {
      renderIntentLedger(state.memory);
      renderBrief(state.memory);
      renderSecurity(state.memory);
    }
    // Never reconstruct the form during captures, external updates, or pause.
    syncFields();
     ui.markdown.textContent = hasMemory && core ? core.markdownFromMemory(memoryForRules()) : "";
    if (state.mentor) renderMentor();
  }
  function messageNodes() {
    if (core && typeof core.candidateMessageNodes === "function") {
      var explicit = core.candidateMessageNodes(document);
      // When ChatGPT exposes no role metadata, use the visible conversation
      // roots for settling and navigation guards. This prevents a reused SPA
      // root from being attributed to a newly approved URL.
      return explicit.length || typeof core.conversationRoots !== "function"
        ? explicit
        : core.conversationRoots(document);
    }
    var nodes = [];
    Array.prototype.forEach.call(document.querySelectorAll('main, [role="main"]'), function (container) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-message-author-role="user"], [data-message-author-role="assistant"], [data-author-role="user"], [data-author-role="assistant"], [data-turn-role="user"], [data-turn-role="assistant"], [data-testid^="conversation-turn-"]'), function (node) {
        if (nodes.indexOf(node) === -1) nodes.push(node);
      });
    });
    return nodes.filter(function (node) {
      return !node.closest('nav, aside, [role="navigation"], [role="complementary"], #sidebar, [data-testid*="sidebar"], form, [contenteditable="true"], #bob-mentor-root');
    });
  }
  function checkUrl() {
    var url = window.location.href;
    if (url === state.url) return false;
    var wasNavigated = !!state.url;
    stop();
    // Node identity only, never text, before consent: SPA navigation can leave
    // previous conversation messages mounted after changing the URL.
    state.blockedNodes = wasNavigated ? messageNodes() : [];
    state.url = url;
    state.key = core && window.location.origin === "https://chatgpt.com" ? core.conversationKeyFromUrl(url) : null;
    state.memory = null;
    state.permission = null;
    state.mentor = newMentorState();
    state.view = "dashboard";
    state.dirty.clear();
    Object.keys(fields).forEach(function (key) { fields[key].value = ""; });
    ui.checkbox.checked = false;
    state.questionDraft = "";
    state.questionAnswer = "";
    state.questionBusy = false;
    state.captures = 0;
    state.lastFingerprint = "";
    resetLastCapture();
    state.error = environmentError();
    state.warning = wasNavigated ? "Navigation paused capture and cleared the previous conversation from this panel. Review or resume this conversation explicitly." : "";
    state.busy = false;
    state.deleting = false;
    state.settledAt = Date.now() + 1000;
    loadCurrent();
    return true;
  }
  function loadCurrent() {
    stop();
    resetLastCapture();
    state.busy = false;
    state.loading = !!state.key;
    state.error = environmentError();
    if (!state.key || state.error) { state.loading = false; render(); return; }
    var ticket = token();
    transaction(ticket.key, async function () {
      var record = await readRecord(ticket.key);
      var mentor;
      try { mentor = await readMentorRecord(ticket.key); } catch (error) { mentor = newMentorState(); }
      return { record: record, mentor: mentor };
    }).then(function (loaded) {
      if (!valid(ticket)) return;
      var record = loaded.record;
      state.permission = record.permission;
      state.memory = record.permission && !record.permission.granted ? null : record.memory;
      state.mentor = loaded.mentor;
      if (!permitted(record.permission)) state.mentor.cloudConsent = false;
      state.loading = false;
      state.error = environmentError();
      render();
    }).catch(function (error) { failure(error, ticket); });
    render();
  }
  function activate() {
    if (checkUrl() || !state.key || state.busy || state.loading || state.error || !styleReady) return;
    var accepted = ui.checkbox.checked;
    if (!permitted(state.permission) && !accepted) return;
    stop();
    resetLastCapture();
    state.busy = true;
    var ticket = token();
    var oldEpoch = state.permission && state.permission.epoch;
    transaction(ticket.key, async function () {
      if (!valid(ticket)) return null;
      var record = await readRecord(ticket.key);
      if (!valid(ticket)) return null;
      if ((record.permission && record.permission.epoch) !== oldEpoch || (!accepted && !permitted(record.permission))) throw new Error("Permission changed in another tab. Review consent again.");
      var permission = permitted(record.permission) ? record.permission : { granted: true, version: TERMS_VERSION, epoch: uniqueId(), grantedAt: timestamp() };
      state.permission = permission;
      if (!permitted(record.permission)) {
        var values = {};
        values[permissionKey(ticket.key)] = permission;
        await storage("set", values);
      }
      if (!valid(ticket)) return null;
      var memory = core.memoryFromObservation(record.memory, ticket.key, record.memory && record.memory.messages || [], timestamp());
      memory = Object.assign({}, memory, { consentGranted: true, termsVersion: TERMS_VERSION });
      memory = memoryForStorage(memory);
      return writeMemory(ticket.key, memory);
    }).then(function (memory) {
      if (!memory || !valid(ticket)) return;
      state.memory = memory;
      ui.checkbox.checked = false;
      state.busy = false;
      state.active = true;
      state.captures = 0;
      state.lastFingerprint = "";
      state.warning = "Waiting for settled conversation content. Only rendered message text can be captured.";
      state.settledAt = Math.max(state.settledAt, Date.now() + 800);
      state.observer = new MutationObserver(function (records) {
        if (checkUrl() || !state.active) return;
        if (records.some(function (record) { return record.target !== host && !host.contains(record.target); })) scheduleCapture();
      });
      state.observer.observe(document.body || document.documentElement, { childList: true, subtree: true, characterData: true });
      render();
      scheduleCapture();
    }).catch(function (error) { failure(error, ticket); });
    render();
  }
  function pause() {
    checkUrl();
    stop();
    state.busy = false;
    state.warning = "Capture paused. You can edit, export, or revoke and delete memory while paused.";
    render();
  }
  function scheduleCapture() {
    if (!state.active || state.timer) return;
    if (state.capturePending === state.generation) { state.captureAgain = true; return; }
    // Bounded throttle: streaming mutations do not postpone this timer.
    state.timer = setTimeout(function () { state.timer = null; capture(); }, 650);
  }
  function capture() {
    if (checkUrl() || !state.active || !permitted(state.permission)) return;
    var ticket = token();
    var epoch = state.permission.epoch;
    state.capturePending = ticket.generation;
    transaction(ticket.key, async function () {
      if (!valid(ticket) || !state.active) return null;
      var record = await readRecord(ticket.key);
      if (!valid(ticket) || !state.active) return null;
      if (!permitted(record.permission) || record.permission.epoch !== epoch) throw new Error("Consent was revoked or changed in another tab. Capture stopped.");
      var nodes = messageNodes();
      if (state.blockedNodes.some(function (node) { return node.isConnected && nodes.indexOf(node) !== -1; })) {
        state.warning = "Capture blocked: message elements from navigation are still present. Wait for the page to replace them, or reload this conversation and approve again. No text has been attributed to this URL.";
        render();
        return null;
      }
      state.blockedNodes = [];
      if (Date.now() < state.settledAt) { scheduleCapture(); return null; }
      if (!state.candidate || state.candidate.length !== nodes.length || state.candidate.some(function (node, index) { return node !== nodes[index]; })) {
        state.candidate = nodes;
        scheduleCapture();
        return null;
      }
      if (!valid(ticket) || !state.active) return null;
      var observation = core.extractConversation(document);
      if (!valid(ticket) || !state.active) return null;
      if (observation.status !== "ok") {
        setLastCapture("failed", observation, "Nothing captured: " + (observation.diagnostic || "Supported visible conversation messages were not found."));
        state.warning = "Capture failed. Saved memory is preserved but stale until a successful capture. Nothing captured: " + (observation.diagnostic || "Supported visible conversation messages were not found.");
        render();
        return { captured: false };
      }
      var counts = captureCounts(observation);
      var diagnostic = captureDiagnostic(observation, counts);
      var captureStatus = counts.userCount > 0 ? "success" : "partial";
      setLastCapture(captureStatus, observation, diagnostic);
      state.warning = captureStatus === "partial"
        ? "Partial capture — user messages missing. " + diagnostic
        : diagnostic;
      render();
      var fingerprint = JSON.stringify(observation.messages || []);
      if (fingerprint === state.lastFingerprint) return { captured: true, changed: false };
      var memory = core.memoryFromObservation(record.memory, ticket.key, observation.messages, timestamp());
      memory = Object.assign({}, memory, { consentGranted: true, termsVersion: TERMS_VERSION });
      memory = memoryForStorage(memory);
      var saved = await writeMemory(ticket.key, memory);
      if (!valid(ticket) || !state.active) return null;
      state.lastFingerprint = fingerprint;
      return { captured: true, changed: true, memory: saved };
    }).then(function (result) {
      if (!result || !result.captured || !valid(ticket) || !state.active) return;
      if (result.memory) {
        state.memory = result.memory;
        if (result.changed) state.captures += 1;
      }
      render();
    }).catch(function (error) { failure(error, ticket); }).finally(function () {
      if (!valid(ticket) || state.capturePending !== ticket.generation) return;
      state.capturePending = null;
      if (state.captureAgain) { state.captureAgain = false; scheduleCapture(); }
    });
  }
  function saveEdits() {
    if (checkUrl() || !state.memory || !state.dirty.size || state.busy || state.error || !permitted(state.permission)) return;
    var ticket = token();
    var epoch = state.permission.epoch;
    var edits = {};
    state.dirty.forEach(function (key) { edits[key] = fields[key].value; });
    state.busy = true;
    transaction(ticket.key, async function () {
      if (!valid(ticket)) return null;
      var record = await readRecord(ticket.key);
      if (!valid(ticket)) return null;
      if (!permitted(record.permission) || record.permission.epoch !== epoch || !record.memory) throw new Error("The memory or consent changed in another tab. Reload local memory before saving.");
       return writeMemory(ticket.key, memoryForStorage(core.applyProjectEdits(record.memory, edits, timestamp())));
    }).then(function (memory) {
      if (!memory || !valid(ticket)) return;
      state.memory = memory;
      state.busy = false;
      Object.keys(edits).forEach(function (key) { if (fields[key].value === edits[key]) state.dirty.delete(key); });
      render();
    }).catch(function (error) { failure(error, ticket); });
    render();
  }
  function revoke() {
    if (checkUrl() || !state.key || state.deleting) return;
    var key = state.key;
    if (!window.confirm("Revoke Bob's consent and delete local project memory for " + key + "? Unsaved edits will also be cleared. Exported files are not deleted.")) return;
    if (checkUrl() || state.key !== key) return;
    stop();
    state.memory = null;
    state.mentor = newMentorState();
    state.dirty.clear();
    ui.checkbox.checked = false;
    state.permission = { granted: false, version: TERMS_VERSION, epoch: uniqueId(), revokedAt: timestamp() };
    var permission = state.permission;
    state.busy = true;
    state.deleting = true;
    state.loading = false;
    var ticket = token();
    // Finish deleting this captured key even after navigation. All earlier
    // writes are ahead of this operation in the queue and cross-tab lock.
    transaction(key, async function () {
      var values = {};
      values[permissionKey(key)] = permission;
      await storage("set", values);
      state.ownRemovals.add(key);
      await storage("remove", [memoryKey(key), mentorKey(key)]);
    }).then(function () {
      if (!valid(ticket)) return;
      state.busy = false;
      state.deleting = false;
      state.error = "";
      state.warning = "Consent revoked and local memory deleted. Other Bob tabs are notified through browser storage. A minimal revocation record remains; exported files are unchanged.";
      render();
    }).catch(function (error) { failure(error, ticket); });
    render();
  }
  function exportMemory() {
    if (checkUrl() || !state.memory || state.memory.conversationKey !== state.key) return;
    try {
      var blob = new Blob([core.markdownFromMemory(memoryForRules())], { type: "text/markdown;charset=utf-8" });
      var url = URL.createObjectURL(blob);
      var link = append(shadow, "a");
      link.href = url;
      link.download = "bob-" + state.key.replace(/[^A-Za-z0-9_-]/g, "-") + ".md";
      link.click();
      link.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (error) { failure(error); }
  }
  if (window.chrome && chrome.storage && chrome.storage.onChanged && chrome.storage.onChanged.addListener) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== "local" || checkUrl() || !state.key) return;
      var permissionChange = changes[permissionKey(state.key)];
      var memoryChange = changes[memoryKey(state.key)];
      var mentorChange = changes[mentorKey(state.key)];
      var configChange = changes[CONFIG_KEY];
      if (configChange) {
        var configured = configChange.newValue ? normalizeBackendUrl(configChange.newValue.backendUrl) : DEFAULT_BACKEND;
        state.backendUrl = configured || "";
        state.configError = configured ? "" : "Saved backend URL is invalid. Cloud requests are disabled until it is replaced.";
        if (ui.backendInput && !ui.backendInput.matches(":focus")) ui.backendInput.value = configChange.newValue && typeof configChange.newValue.backendUrl === "string" ? configChange.newValue.backendUrl : DEFAULT_BACKEND;
        if (state.mentor) {
          state.mentor.cloudConsent = false;
          state.mentor.status = "Backend settings changed in another Bob tab. Review cloud terms again.";
        }
        render();
      }
      if (permissionChange) {
        var permission = permissionChange.newValue;
        if (!state.permission || !permission || permission.epoch !== state.permission.epoch) {
          stop();
          state.busy = false;
          state.loading = false;
          state.permission = permission || null;
          ui.checkbox.checked = false;
          state.warning = "Consent changed in another tab. Capture stopped; review or resume explicitly.";
          if (!permitted(permission)) { state.memory = null; state.mentor = newMentorState(); state.dirty.clear(); }
          render();
        }
      }
      if (mentorChange) {
        var mentorValueChange = mentorChange.newValue;
        if (mentorValueChange && state.ownMentorWrites.has(mentorValueChange.bobRevision)) return;
        if (!mentorValueChange && state.ownRemovals.has(state.key)) {
          state.ownRemovals.delete(state.key);
          return;
        }
        if (mentorValueChange && mentorValueChange.conversationKey === state.key) {
          state.mentor = normalizeMentorRecord(mentorValueChange, state.key);
          state.mentor.unread = state.view !== "mentor";
          state.mentor.status = "Bob chat history changed in another tab.";
          renderMentor();
        }
      }
      if (memoryChange) {
        var memory = memoryChange.newValue;
        if (memory && state.ownWrites.has(memory.bobRevision)) return;
        if (!memory && state.ownRemovals.has(state.key)) {
          state.ownRemovals.delete(state.key);
          if (!state.memory && !permitted(state.permission)) return;
        }
        stop();
        state.busy = false;
        state.loading = false;
        if (!memory) {
          state.memory = null;
          state.mentor = newMentorState();
          state.dirty.clear();
          state.warning = "Local memory was deleted in another tab. Capture stopped.";
          render();
        } else {
          state.warning = "Local memory changed in another tab. Capture paused. Unsaved fields are preserved; saving merges only your edited fields into the latest memory.";
          loadCurrent();
        }
      }
    });
  } else state.error = "Browser storage notifications are unavailable. Bob cannot safely activate.";
  window.addEventListener("popstate", checkUrl);
  window.addEventListener("hashchange", checkUrl);
  window.addEventListener("pagehide", function () { stop(); render(); });
  window.addEventListener("pageshow", function (event) { if (event.persisted) { checkUrl(); loadCurrent(); } });
  // URL polling reads location only, never page text, while paused.
  setInterval(checkUrl, 350);
  state.mentor = newMentorState();
  loadConfig();
  checkUrl();
  render();
}());
