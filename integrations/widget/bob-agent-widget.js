(function (global) {
  "use strict";

  var VERSION = "1.0.0";
  var MAX_MESSAGES = 40;
  var MAX_MESSAGE_LENGTH = 2000;
  var MAX_CONTEXT_DEPTH = 4;
  var SENSITIVE_KEY = /(secret|api[-_]?key|token|password|authorization|openrouter|credential)/i;

  var STYLES = [
    ":host { all: initial; }",
    ".bob-widget__launcher, .bob-widget__panel { box-sizing: border-box; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif; }",
    ".bob-widget__launcher { align-items: center; background: #172554; border: 0; border-radius: 999px; bottom: 20px; box-shadow: 0 12px 34px rgba(15, 23, 42, .24); color: #fff; cursor: pointer; display: flex; font-size: 15px; font-weight: 700; gap: 9px; min-height: 52px; padding: 0 18px; position: fixed; right: 20px; z-index: 2147483000; }",
    ".bob-widget__launcher:hover { background: #1e3a8a; }",
    ".bob-widget__launcher:focus-visible, .bob-widget__panel button:focus-visible, .bob-widget__panel textarea:focus-visible { outline: 3px solid #fbbf24; outline-offset: 2px; }",
    ".bob-widget__orb { align-items: center; background: #facc15; border-radius: 50%; color: #172554; display: inline-flex; font-size: 13px; height: 28px; justify-content: center; width: 28px; }",
    ".bob-widget__panel { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 18px; bottom: 84px; box-shadow: 0 22px 65px rgba(15, 23, 42, .28); color: #0f172a; display: flex; flex-direction: column; max-height: min(740px, calc(100vh - 110px)); overflow: hidden; position: fixed; right: 20px; width: min(410px, calc(100vw - 32px)); z-index: 2147483000; }",
    ".bob-widget__panel[hidden] { display: none; }",
    ".bob-widget__header { align-items: flex-start; background: #172554; color: #fff; display: flex; justify-content: space-between; padding: 17px 18px 15px; }",
    ".bob-widget__eyebrow { color: #bfdbfe; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }",
    ".bob-widget__title { font-size: 20px; line-height: 1.2; margin: 3px 0 0; }",
    ".bob-widget__subtitle { color: #dbeafe; font-size: 12px; margin: 5px 0 0; }",
    ".bob-widget__close { background: transparent; border: 0; color: #dbeafe; cursor: pointer; font-size: 24px; line-height: 1; padding: 0 0 4px 10px; }",
    ".bob-widget__body { min-height: 0; overflow-y: auto; padding: 14px; }",
    ".bob-widget__status { align-items: center; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; color: #1e3a8a; display: flex; font-size: 12px; gap: 8px; line-height: 1.35; margin-bottom: 12px; padding: 9px 10px; }",
    ".bob-widget__status[data-state=error] { background: #fff7ed; border-color: #fed7aa; color: #9a3412; }",
    ".bob-widget__status[data-state=ready] { background: #f0fdf4; border-color: #bbf7d0; color: #166534; }",
    ".bob-widget__status-dot { background: currentColor; border-radius: 50%; flex: 0 0 auto; height: 7px; width: 7px; }",
    ".bob-widget__section-label { color: #475569; font-size: 10px; font-weight: 800; letter-spacing: .1em; margin: 14px 0 7px; text-transform: uppercase; }",
    ".bob-widget__context { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; display: grid; gap: 8px; grid-template-columns: 1fr 1fr; padding: 11px; }",
    ".bob-widget__context-item { min-width: 0; }",
    ".bob-widget__context-key { color: #64748b; display: block; font-size: 10px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }",
    ".bob-widget__context-value { display: block; font-size: 12px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".bob-widget__messages { display: grid; gap: 7px; max-height: 160px; overflow-y: auto; }",
    ".bob-widget__message { border-radius: 10px; font-size: 12px; line-height: 1.45; padding: 8px 10px; white-space: pre-wrap; word-break: break-word; }",
    ".bob-widget__message[data-role=user] { background: #dbeafe; margin-left: 24px; }",
    ".bob-widget__message[data-role=assistant], .bob-widget__message[data-role=system] { background: #fff; border: 1px solid #e2e8f0; margin-right: 24px; }",
    ".bob-widget__message-role { color: #64748b; display: block; font-size: 10px; font-weight: 800; letter-spacing: .05em; margin-bottom: 3px; text-transform: uppercase; }",
    ".bob-widget__guidance { display: grid; gap: 8px; }",
    ".bob-widget__guidance-empty { background: #fff; border: 1px dashed #cbd5e1; border-radius: 10px; color: #64748b; font-size: 12px; line-height: 1.45; padding: 11px; }",
    ".bob-widget__untrusted { color: #92400e; font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; }",
    ".bob-widget__card { background: #fff; border: 1px solid #e2e8f0; border-left: 3px solid #60a5fa; border-radius: 10px; padding: 10px; }",
    ".bob-widget__card h4 { color: #1e3a8a; font-size: 12px; margin: 0 0 5px; }",
    ".bob-widget__card p, .bob-widget__card ul { font-size: 12px; line-height: 1.5; margin: 0; }",
    ".bob-widget__card ul { padding-left: 17px; }",
    ".bob-widget__card li + li { margin-top: 4px; }",
    ".bob-widget__composer { background: #f8fafc; border-top: 1px solid #e2e8f0; padding: 12px 14px 14px; }",
    ".bob-widget__input { background: #fff; border: 1px solid #cbd5e1; border-radius: 10px; box-sizing: border-box; color: #0f172a; display: block; font: inherit; font-size: 13px; min-height: 66px; padding: 9px 10px; resize: vertical; width: 100%; }",
    ".bob-widget__composer-row { align-items: center; display: flex; gap: 8px; justify-content: space-between; margin-top: 8px; }",
    ".bob-widget__hint { color: #64748b; font-size: 10px; line-height: 1.3; }",
    ".bob-widget__ask { background: #2563eb; border: 0; border-radius: 8px; color: #fff; cursor: pointer; font-size: 12px; font-weight: 800; padding: 9px 13px; }",
    ".bob-widget__ask:hover { background: #1d4ed8; }",
    ".bob-widget__ask:disabled { cursor: wait; opacity: .6; }",
    "@media (max-width: 520px) { .bob-widget__launcher { bottom: 14px; right: 14px; } .bob-widget__panel { bottom: 76px; right: 8px; width: calc(100vw - 16px); } }",
    "@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; } }"
  ].join("\n");

  function text(value, limit) {
    var result = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    return limit && result.length > limit ? result.slice(0, limit) : result;
  }

  function node(documentRef, tag, className, value) {
    var element = documentRef.createElement(tag);
    if (className) element.className = className;
    if (value != null) element.textContent = value;
    return element;
  }

  function safeClone(value, depth, key) {
    if (SENSITIVE_KEY.test(String(key || ""))) return "[redacted]";
    if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return typeof value === "string" ? value.slice(0, 2000) : value;
    }
    if (depth >= MAX_CONTEXT_DEPTH || typeof value === "function") return undefined;
    if (Array.isArray(value)) return value.slice(0, 40).map(function (item) { return safeClone(item, depth + 1); });
    if (typeof value === "object") {
      var result = {};
      Object.keys(value).slice(0, 60).forEach(function (property) {
        var item = safeClone(value[property], depth + 1, property);
        if (item !== undefined) result[property] = item;
      });
      return result;
    }
    return undefined;
  }

  function makeId() {
    return "bob-widget-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function normalizeMessage(message) {
    if (typeof message === "string") return { role: "user", text: text(message, MAX_MESSAGE_LENGTH) };
    if (!message || typeof message !== "object") return null;
    var value = text(message.text || message.content || message.message, MAX_MESSAGE_LENGTH);
    if (!value) return null;
    var role = text(message.role || "user", 30).toLowerCase();
    if (["user", "assistant", "system"].indexOf(role) === -1) role = "system";
    return { role: role, text: value };
  }

  function create(options) {
    options = options || {};
    var documentRef = options.document || (global && global.document);
    if (!documentRef || !documentRef.body || !documentRef.createElement) {
      throw new Error("BobAgentWidget requires a document with a body");
    }

    var mount = options.mount;
    if (typeof mount === "string") mount = documentRef.querySelector(mount);
    if (!mount || !mount.appendChild) mount = documentRef.body;

    var host = documentRef.createElement("div");
    host.setAttribute("data-bob-agent-widget", VERSION);
    var shadow = host.attachShadow({ mode: "closed" });
    shadow.appendChild(node(documentRef, "style", "", STYLES));

    var state = {
      context: safeClone(options.context || {}, 0) || {},
      messages: [],
      guidance: null,
      asking: false,
      destroyed: false,
      open: false,
      requestGuidance: typeof options.requestGuidance === "function" ? options.requestGuidance : null,
      conversationId: text(options.conversationId, 160) || makeId()
    };

    var initialMessages = Array.isArray(options.messages) ? options.messages : [];
    initialMessages.forEach(function (message) {
      var normalized = normalizeMessage(message);
      if (normalized) state.messages.push(normalized);
    });
    state.messages = state.messages.slice(-MAX_MESSAGES);

    var launcher = node(documentRef, "button", "bob-widget__launcher");
    launcher.type = "button";
    launcher.setAttribute("aria-label", "Open Bob mentor");
    launcher.appendChild(node(documentRef, "span", "bob-widget__orb", "B"));
    launcher.appendChild(node(documentRef, "span", "", "Ask Bob"));

    var panel = node(documentRef, "section", "bob-widget__panel");
    panel.hidden = true;
    panel.setAttribute("aria-label", "Bob mentor");
    var header = node(documentRef, "header", "bob-widget__header");
    var headerCopy = node(documentRef, "div");
    headerCopy.appendChild(node(documentRef, "div", "bob-widget__eyebrow", "Untrusted mentor guidance"));
    headerCopy.appendChild(node(documentRef, "h2", "bob-widget__title", text(options.title, 80) || "Bob"));
    headerCopy.appendChild(node(documentRef, "p", "bob-widget__subtitle", "A review-only companion for your host chatbot"));
    var closeButton = node(documentRef, "button", "bob-widget__close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close Bob mentor");
    header.appendChild(headerCopy);
    header.appendChild(closeButton);

    var body = node(documentRef, "div", "bob-widget__body");
    var status = node(documentRef, "div", "bob-widget__status");
    status.setAttribute("role", "status");
    var statusDot = node(documentRef, "span", "bob-widget__status-dot");
    var statusText = node(documentRef, "span");
    status.appendChild(statusDot);
    status.appendChild(statusText);
    body.appendChild(status);

    body.appendChild(node(documentRef, "div", "bob-widget__section-label", "Project and context"));
    var contextGrid = node(documentRef, "div", "bob-widget__context");
    var projectValue = node(documentRef, "span", "bob-widget__context-value");
    var scopeValue = node(documentRef, "span", "bob-widget__context-value");
    var messageValue = node(documentRef, "span", "bob-widget__context-value");
    function contextItem(label, valueNode) {
      var item = node(documentRef, "div", "bob-widget__context-item");
      item.appendChild(node(documentRef, "span", "bob-widget__context-key", label));
      item.appendChild(valueNode);
      return item;
    }
    contextGrid.appendChild(contextItem("Project", projectValue));
    contextGrid.appendChild(contextItem("Scope", scopeValue));
    contextGrid.appendChild(contextItem("Messages", messageValue));
    contextGrid.appendChild(contextItem("Source", node(documentRef, "span", "bob-widget__context-value", text(options.source, 80) || "Host chatbot")));
    body.appendChild(contextGrid);

    body.appendChild(node(documentRef, "div", "bob-widget__section-label", "Conversation context"));
    var messagesView = node(documentRef, "div", "bob-widget__messages");
    body.appendChild(messagesView);

    body.appendChild(node(documentRef, "div", "bob-widget__section-label", "Guidance"));
    var guidanceView = node(documentRef, "div", "bob-widget__guidance");
    body.appendChild(guidanceView);

    var composer = node(documentRef, "form", "bob-widget__composer");
    var input = node(documentRef, "textarea", "bob-widget__input");
    input.maxLength = MAX_MESSAGE_LENGTH;
    input.rows = 3;
    input.placeholder = "Ask Bob about the next step...";
    input.setAttribute("aria-label", "Question for Bob");
    var composerRow = node(documentRef, "div", "bob-widget__composer-row");
    var hint = node(documentRef, "span", "bob-widget__hint", "Guidance is untrusted; verify it yourself.");
    var askButton = node(documentRef, "button", "bob-widget__ask", "Ask Bob");
    askButton.type = "submit";
    composerRow.appendChild(hint);
    composerRow.appendChild(askButton);
    composer.appendChild(input);
    composer.appendChild(composerRow);

    panel.appendChild(header);
    panel.appendChild(body);
    panel.appendChild(composer);
    shadow.appendChild(launcher);
    shadow.appendChild(panel);
    mount.appendChild(host);

    function projectName() {
      var project = state.context && state.context.project;
      if (typeof project === "string") return project;
      if (project && typeof project === "object") return project.projectName || project.name || project.title;
      return state.context.projectName || state.context.name || "Not supplied";
    }

    function renderContext() {
      var context = state.context || {};
      projectValue.textContent = text(projectName(), 100) || "Not supplied";
      scopeValue.textContent = text(context.scope || options.scope, 80) || "Unspecified";
      messageValue.textContent = String(state.messages.length);
    }

    function renderMessages() {
      messagesView.textContent = "";
      if (!state.messages.length) {
        messagesView.appendChild(node(documentRef, "div", "bob-widget__guidance-empty", "No host messages supplied yet."));
        return;
      }
      state.messages.slice(-12).forEach(function (message) {
        var item = node(documentRef, "div", "bob-widget__message");
        item.setAttribute("data-role", message.role);
        item.appendChild(node(documentRef, "span", "bob-widget__message-role", message.role));
        item.appendChild(node(documentRef, "span", "", message.text));
        messagesView.appendChild(item);
      });
      messagesView.scrollTop = messagesView.scrollHeight;
    }

    function contentParts(value) {
      if (value == null) return [];
      if (Array.isArray(value)) {
        return value.map(function (item) { return contentParts(item); }).reduce(function (all, parts) { return all.concat(parts); }, []).filter(Boolean).slice(0, 20);
      }
      if (typeof value === "string" || typeof value === "number") return [text(value, 1200)].filter(Boolean);
      if (typeof value !== "object") return [];
      var parts = [];
      if (value.text) parts.push(text(value.text, 1200));
      if (value.question) parts.push(text(value.question, 1200));
      if (value.reason) parts.push("Why: " + text(value.reason, 800));
      if (Array.isArray(value.suggestions)) {
        value.suggestions.slice(0, 20).forEach(function (suggestion) {
          contentParts(suggestion).forEach(function (part) { parts.push(part); });
        });
      }
      if (Array.isArray(value.limitations)) {
        value.limitations.slice(0, 20).forEach(function (limitation) {
          contentParts(limitation).forEach(function (part) { parts.push("Limitation: " + part); });
        });
      }
      if (value.title && value.text) parts.unshift(text(value.title, 240));
      return parts.filter(Boolean);
    }

    function guidanceSection(title, value) {
      var card = node(documentRef, "section", "bob-widget__card");
      card.appendChild(node(documentRef, "div", "bob-widget__untrusted", "Untrusted guidance"));
      card.appendChild(node(documentRef, "h4", "", title));
      var parts = contentParts(value);
      if (!parts.length) {
        card.appendChild(node(documentRef, "p", "", "No guidance provided for this section."));
      } else if (parts.length === 1) {
        card.appendChild(node(documentRef, "p", "", parts[0]));
      } else {
        var list = node(documentRef, "ul");
        parts.forEach(function (part) { list.appendChild(node(documentRef, "li", "", part)); });
        card.appendChild(list);
      }
      return card;
    }

    function unwrapGuidance(value) {
      if (value && value.data && typeof value.data === "object") return value.data;
      return value && typeof value === "object" ? value : {};
    }

    function renderGuidance() {
      guidanceView.textContent = "";
      if (!state.guidance) {
        guidanceView.appendChild(node(documentRef, "div", "bob-widget__guidance-empty", "Ask a question to receive review-only guidance from the host."));
        return;
      }
      var guidance = unwrapGuidance(state.guidance);
      guidanceView.appendChild(guidanceSection("Reply", guidance.reply));
      guidanceView.appendChild(guidanceSection("Next action", guidance.nextAction || guidance.nextStep));
      guidanceView.appendChild(guidanceSection("Lesson", guidance.lesson));
      guidanceView.appendChild(guidanceSection("Clarification", guidance.clarification));
      guidanceView.appendChild(guidanceSection("Verification", guidance.verification || guidance.verificationNeeded));
    }

    function setStatus(message, stateName) {
      statusText.textContent = message;
      status.setAttribute("data-state", stateName || "");
    }

    function renderStatus() {
      if (!state.requestGuidance) {
        setStatus("Host configuration needed: provide requestGuidance(payload).", "error");
      } else if (state.asking) {
        setStatus("Bob is waiting for the host guidance response...", "");
      } else {
        setStatus("Host connection ready. Bob will only suggest; the host controls requests.", "ready");
      }
      renderViews();
    }

    function renderViews() {
      askButton.disabled = state.asking;
      renderContext();
      renderMessages();
      renderGuidance();
    }

    function addMessage(message) {
      if (state.destroyed) return bridge;
      var normalized = normalizeMessage(message);
      if (!normalized) return bridge;
      state.messages.push(normalized);
      state.messages = state.messages.slice(-MAX_MESSAGES);
      renderStatus();
      return bridge;
    }

    function setContext(context) {
      if (state.destroyed) return bridge;
      state.context = safeClone(context || {}, 0) || {};
      renderStatus();
      return bridge;
    }

    function ask(question) {
      if (state.destroyed) return Promise.reject(new Error("Bob widget has been destroyed"));
      var questionText = text(question == null ? input.value : question, MAX_MESSAGE_LENGTH);
      if (!questionText) {
        setStatus("Type a question before asking Bob.", "error");
        input.focus();
        return Promise.resolve(null);
      }
      if (!state.requestGuidance) {
        setStatus("Configuration required: the host must provide requestGuidance(payload).", "error");
        return Promise.resolve(null);
      }
      if (state.asking) return Promise.reject(new Error("Bob is already waiting for a guidance response"));

      input.value = "";
      addMessage({ role: "user", text: questionText });
      state.asking = true;
      renderStatus();
      var context = safeClone(state.context, 0) || {};
      var payload = {
        contractVersion: "agent-analysis.v1",
        source: text(options.source, 120) || "custom-host",
        conversationId: state.conversationId,
        consent: options.consent !== false,
        userMessage: questionText,
        messages: state.messages.slice(-MAX_MESSAGES).map(function (message) { return { role: message.role, text: message.text }; }),
        project: safeClone(context.project || {
          projectName: context.projectName || context.name || "",
          objective: context.objective || ""
        }, 0),
        scope: text(context.scope || options.scope, 80) || undefined,
        context: context
      };

      var result;
      try {
        result = state.requestGuidance(payload);
      } catch (error) {
        result = Promise.reject(error);
      }
      return Promise.resolve(result).then(function (response) {
        if (state.destroyed) return response;
        state.guidance = response;
        state.asking = false;
        setStatus("Guidance received. Review it and verify the suggested checks.", "ready");
        renderViews();
        return response;
      }).catch(function (error) {
        if (state.destroyed) return null;
        state.asking = false;
        setStatus("The host could not provide guidance: " + text(error && error.message, 180), "error");
        renderViews();
        return null;
      });
    }

    function open() {
      if (state.destroyed) return bridge;
      state.open = true;
      panel.hidden = false;
      launcher.hidden = true;
      input.focus();
      return bridge;
    }

    function close() {
      if (state.destroyed) return bridge;
      state.open = false;
      panel.hidden = true;
      launcher.hidden = false;
      launcher.focus();
      return bridge;
    }

    function destroy() {
      if (state.destroyed) return;
      state.destroyed = true;
      host.remove();
      bridge = null;
    }

    var bridge = {
      addMessage: addMessage,
      setContext: setContext,
      ask: ask,
      open: open,
      close: close,
      destroy: destroy
    };

    launcher.addEventListener("click", open);
    closeButton.addEventListener("click", close);
    composer.addEventListener("submit", function (event) {
      event.preventDefault();
      ask();
    });
    input.addEventListener("keydown", function (event) {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        ask();
      }
    });

    renderStatus();
    return Object.freeze(bridge);
  }

  global.BobAgentWidget = Object.freeze({
    version: VERSION,
    create: create,
    mount: create
  });
}(typeof window !== "undefined" ? window : globalThis));
