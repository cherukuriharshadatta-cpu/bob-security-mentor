(function (global) {
  "use strict";

  var MAX_MEMORY_TURNS = 40;
  var MAX_TURN_LENGTH = 1800;
  var MAX_GUIDANCE_LENGTH = 240;
  var PROJECT_FIELDS = [
    ["projectName", "Project name"], ["description", "Description"],
    ["objective", "Objective"], ["audience", "Audience"],
    ["requirements", "Requirements"], ["features", "Features"],
    ["technologyStack", "Technology stack"], ["designPreferences", "Design preferences"],
    ["architecture", "Architecture"], ["completedMilestones", "Completed milestones"],
    ["pendingTasks", "Pending tasks"], ["knownIssues", "Known issues"],
    ["decisions", "Decisions"], ["recentChanges", "Recent changes"],
    ["nextSteps", "Next steps"], ["experienceLevel", "Experience level"],
    ["currentStage", "Current stage"], ["deploymentReadiness", "Deployment readiness"]
  ].map(function (field) { return { key: field[0], label: field[1] }; });
  // ChatGPT's public rendered markup has changed several times. These are
  // explicit role signals only; Bob never infers a speaker from alternation,
  // CSS classes, or the position of a turn.
  var AUTHOR_SELECTOR = '[data-message-author-role="user"], [data-message-author-role="assistant"], [data-author-role="user"], [data-author-role="assistant"], [data-turn-role="user"], [data-turn-role="assistant"]';
  var TURN_SELECTOR = '[data-testid^="conversation-turn-"]';
  var EXCLUDED_SELECTOR = '#bob-mentor-root, nav, aside, [role="navigation"], [role="complementary"], #sidebar, [data-testid*="sidebar"], input, textarea, select, button, script, style, noscript, template';
  // The class portions are only candidate hints; isAccessibleLabelNode applies
  // exact token recognition so `not-sr-only` and variant strings never qualify.
  // Keep the hints compatible with the small DOM used by the extension tests.
  var ACCESSIBLE_LABEL_SELECTOR = '[aria-label], [aria-labelledby], h1, h2, h3, h4, h5, h6, [class*="sr-only"], [class*="visually-hidden"]';

  // These are deliberately broad, deterministic local rules. They are review
  // signals only: a topic mention is never treated as proof of implementation
  // or security, and no external source is consulted.
  var SECURITY_CHECK_DEFINITIONS = [
    {
      id: "secrets-env", title: "Secrets/env handling", category: "secrets", priority: "high",
      mentioned: [
        /\b(?:secret(?:s)?|api[ _-]?key|access[ _-]?token|client[ _-]?secret|passwords?|credentials?)\b/i,
        /\b(?:\.env|process\.env|env(?:ironment)?[ _-]?(?:vars?|variables?)|vault|secret manager|key rotation|rotate keys?|redact(?:ion)?)\b/i
      ],
      risks: [
        { pattern: /\b(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?token|client[ _-]?secret|password|passwd|credential)\b\s*[:=]\s*["'`][^"'`\r\n]{4,}["'`]/i, label: "credential-like value assigned inline" },
        { pattern: /\b(?:api[ _-]?key|secret(?:[ _-]?key)?|access[ _-]?token|client[ _-]?secret)\b\s*[:=]\s*["'`]?\s*(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})["'`]?/i, label: "API-token-shaped literal" },
        { pattern: /\b(?:password|passwd)\b\s*[:=]\s*["'`]?\s*(?!process\.env\b|env(?:ironment)?\b|undefined\b|null\b|redacted\b|placeholder\b)[A-Za-z0-9!@#$%^&*()_+=:;,.?\/-]{4,}["'`]?/i, label: "password-like literal" },
        { pattern: /\b(?:commit|check[ -]?in|expose|publish|share|print)\b.{0,50}\b(?:\.env|api[ _-]?key|secret|password|token)\b/i, label: "secret exposure or handling language" }
      ]
    },
    {
      id: "authentication-authorization", title: "Authentication/authorization", category: "identity", priority: "high",
      mentioned: [
        /\b(?:auth(?:entication|orization)?|login|sign[ -]?in|OAuth|OpenID|JWT|RBAC|role[ -]?based|permission(?:s)?|access control|identity provider)\b/i
      ],
      risks: [
        { pattern: /\b(?:no|without|missing|skip(?:ping)?|disable[ds]?|bypass(?:ed)?)\s+(?:auth(?:entication|orization)?|login|access control|permission(?:s)?)\b/i, label: "missing or bypassed access control language" },
        { pattern: /\b(?:auth(?:entication|orization)?|login|access control|permission(?:s)?)\b.{0,30}\b(?:missing|absent|not implemented|disabled|none)\b/i, label: "incomplete access control language" },
        { pattern: /\b(?:public|anonymous|unauthenticated)\s+(?:endpoint|route|API|access)\b/i, label: "public or unauthenticated access language" },
        { pattern: /\btrust(?:s|ing)?\s+(?:the\s+)?(?:client|user)[ -](?:provided|supplied)\s+(?:role|permission|identity)\b/i, label: "client-provided authorization data" }
      ]
    },
    {
      id: "input-output", title: "Input validation/output encoding", category: "input-output", priority: "high",
      mentioned: [
        /\b(?:input validation|validate|validation|sanitize|sanitiz(?:e|ation)|escape|escaping|output encoding|encode|schema validation|XSS|injection|CSP|content security policy)\b/i,
        /\b(?:eval|innerHTML|dangerouslySetInnerHTML|document\.write)\b/i
      ],
      risks: [
        { pattern: /\beval\s*\(/i, label: "eval call" },
        { pattern: /\b(?:innerHTML|outerHTML|dangerouslySetInnerHTML)\s*\+?=/i, label: "HTML sink assignment" },
        { pattern: /\bdocument\.write\s*\(/i, label: "document.write call" },
        { pattern: /\b(?:no|without|missing|skip(?:ping)?|disable[ds]?)\s+(?:input )?(?:validation|sanit(?:ization|ising|izing)|escaping|encoding)\b/i, label: "missing validation or encoding language" },
        { pattern: /\b(?:input|output|request|user[ -]input)\b.{0,30}\b(?:not validated|unvalidated|not escaped|not encoded)\b/i, label: "unvalidated or unencoded data language" },
        { pattern: /\b(?:raw|unescaped|unsanitized|unsanitised)\s+(?:HTML|input|output|user[ -]input)\b/i, label: "raw or unescaped content language" }
      ]
    },
    {
      id: "database-data-access", title: "Database/data access", category: "data", priority: "high",
      mentioned: [
        /\b(?:database|data[ -]?access|SQL|query(?:ing)?|ORM|repository|prepared statement|parameterized|parameterised|transaction|storage|Firestore|Mongo(?:DB)?)\b/i
      ],
      risks: [
        { pattern: /\b(?:SELECT|INSERT|UPDATE|DELETE)\b[\s\S]{0,180}(?:\+\s*[A-Za-z_$]|\$\{|`)/i, label: "SQL-like query concatenation or interpolation" },
        { pattern: /\b(?:query|execute|rawSQL|raw[ _-]?query)\s*\([^\n]{0,180}(?:\+\s*[A-Za-z_$]|\$\{|`)/i, label: "query built with concatenation or interpolation" },
        { pattern: /\b(?:raw|unparameterized|unparameterised|without|missing)\s+(?:SQL|query|parameter(?:s|ization|isation))\b/i, label: "raw or unparameterized data access language" },
        { pattern: /\b(?:query|SQL|database access)\b.{0,40}\b(?:not parameterized|not parameterised|unparameterized|unparameterised)\b/i, label: "query without parameterization language" },
        { pattern: /\b(?:no|without|missing)\s+(?:row[ -]level|record[ -]level|data[ -]access)\s+(?:authorization|permission|control)\b/i, label: "missing data access control language" }
      ]
    },
    {
      id: "rate-abuse", title: "Rate limiting/abuse controls", category: "abuse", priority: "high",
      mentioned: [
        /\b(?:rate[ -]?limit(?:ing)?|throttl(?:e|ing)|abuse control|brute[ -]?force|quota(?:s)?|request limit|retry budget|backoff|bot protection|anti[ -]?automation)\b/i
      ],
      risks: [
        { pattern: /\b(?:no|without|missing|lack(?:s|ing)?|unlimited|unbounded)\s+(?:rate[ -]?limit(?:ing)?|throttl(?:ing|e)|abuse control|request limit|quota|brute[ -]?force protection)\b/i, label: "missing rate or abuse control language" },
        { pattern: /\b(?:rate[ -]?limit(?:ing)?|throttl(?:e|ing)|abuse control|request limit|quota)\b.{0,30}\b(?:missing|absent|not implemented|disabled|none)\b/i, label: "incomplete rate or abuse control language" },
        { pattern: /\b(?:unbounded|unlimited|infinite)\s+(?:retry|request|attempt|login)\w*\b/i, label: "unbounded retry or attempt language" },
        { pattern: /\b(?:retry|login|request)\w*\s+(?:without|no|missing)\s+(?:backoff|limit|throttl)/i, label: "retry or request control gap" }
      ]
    },
    {
      id: "error-handling", title: "Error handling", category: "errors", priority: "medium",
      mentioned: [
        /\b(?:error handling|errors?|exceptions?|exception handling|catch(?:ing)?|failure handling|fallback|graceful failure|fault tolerance)\b/i
      ],
      risks: [
        { pattern: /\b(?:expose|return|send|show|leak)\w*\s+(?:the\s+)?(?:error\.stack|stack trace|exception details|internal error details)\b/i, label: "internal error detail exposure language" },
        { pattern: /\bcatch\s*\([^)]*\)\s*\{\s*\}/i, label: "empty exception handler" },
        { pattern: /\b(?:swallow|ignore|suppress)\w*\s+(?:errors?|exceptions?)\b/i, label: "suppressed error language" },
        { pattern: /\b(?:debug|development)\s*(?:mode|errors?)\b.{0,60}\b(?:production|public|user)\b/i, label: "debug detail in public or production context" }
      ]
    },
    {
      id: "logging-pii", title: "Logging/PII", category: "privacy", priority: "medium",
      mentioned: [
        /\b(?:log(?:ging)?|audit log|observability|telemetry|PII|personal data|privacy|redact(?:ion)?|mask(?:ing)?)\b/i
      ],
      risks: [
        { pattern: /\b(?:console\.(?:log|info|warn|error|debug)|logger?\.(?:log|info|warn|error|debug)|log(?:ging)?)\b[\s\S]{0,140}\b(?:password|passwd|secret|api[ _-]?key|token|authorization|cookie|session|PII|personal data|SSN|social security)\b/i, label: "sensitive value in logging context" },
        { pattern: /\b(?:log|record|store|dump)\w*\s+(?:raw|all|full)\s+(?:request|response|headers?|cookies?|user data|personal data)\b/i, label: "raw request or personal-data logging language" },
        { pattern: /\b(?:log|logging)\b.{0,50}\b(?:without|no|missing)\s+(?:redact(?:ion|ing)?|mask(?:ing)?|PII filter)\b/i, label: "logging without redaction language" }
      ]
    },
    {
      id: "dependency-supply-chain", title: "Dependency/supply-chain hygiene", category: "supply-chain", priority: "medium",
      mentioned: [
        /\b(?:dependenc(?:y|ies)|packages?|npm|Yarn|pnpm|lockfile|package manager|supply chain|third[ -]?party|SCA|software composition|dependency audit|renovate|dependabot)\b/i
      ],
      risks: [
        { pattern: /\b(?:no|without|missing|ignore|skip(?:ping)?)\s+(?:a\s+)?(?:lockfile|dependency audit|package audit|SCA|integrity check)\b/i, label: "missing dependency or lockfile hygiene language" },
        { pattern: /\b(?:unpinned|unlocked|floating|latest|untrusted|arbitrary)\s+(?:dependenc(?:y|ies)|package(?:s)?|version(?:s)?)\b/i, label: "unbounded or untrusted dependency language" },
        { pattern: /\b(?:npm|yarn|pnpm)\s+install\b[^\n]{0,100}\b(?:latest|next|canary|\*)\b/i, label: "floating package installation language" }
      ]
    },
    {
      id: "cors-csrf-session", title: "CORS/CSRF/session configuration", category: "web-session", priority: "high",
      mentioned: [
        /\b(?:CORS|cross[ -]?origin|CSRF|XSRF|cross[ -]?site request forgery|session(?:s)?|cookie(?:s)?|SameSite|HttpOnly|secure cookie|origin allowlist|anti[ -]?forgery)\b/i
      ],
      risks: [
        { pattern: /\b(?:allow[ -]?origin|origin)\b[^\n]{0,100}(?:\*|true|wildcard)|\bcors?\s*\([^\n]{0,100}(?:origin\s*:\s*true|\*|wildcard)/i, label: "permissive CORS origin language" },
        { pattern: /\b(?:allow all origins|permissive CORS|CORS\s*:\s*\*)\b/i, label: "allow-all CORS language" },
        { pattern: /\b(?:no|without|missing|disable[ds]?|skip(?:ping)?)\s+(?:CSRF|XSRF|anti[ -]?forgery)\b/i, label: "missing CSRF protection language" },
        { pattern: /\b(?:SameSite\s*[:=]\s*["']?none|secure\s*[:=]\s*false|httpOnly\s*[:=]\s*false)\b/i, label: "weak cookie configuration signal" },
        { pattern: /\b(?:session)\b.{0,70}\b(?:no|without|missing)\s+(?:expiration|timeout|rotation|invalidation)\b/i, label: "incomplete session lifecycle language" }
      ]
    },
    {
      id: "deployment-configuration", title: "Deployment/configuration", category: "deployment", priority: "medium",
      mentioned: [
        /\b(?:deploy(?:ment)?|production|staging|configuration|config|CI\/CD|infrastructure|container(?:s)?|Docker|Kubernetes|HTTPS|TLS|SSL|environment|feature flag|debug mode)\b/i
      ],
      risks: [
        { pattern: /\b(?:debug|development)\s*[:=]\s*(?:true|on|enabled)\b/i, label: "debug configuration enabled" },
        { pattern: /\b(?:production|prod)\b[\s\S]{0,100}\bhttp:\/\//i, label: "HTTP in production context" },
        { pattern: /\b(?:disable|skip|ignore|bypass)\w*\s+(?:TLS|SSL|certificate verification|HTTPS)\b/i, label: "transport-security bypass language" },
        { pattern: /\b(?:default|hardcoded)\s+(?:password|credential|secret|admin account)\b/i, label: "default or hardcoded deployment credential language" },
        { pattern: /\b(?:expose|publish|commit|ship)\w*\s+(?:environment|env|config)\s+(?:variables?|file|secrets?)\b/i, label: "deployment configuration exposure language" }
      ]
    }
  ];

  function trimText(value, limit) {
    var text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    if (typeof limit === "number" && text.length > limit) {
      return limit > 0 ? text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…" : "";
    }
    return text;
  }

  function messageText(value) {
    var text = String(value == null ? "" : value).replace(/\r\n?/g, "\n")
      .replace(/[^\S\n]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return text.length > MAX_TURN_LENGTH ? text.slice(0, MAX_TURN_LENGTH - 1).trimEnd() + "…" : text;
  }

  function conversationKeyFromUrl(input) {
    // Absolute HTTPS URLs only. Do not normalize malformed paths into accepted routes.
    if (typeof input !== "string" || !/^https:\/\/chatgpt\.com(?=[:/?#]|$)/i.test(input)) { return null; }
    var url;
    try { url = new URL(input); } catch (error) { return null; }
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com" || url.port || url.username || url.password) { return null; }
    var rawPath = input.replace(/^https:\/\/[^/?#]+/i, "").split(/[?#]/)[0];
    if (rawPath !== url.pathname || /[%\\]/.test(rawPath)) { return null; }
    var route = url.pathname.match(/^\/c\/([A-Za-z0-9_-]+)\/?$/) ||
      url.pathname.match(/^\/g\/[A-Za-z0-9_-]+\/c\/([A-Za-z0-9_-]+)\/?$/);
    return route ? "chatgpt:" + route[1] : null;
  }

  function styleFor(element) {
    var view = element.ownerDocument && element.ownerDocument.defaultView;
    var getter = view && view.getComputedStyle ? view.getComputedStyle.bind(view) : global.getComputedStyle;
    try { return getter ? getter(element) : null; } catch (error) { return null; }
  }

  function excluded(element) {
    for (var current = element; current && current.nodeType !== 9; current = current.parentElement) {
      if (current.matches && current.matches(EXCLUDED_SELECTOR)) { return true; }
      if (current.getAttribute) {
        var editable = current.getAttribute("contenteditable");
        if (current.hasAttribute && current.hasAttribute("hidden") ||
            current.getAttribute("aria-hidden") === "true" ||
            editable !== null && editable !== "false" && editable !== undefined) { return true; }
      }
      var style = styleFor(current);
      if (style && (style.display === "none" || style.visibility === "hidden" ||
          style.visibility === "collapse" || style.contentVisibility === "hidden" || style.opacity === "0")) { return true; }
    }
    return false;
  }

  function hasBox(element) {
    if (!element.getBoundingClientRect) { return false; }
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function visibleElement(element) {
    if (!element || excluded(element)) { return false; }
    if (hasBox(element)) { return true; }
    // display:contents has no own box; its text or descendants can still render.
    var descendants = element.querySelectorAll ? element.querySelectorAll("*") : [];
    for (var i = 0; i < descendants.length; i += 1) {
      if (!excluded(descendants[i]) && hasBox(descendants[i])) { return true; }
    }
    var doc = element.ownerDocument;
    if (doc && doc.createRange) {
      var range = doc.createRange();
      try {
        range.selectNodeContents(element);
        var rects = range.getClientRects ? range.getClientRects() : [];
        for (var j = 0; j < rects.length; j += 1) {
          if (rects[j].width > 0 && rects[j].height > 0) { return true; }
        }
      } finally { if (range.detach) { range.detach(); } }
    }
    return false;
  }

  function renderedTextTrace(element) {
    var pieces = [];
    var excludedBodyNodes = 0;
    function visit(node) {
      if (node.nodeType === 3) { pieces.push(node.nodeValue || ""); return; }
      if (node.nodeType !== 1) { return; }
      if (excluded(node)) {
        excludedBodyNodes = Math.min(999, excludedBodyNodes + 1);
        return;
      }
      // Speaker labels identify the role but are not part of the message body
      // Bob stores. ChatGPT may render them as visible h4 headings without an
      // sr-only class, so remove only headings whose text is an exact speaker
      // label; ordinary visible headings remain ordinary message text.
      if (accessibleHiddenLabel(node) ||
          (/^H[1-6]$/.test(String(node.tagName || "")) && accessibleRoleFromLabel(String(node.textContent || "").trim(), node))) { return; }
      var block = /^(P|DIV|SECTION|ARTICLE|LI|PRE|H[1-6]|BR|TR|BLOCKQUOTE)$/.test(node.tagName);
      if (block) { pieces.push("\n"); }
      Array.prototype.forEach.call(node.childNodes || [], visit);
      if (block) { pieces.push("\n"); }
    }
    visit(element);
    return { text: messageText(pieces.join("")), excludedBodyNodes: excludedBodyNodes };
  }

  function renderedText(element) {
    return renderedTextTrace(element).text;
  }

  function roleOf(element) {
    if (!element || !element.getAttribute) { return null; }
    var attributes = ["data-message-author-role", "data-author-role", "data-turn-role", "data-turn", "role"];
    for (var i = 0; i < attributes.length; i += 1) {
      var value = element.getAttribute(attributes[i]);
      if (value === "user" || value === "assistant") { return value; }
    }
    var label = element.getAttribute("aria-label");
    if (label && /^(?:you|user)(?:\s|$)/i.test(label)) { return "user"; }
    if (label && /^(?:assistant|chatgpt)(?:\s|$)/i.test(label)) { return "assistant"; }
    return null;
  }

  function accessibleHiddenLabel(element) {
    if (!element || !element.getAttribute) { return false; }
    var className = String(element.getAttribute("class") || "");
    return className.split(/\s+/).some(function (token) {
      token = token.toLowerCase();
      return token === "sr-only" || token === "visually-hidden";
    });
  }

  function isAccessibleLabelNode(element) {
    if (!element || !element.getAttribute) { return false; }
    return !!(element.hasAttribute && (element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby"))) ||
      /^H[1-6]$/.test(String(element.tagName || "")) || accessibleHiddenLabel(element);
  }

  function accessibleRawText(element) {
    var pieces = [];
    function visit(node) {
      if (node.nodeType === 3) { pieces.push(node.nodeValue || ""); return; }
      if (node.nodeType !== 1 || excluded(node)) { return; }
      Array.prototype.forEach.call(node.childNodes || [], visit);
    }
    visit(element);
    return trimText(pieces.join(" "), 300);
  }

  function accessibleLabelReference(root, id) {
    if (!root || !id) { return null; }
    var documentRef = root.ownerDocument;
    var byId = documentRef && documentRef.getElementById ? documentRef.getElementById(id) : null;
    if (byId && root.contains && root.contains(byId)) { return byId; }
    var matches = root.querySelectorAll ? root.querySelectorAll('[id="' + String(id).replace(/"/g, '\\"') + '"]') : [];
    return matches.length ? matches[0] : null;
  }

  function accessibleLabelText(element, root) {
    if (!element || !element.getAttribute) { return ""; }
    var aria = trimText(element.getAttribute("aria-label") || "", 300);
    if (aria) { return aria; }
    var labelledBy = String(element.getAttribute("aria-labelledby") || "").trim();
    if (labelledBy) {
      var references = labelledBy.split(/\s+/).map(function (id) {
        return accessibleLabelReference(root, id);
      }).filter(Boolean).map(accessibleRawText);
      var referenced = trimText(references.join(" "), 300);
      if (referenced) { return referenced; }
    }
    return accessibleRawText(element);
  }

  // Only unambiguous speaker words qualify. Generic prose, a page title, or a
  // label such as "message" is deliberately left for visual analysis.
  var ACCESSIBLE_USER_LABEL = /^(?:(?:the|a)\s+)?(?:you|user|human|prompt|question)(?:\s+(?:message|prompt|question|said|asked|input|turn))?[\s:.-]*$/i;
  var ACCESSIBLE_ASSISTANT_LABEL = /^(?:(?:the|an)\s+)?(?:assistant|chatgpt|bot|response|answer|ai)(?:\s+(?:message|response|answer|said|replied|turn))?[\s:.-]*$/i;

  function accessibleRoleFromLabel(label, element) {
    var text = String(label || "").trim();
    // A normal visible heading such as "Question" or "Response" is content,
    // not a speaker marker. Explicit ARIA, an exact hiding token, or an
    // explicit "said:" label is enough to make those words meaningful.
    var heading = element && /^H[1-6]$/.test(String(element.tagName || ""));
    var explicit = element && element.getAttribute && (
      element.getAttribute("aria-label") || element.getAttribute("aria-labelledby") || accessibleHiddenLabel(element)
    );
    var saidLabel = /\bsaid\s*[:.-]?\s*$/i.test(text);
    if (heading && /^(?:question|response)\s*[:.-]?$/i.test(text) && !explicit && !saidLabel) { return null; }
    var user = ACCESSIBLE_USER_LABEL.test(text);
    var assistant = ACCESSIBLE_ASSISTANT_LABEL.test(text);
    if (user === assistant) { return null; }
    return user ? "user" : "assistant";
  }

  function accessibleRolesInCandidate(element, root) {
    var roles = {};
    var labels = [];
    if (element && isAccessibleLabelNode(element)) { labels.push(element); }
    Array.prototype.forEach.call(element && element.querySelectorAll ? element.querySelectorAll(ACCESSIBLE_LABEL_SELECTOR) : [], function (node) {
      if (labels.indexOf(node) === -1) { labels.push(node); }
    });
    labels.forEach(function (node) {
      if (!isAccessibleLabelNode(node) || excluded(node)) { return; }
      var role = accessibleRoleFromLabel(accessibleLabelText(node, root), node);
      if (role) { roles[role] = true; }
    });
    return Object.keys(roles);
  }

  var ACCESSIBLE_REJECTION_REASONS = [
    "excluded-label", "excluded-container", "hidden-or-no-box", "empty-body",
    "control-filter", "mixed-speakers", "oversize", "no-bounded-container"
  ];

  function accessibleRejectionCounts() {
    var counts = {};
    ACCESSIBLE_REJECTION_REASONS.forEach(function (reason) { counts[reason] = 0; });
    return counts;
  }

  function accessibleRoleCounts() {
    return { user: accessibleRejectionCounts(), assistant: accessibleRejectionCounts() };
  }

  function accessibleHasSeparatedBodies(element) {
    var bodies = [];
    function visit(parent) {
      Array.prototype.forEach.call(parent && parent.childNodes || [], function (node) {
        if (!node || node.nodeType !== 1 || excluded(node) || isAccessibleLabelNode(node)) { return; }
        if (visualBlockElement(node)) {
          var trace = renderedTextTrace(node);
          if (trace.text.length >= VISUAL_MIN_TEXT_LENGTH) {
            var rect = visualRect(node);
            if (rect && rect.width > 0 && rect.height > 0) { bodies.push(rect); }
            return;
          }
        }
        visit(node);
      });
    }
    visit(element);
    if (bodies.length < 2) { return false; }
    bodies.sort(function (a, b) { return a.top - b.top; });
    for (var i = 1; i < bodies.length; i += 1) {
      if (bodies[i].top - bodies[i - 1].bottom > VISUAL_MESSAGE_GAP) { return true; }
    }
    return false;
  }

  function accessibleRoleAnchorSegment(labelNode, root, mixedAncestor, role) {
    if (!labelNode || !mixedAncestor || !mixedAncestor.children) { return null; }
    var directChildren = Array.prototype.slice.call(mixedAncestor.children);
    var directSpeakerLabels = directChildren.filter(function (child) {
      return isAccessibleLabelNode(child) && accessibleRoleFromLabel(accessibleLabelText(child, root), child);
    });
    // A wrapper whose direct children are already speaker anchors is an
    // intentionally ambiguous shared container. Leave it for the visual
    // fallback rather than changing the established no-merge behavior.
    if (directSpeakerLabels.some(function (child) {
      return accessibleRoleFromLabel(accessibleLabelText(child, root), child) !== role;
    })) { return null; }

    var anchorIndex = -1;
    for (var i = 0; i < directChildren.length; i += 1) {
      if (directChildren[i] === labelNode || (directChildren[i].contains && directChildren[i].contains(labelNode))) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex < 0) { return null; }

    function candidateFor(element) {
      if (!element || excluded(element) || !visibleElement(element) || !visualBlockElement(element)) { return null; }
      if (accessibleRolesInCandidate(element, root).length) { return null; }
      var trace = renderedTextTrace(element);
      if (trace.text.length < VISUAL_MIN_TEXT_LENGTH || visualControlLike(element, trace.text, root)) { return null; }
      var rect = visualRect(element);
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.height > VISUAL_MAX_BLOCK_HEIGHT || accessibleHasSeparatedBodies(element)) { return null; }
      return { element: element, text: trace.text, rect: rect, depth: visualDepth(element, root), excludedBodyNodes: trace.excludedBodyNodes };
    }

    // The role anchor and its body are often sibling nodes in the live DOM.
    // Stop at the next role-bearing sibling so text from the next speaker can
    // never be widened into this segment.
    for (var siblingIndex = anchorIndex + 1; siblingIndex < directChildren.length; siblingIndex += 1) {
      var sibling = directChildren[siblingIndex];
      var siblingRoles = accessibleRolesInCandidate(sibling, root);
      if (siblingRoles.length) {
        if (siblingRoles.indexOf(role) === -1) { break; }
        continue;
      }
      var candidate = candidateFor(sibling);
      if (candidate) { return candidate; }
    }

    // Some SPA layouts put the speaker marker in a display:contents wrapper
    // whose message body is several levels below it. In that shape there is
    // no usable direct sibling to select, even though the rendered body is
    // still bounded and visible. Search only the document-order segment
    // between this role marker and the next role marker; never widen the
    // capture to the mixed wrapper itself.
    var allNodes = Array.prototype.slice.call(mixedAncestor.querySelectorAll ? mixedAncestor.querySelectorAll("*") : []);
    var labels = allNodes.filter(function (node) {
      return isAccessibleLabelNode(node) && accessibleRoleFromLabel(accessibleLabelText(node, root), node);
    });
    var labelIndex = labels.indexOf(labelNode);
    if (labelIndex < 0) {
      labelIndex = labels.findIndex(function (node) { return node.contains && node.contains(labelNode); });
    }
    if (labelIndex < 0) { return null; }
    var nextLabel = labels[labelIndex + 1] || null;
    var start = allNodes.indexOf(labelNode);
    if (start < 0) {
      start = allNodes.findIndex(function (node) { return node.contains && node.contains(labelNode); });
    }
    var end = nextLabel ? allNodes.indexOf(nextLabel) : allNodes.length;
    if (start < 0) { return null; }
    var segmentedCandidates = [];
    for (var nodeIndex = start + 1; nodeIndex < end; nodeIndex += 1) {
      var bodyCandidate = candidateFor(allNodes[nodeIndex]);
      if (bodyCandidate) { segmentedCandidates.push(bodyCandidate); }
    }
    // Prefer the first bounded rendered block. Nested paragraph/markdown
    // descendants are intentionally not merged with the next speaker; the
    // surrounding display:contents chain has already been excluded above.
    return segmentedCandidates[0] || null;
  }

  function accessibleCandidateContainer(labelNode, root) {
    var hasDirectAria = !!(labelNode && labelNode.getAttribute && (
      labelNode.getAttribute("aria-label") || labelNode.getAttribute("aria-labelledby")
    ));
    // Headings and sr-only/visually-hidden nodes are speaker labels, not the
    // message body. Their parent is the bounded message container. An element
    // carrying aria-label/aria-labelledby itself may be the message container,
    // so retain it as the starting candidate.
    var current = hasDirectAria ? labelNode : (labelNode && labelNode.parentElement) || labelNode;
    var depth = 0;
    var lastReason = "no-bounded-container";
    while (current && current !== root && depth <= VISUAL_MAX_ANCESTORS) {
      // A shared wrapper containing user and assistant labels is a thread or
      // multi-message container, not one bounded message. Reject it and keep
      // looking rather than merging both speakers into the first label's turn.
      if (accessibleRolesInCandidate(current, root).length > 1) {
        var segmented = accessibleRoleAnchorSegment(labelNode, root, current, accessibleRoleFromLabel(accessibleLabelText(labelNode, root), labelNode));
        if (segmented) { return segmented; }
        return { reason: "mixed-speakers" };
      }
      if (excluded(current)) {
        return { reason: "excluded-container" };
      }
      if (!visibleElement(current)) {
        lastReason = "hidden-or-no-box";
      } else if (!visualBlockElement(current)) {
        lastReason = "no-bounded-container";
      } else {
        var trace = renderedTextTrace(current);
        var text = trace.text;
        if (text.length < VISUAL_MIN_TEXT_LENGTH) {
          lastReason = "empty-body";
        } else if (visualControlLike(current, text, root)) {
          lastReason = "control-filter";
        } else {
          var rect = visualRect(current);
          if (!rect || rect.width <= 0 || rect.height <= 0) {
            lastReason = "hidden-or-no-box";
          } else if (rect.height > VISUAL_MAX_BLOCK_HEIGHT) {
            lastReason = "oversize";
          } else if (accessibleHasSeparatedBodies(current)) {
            // A bounded label candidate that contains vertically separated
            // body blocks cannot safely be widened into a message wrapper:
            // the extra block may be an unlabeled neighboring speaker.
            return { reason: "no-bounded-container", excludedBodyNodes: trace.excludedBodyNodes };
          } else {
            return { element: current, text: text, rect: rect, depth: visualDepth(current, root), excludedBodyNodes: trace.excludedBodyNodes };
          }
        }
      }
      current = current.parentElement;
      depth += 1;
    }
    return { reason: lastReason };
  }

  function accessibleLabelsForRoot(root, index) {
    var labels = root.querySelectorAll ? root.querySelectorAll(ACCESSIBLE_LABEL_SELECTOR) : [];
    var infos = [];
    var matched = { user: 0, assistant: 0 };
    var rejected = accessibleRoleCounts();
    Array.prototype.forEach.call(labels, function (node, labelIndex) {
      if (!isAccessibleLabelNode(node)) { return; }
      var role = accessibleRoleFromLabel(accessibleLabelText(node, root), node);
      if (!role) { return; }
      matched[role] += 1;
      if (excluded(node)) {
        rejected[role]["excluded-label"] += 1;
        return;
      }
      var container = accessibleCandidateContainer(node, root);
      if (!container || !container.element) {
        rejected[role][container && container.reason || "no-bounded-container"] += 1;
        return;
      }
      infos.push({
        labelNode: node, element: container.element, text: container.text,
        rect: container.rect, depth: container.depth, role: role,
        index: labelIndex, excludedBodyNodes: container.excludedBodyNodes || 0
      });
    });
    // A message can expose both aria-label and a screen-reader heading, or a
    // wrapper and its child can both be block candidates. Keep one bounded
    // capture per container and suppress nested copies with equal text.
    var unique = [];
    infos.forEach(function (info) {
      var same = unique.find(function (other) { return other.element === info.element; });
      if (same) { return; }
      unique.push(info);
    });
    unique.sort(function (a, b) { return a.rect.top - b.rect.top || a.depth - b.depth || a.index - b.index; });
    var selected = [];
    unique.forEach(function (info) {
      var duplicate = selected.some(function (other) {
        return other.element.contains && other.element.contains(info.element) &&
          other.role === info.role && other.text === info.text;
      });
      if (!duplicate) { selected.push(info); }
    });
    selected.sort(function (a, b) { return a.rect.top - b.rect.top || a.index - b.index; });
    var roles = {};
    selected.forEach(function (info) { roles[info.role] = true; });
    var captured = { user: selected.filter(function (info) { return info.role === "user"; }).length,
      assistant: selected.filter(function (info) { return info.role === "assistant"; }).length };
    var score = selected.length * 25 + (roles.user && roles.assistant ? 10 : 0);
    if (root.tagName && String(root.tagName).toUpperCase() === "MAIN") { score += 4; }
    return {
      root: root, index: index, labels: labels.length, infos: infos,
      selected: selected, score: score, matched: matched, captured: captured,
      rejected: rejected,
      excludedBodyNodes: selected.reduce(function (total, info) { return Math.min(999, total + info.excludedBodyNodes); }, 0)
    };
  }

  function accessibleReasonText(rejected) {
    return ACCESSIBLE_REJECTION_REASONS.map(function (reason) {
      return reason + "=" + (rejected && rejected[reason] || 0);
    }).join(", ");
  }

  function accessibleDiagnosticsText(diagnostics) {
    return "users matched " + diagnostics.matchedUsers + ", captured " + diagnostics.capturedUsers + ", rejected (" + accessibleReasonText(diagnostics.rejectedUsers) + "); assistants matched " + diagnostics.matchedAssistants + ", captured " + diagnostics.capturedAssistants + ", rejected (" + accessibleReasonText(diagnostics.rejectedAssistants) + ")";
  }

  function accessibleLabelConversation(documentRef) {
    var roots = [];
    Array.prototype.forEach.call(documentRef.querySelectorAll('main, [role="main"]'), function (root) {
      if (!excluded(root) && visibleElement(root)) { roots.push(root); }
    });
    var analyses = roots.map(accessibleLabelsForRoot);
    analyses.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    var best = analyses[0] || null;
    var second = analyses[1] || null;
    var margin = best && second ? best.score - second.score : best ? best.score : 0;
    var unambiguous = !!(best && best.selected.length && (!second || margin >= 8));
    var diagnostics = {
      source: "accessibleLabel", mainRoots: roots.length,
      candidateRoots: roots.length, accessibleLabels: best ? best.labels : 0,
      labeledCandidates: best ? best.infos.length : 0,
      ambiguousLabels: best ? Math.max(0, best.labels - best.infos.length) : 0,
      capturedMessages: unambiguous ? best.selected.length : 0,
      matchedUsers: best ? best.matched.user : 0,
      matchedAssistants: best ? best.matched.assistant : 0,
      capturedUsers: unambiguous && best ? best.captured.user : 0,
      capturedAssistants: unambiguous && best ? best.captured.assistant : 0,
      rejectedUsers: best ? best.rejected.user : accessibleRejectionCounts(),
      rejectedAssistants: best ? best.rejected.assistant : accessibleRejectionCounts(),
      excludedBodyNodes: best ? best.excludedBodyNodes : 0,
      selectedRoot: unambiguous ? "best-accessible-label-root" : null,
      scoreMargin: margin
    };
    diagnostics.rejected = { user: diagnostics.rejectedUsers, assistant: diagnostics.rejectedAssistants };
    if (!unambiguous) {
      return {
        messages: [], status: "not-found", source: "accessibleLabel", diagnostics: diagnostics,
         diagnostic: "Accessible-label capture found no unambiguous bounded message containers (source: accessibleLabel; main roots: " + diagnostics.mainRoots + ", accessible labels: " + diagnostics.accessibleLabels + ", labeled candidates: " + diagnostics.labeledCandidates + "; " + accessibleDiagnosticsText(diagnostics) + "). Nothing was captured."
      };
    }
    var messages = best.selected.map(function (info) { return { role: info.role, text: info.text }; })
      .filter(function (message) { return message.text && (message.role === "user" || message.role === "assistant"); });
    diagnostics.capturedMessages = messages.length;
    return {
      messages: messages.slice(-MAX_MEMORY_TURNS), status: messages.length ? "ok" : "not-found",
      source: "accessibleLabel", diagnostics: diagnostics,
      diagnostic: messages.length
         ? "Captured " + messages.length + " rendered message(s) from explicit accessible speaker labels (source: accessibleLabel; main roots: " + diagnostics.mainRoots + ", accessible labels: " + diagnostics.accessibleLabels + ", labeled candidates: " + diagnostics.labeledCandidates + "; " + accessibleDiagnosticsText(diagnostics) + "; excluded body nodes: " + diagnostics.excludedBodyNodes + "). Only the latest 40 messages (up to 1800 characters each) are retained; unloaded or hidden history is unavailable."
         : "Accessible-label capture found no readable bounded message containers (source: accessibleLabel; main roots: " + diagnostics.mainRoots + "; " + accessibleDiagnosticsText(diagnostics) + "). Nothing was captured."
    };
  }

  function conversationRoots(documentRef) {
    var roots = [];
    function add(node) {
      if (node && roots.indexOf(node) === -1 && !excluded(node)) { roots.push(node); }
    }
    // Prefer a semantic main when present, but do not require it: the live
    // ChatGPT SPA has used versions where the thread is mounted without one.
    Array.prototype.forEach.call(documentRef.querySelectorAll('main, [role="main"]'), add);
    Array.prototype.forEach.call(documentRef.querySelectorAll(TURN_SELECTOR), function (node) {
      var hasExplicitRole = roleOf(node) || (node.querySelector && node.querySelector(AUTHOR_SELECTOR));
      if (hasExplicitRole) { add(node); }
    });
    if (!roots.length) {
      // A role-marked message is an acceptable final fallback only when it is
      // not inside a navigation/sidebar/input area. We still require an
      // explicit role and never read arbitrary page prose.
      Array.prototype.forEach.call(documentRef.querySelectorAll(AUTHOR_SELECTOR), function (node) {
        add(node.parentElement || node);
      });
    }
    return roots;
  }

  function candidateMessageNodes(documentRef) {
    if (!documentRef || !documentRef.querySelectorAll) { return []; }
    var nodes = [];
    conversationRoots(documentRef).forEach(function (root) {
      var candidates = [];
      // A turn-level data-turn is a fallback. If the turn contains a more
      // specific author marker, capture that marker once rather than the
      // wrapper and its child as duplicate messages.
      if (roleOf(root) && !(root.querySelector && root.querySelector(AUTHOR_SELECTOR))) { candidates.push(root); }
      Array.prototype.forEach.call(root.querySelectorAll ? root.querySelectorAll(AUTHOR_SELECTOR) : [], function (node) {
        candidates.push(node);
      });
      candidates.forEach(function (node) {
        if (nodes.indexOf(node) !== -1 || excluded(node)) { return; }
        var role = roleOf(node);
        if (!role || !visibleElement(node)) { return; }
        // Nested author markers can be formatting wrappers for one message;
        // retain only the outermost explicit role marker.
        var ancestor = node.parentElement && node.parentElement.closest ? node.parentElement.closest(AUTHOR_SELECTOR) : null;
        if (ancestor && ancestor !== node && nodes.indexOf(ancestor) !== -1) { return; }
        nodes.push(node);
      });
    });
    return nodes;
  }

  // The visual fallback is intentionally a second, narrower path. It is used
  // only after explicit role capture produced no messages. These limits keep
  // a layout guess from becoming a page scraper or a whole-thread container.
  var VISUAL_MAX_DEPTH = 12;
  var VISUAL_MAX_ANCESTORS = 5;
  var VISUAL_MAX_BLOCK_HEIGHT = 2400;
  var VISUAL_MIN_TEXT_LENGTH = 3;
  var VISUAL_MESSAGE_GAP = 24;
  var VISUAL_ROOT_SELECTORS = '[data-testid*="conversation"], [data-testid*="thread"], [id*="conversation"], [id*="thread"], [class*="conversation"], [class*="thread"]';
  var VISUAL_CONTROL_TEXT = /^(?:copy|edit|regenerate|retry|try again|share|stop|send|submit|cancel|continue|close|open|like|dislike|thumbs up|thumbs down|read aloud|more|menu|search|settings|model|new chat|log in|sign in|feedback|hide|show|download|upload)(?:\s+|$)/i;
  var VISUAL_USER_TOKENS = /(?:^|[-_\s/])(user|human|prompt|question|outgoing|sent|self)(?:$|[-_\s/])/i;
  var VISUAL_ASSISTANT_TOKENS = /(?:^|[-_\s/])(assistant|bot|answer|response|incoming|markdown|prose|chatgpt|ai)(?:$|[-_\s/])/i;
  var VISUAL_LAYOUT_TOKENS = /(?:^|:)(?:ml-auto|mr-auto|ms-auto|me-auto|justify-(?:end|start)|items-(?:end|start)|self-(?:end|start)|max-w-[^\s]+|prose(?:-[^\s]+)?|markdown(?:-[^\s]+)?|group(?:[/:-][^\s]+)?|flex|inline-flex|grid)(?:$|[:/])/i;
  var VISUAL_RIGHT_TOKENS = /(?:^|:)(?:ml-auto|ms-auto|justify-end|items-end|self-end)(?:$|[:/])/i;
  var VISUAL_LEFT_TOKENS = /(?:^|:)(?:mr-auto|me-auto|justify-start|items-start|self-start)(?:$|[:/])/i;

  function finiteNumber(value, fallback) {
    var number = Number(value);
    return isFinite(number) ? number : fallback;
  }

  function visualRect(element) {
    if (!element || !element.getBoundingClientRect) { return null; }
    var raw;
    try { raw = element.getBoundingClientRect(); } catch (error) { return null; }
    if (!raw) { return null; }
    var width = finiteNumber(raw.width, 0);
    var height = finiteNumber(raw.height, 0);
    var left = finiteNumber(raw.left, finiteNumber(raw.x, 0));
    var top = finiteNumber(raw.top, finiteNumber(raw.y, 0));
    var right = finiteNumber(raw.right, left + width);
    var bottom = finiteNumber(raw.bottom, top + height);
    if (right <= left && width > 0) { right = left + width; }
    if (bottom <= top && height > 0) { bottom = top + height; }
    return { left: left, top: top, right: right, bottom: bottom, width: width, height: height };
  }

  function visualBlockElement(element) {
    if (!element || !element.tagName) { return false; }
    var tag = String(element.tagName).toUpperCase();
    if (/^(?:P|DIV|ARTICLE|SECTION|LI|PRE|H[1-6]|BLOCKQUOTE|OL|UL|TABLE|TR|TD|DD|DT)$/.test(tag)) { return true; }
    var style = styleFor(element);
    var display = style && String(style.display || "").toLowerCase();
    return /^(?:block|flex|grid|flow-root|list-item|table|table-row|table-cell)$/.test(display);
  }

  function visualContextText(element, root) {
    var pieces = [];
    var current = element;
    var depth = 0;
    while (current && current !== root && depth <= VISUAL_MAX_ANCESTORS) {
      if (current.getAttribute) {
        pieces.push(current.getAttribute("class") || "", current.getAttribute("id") || "");
      }
      current = current.parentElement;
      depth += 1;
    }
    return pieces.join(" ").toLowerCase();
  }

  function visualControlLike(element, text, root) {
    var tag = element && element.tagName ? String(element.tagName).toUpperCase() : "";
    if (/^(?:BUTTON|INPUT|TEXTAREA|SELECT|OPTION|NAV|ASIDE|FORM|LABEL|SUMMARY|LEGEND|HEADER|FOOTER)$/.test(tag)) { return true; }
    var context = visualContextText(element, root);
    if (/(?:^|[-_\s/])(sidebar|navigation|navbar|toolbar|control|controls|composer|search|settings|menu|header|footer|button)(?:$|[-_\s/])/.test(context)) { return true; }
    return VISUAL_CONTROL_TEXT.test(String(text || "").trim());
  }

  function visualRootControlLike(root) {
    var tag = root && root.tagName ? String(root.tagName).toUpperCase() : "";
    if (/^(?:NAV|ASIDE|HEADER|FOOTER)$/.test(tag)) { return true; }
    var context = visualContextText(root, null);
    return /(?:^|[-_\s/])(sidebar|navigation|navbar|toolbar|menu|header|footer|composer|settings)(?:$|[-_\s/])/.test(context);
  }

  function visualDepth(element, root) {
    var depth = 0;
    for (var current = element; current && current !== root; current = current.parentElement) { depth += 1; }
    return depth;
  }

  function visualStyleValue(style, names) {
    if (!style) { return ""; }
    for (var i = 0; i < names.length; i += 1) {
      var name = names[i];
      if (style[name] !== undefined && style[name] !== null && String(style[name]) !== "") {
        return String(style[name]).toLowerCase();
      }
      var cssName = name.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
      if (style[cssName] !== undefined && style[cssName] !== null && String(style[cssName]) !== "") {
        return String(style[cssName]).toLowerCase();
      }
      if (style.getPropertyValue) {
        var value = style.getPropertyValue(cssName);
        if (value !== undefined && value !== null && String(value) !== "") { return String(value).toLowerCase(); }
      }
    }
    return "";
  }

  function visualClassTokens(element, root) {
    var tokens = [];
    var current = element;
    var depth = 0;
    while (current && current !== root && depth <= VISUAL_MAX_ANCESTORS) {
      if (current.getAttribute) {
        String(current.getAttribute("class") || "").split(/\s+/).forEach(function (token) {
          if (token) { tokens.push(token.toLowerCase()); }
        });
      }
      current = current.parentElement;
      depth += 1;
    }
    return tokens;
  }

  function visualHasToken(tokens, pattern) {
    return tokens.some(function (token) {
      pattern.lastIndex = 0;
      return pattern.test(token);
    });
  }

  function visualDirection(element, root, rootRect, rect, text) {
    var user = 0;
    var assistant = 0;
    var tokens = visualContextText(element, root);
    var classTokens = visualClassTokens(element, root);
    var rootWidth = Math.max(rootRect.width, 1);
    var structuralUser = VISUAL_USER_TOKENS.test(tokens);
    var structuralAssistant = VISUAL_ASSISTANT_TOKENS.test(tokens);
    var layoutSignal = visualHasToken(classTokens, VISUAL_LAYOUT_TOKENS);
    var userDirectional = visualHasToken(classTokens, VISUAL_RIGHT_TOKENS);
    var assistantDirectional = visualHasToken(classTokens, VISUAL_LEFT_TOKENS);
    var strongUserGeometry = false;
    var strongAssistantGeometry = false;
    var radius = "";
    var background = "";
    var current = element;
    var depth = 0;

    function noteGeometry(candidate) {
      if (!candidate) { return; }
      var leftGap = Math.max(0, candidate.left - rootRect.left) / rootWidth;
      var rightGap = Math.max(0, rootRect.right - candidate.right) / rootWidth;
      var widthRatio = candidate.width / rootWidth;
      // A clear edge-aligned block is strong geometry. A full-width text
      // block is deliberately ignored here; an aligned ancestor can supply
      // the geometry for it below.
      if (rightGap <= 0.12 && leftGap >= 0.06 && widthRatio <= 0.92) { strongUserGeometry = true; }
      if (leftGap <= 0.12 && rightGap >= 0.06 && widthRatio <= 0.92) { strongAssistantGeometry = true; }
    }

    noteGeometry(rect);
    while (current && current !== root && depth <= VISUAL_MAX_ANCESTORS) {
      var style = styleFor(current);
      var display = visualStyleValue(style, ["display"]);
      var justify = visualStyleValue(style, ["justifyContent"]);
      var alignSelf = visualStyleValue(style, ["alignSelf"]);
      var alignItems = visualStyleValue(style, ["alignItems"]);
      var textAlign = visualStyleValue(style, ["textAlign"]);
      var marginStart = visualStyleValue(style, ["marginLeft", "marginInlineStart"]);
      var marginEnd = visualStyleValue(style, ["marginRight", "marginInlineEnd"]);
      if (/^(?:flex|inline-flex|grid|flow-root)$/.test(display)) { layoutSignal = true; }
      if (marginStart === "auto" || /(?:^|\s)auto(?:\s|$)/.test(marginStart) && !/(?:^|\s)auto(?:\s|$)/.test(marginEnd)) { userDirectional = true; }
      if (marginEnd === "auto" || /(?:^|\s)auto(?:\s|$)/.test(marginEnd) && !/(?:^|\s)auto(?:\s|$)/.test(marginStart)) { assistantDirectional = true; }
      if (/(?:right|end|flex-end)/.test(justify) || /(?:right|end|flex-end)/.test(alignSelf) || /(?:right|end|flex-end)/.test(alignItems) || /(?:right|end)/.test(textAlign)) { userDirectional = true; }
      // Computed text-align commonly reports the default value "start";
      // only an explicit left value is directional enough to use here.
      if (/(?:left|start|flex-start)/.test(justify) || /(?:left|start|flex-start)/.test(alignSelf) || /(?:left|start|flex-start)/.test(alignItems) || /(?:left)/.test(textAlign)) { assistantDirectional = true; }
      if (!radius) { radius = visualStyleValue(style, ["borderRadius"]); }
      if (!background) { background = visualStyleValue(style, ["backgroundColor", "background"]); }
      // ChatGPT-like rows often put the alignment on a wrapper while the
      // descendant text block spans the available width.
      if (current !== element) { noteGeometry(visualRect(current)); }
      current = current.parentElement;
      depth += 1;
    }

    if (userDirectional) { strongUserGeometry = true; }
    if (assistantDirectional) { strongAssistantGeometry = true; }

    // Do not let one generic centered/left paragraph become an assistant
    // turn. A role needs strong directional geometry plus either a role-like
    // structural marker or a separate layout signal. The same rule applies
    // symmetrically to right-aligned user blocks.
    var userEvidence = strongUserGeometry && (structuralUser || layoutSignal);
    var assistantEvidence = strongAssistantGeometry && (structuralAssistant || layoutSignal);
    if (structuralUser) { user += 3; }
    if (structuralAssistant) { assistant += 3; }
    if (strongUserGeometry) { user += 3; }
    if (strongAssistantGeometry) { assistant += 3; }
    if (userDirectional) { user += 1; }
    if (assistantDirectional) { assistant += 1; }
    if (layoutSignal && structuralUser) { user += 1; }
    if (layoutSignal && structuralAssistant) { assistant += 1; }
    if (radius && radius !== "0" && radius !== "none" && userEvidence) { user += 1; }
    if (background && background !== "transparent" && background !== "none" && background.indexOf("rgba(0, 0, 0, 0)") === -1 && userEvidence) { user += 1; }
    if (element && element.querySelector && element.querySelector("pre, code") && assistantEvidence) { assistant += 1; }

    var role = null;
    if (userEvidence && !assistantEvidence && user >= assistant + 2) { role = "user"; }
    else if (assistantEvidence && !userEvidence && assistant >= user + 2) { role = "assistant"; }
    return {
      role: role, user: user, assistant: assistant, text: text,
      structuralRole: role === "user" ? structuralUser : role === "assistant" ? structuralAssistant : false
    };
  }

  function visualBlockInfo(element, root, rootRect, index) {
    if (!element || element === root || excluded(element) || !visualBlockElement(element)) { return null; }
    var depth = visualDepth(element, root);
    if (depth < 1 || depth > VISUAL_MAX_DEPTH || !visibleElement(element)) { return null; }
    var rect = visualRect(element);
    if (!rect || rect.width <= 0 || rect.height <= 0 || rect.height > VISUAL_MAX_BLOCK_HEIGHT) { return null; }
    if (rect.right <= rootRect.left || rect.left >= rootRect.right || rect.bottom <= rootRect.top || rect.top >= rootRect.bottom) { return null; }
    var text = renderedText(element);
    if (text.length < VISUAL_MIN_TEXT_LENGTH || visualControlLike(element, text, root)) { return null; }
    var direction = visualDirection(element, root, rootRect, rect, text);
    return {
      element: element, index: index, depth: depth, rect: rect, text: text,
      role: direction.role, userScore: direction.user, assistantScore: direction.assistant,
      structuralRole: direction.structuralRole
    };
  }

  function visualTopLevelDescendants(info, classified) {
    return classified.filter(function (other) {
      if (other === info || !info.element.contains || !info.element.contains(other.element)) { return false; }
      return !classified.some(function (middle) {
        return middle !== info && middle !== other && info.element.contains && info.element.contains(middle.element) && middle.element.contains && middle.element.contains(other.element);
      });
    });
  }

  function visualOneMessageContainer(info, descendants) {
    if (descendants.length <= 1) { return true; }
    var allSameRole = descendants.every(function (item) { return item.role === descendants[0].role; });
    if (!allSameRole) { return false; }
    var sorted = descendants.slice().sort(function (a, b) { return a.rect.top - b.rect.top || a.index - b.index; });
    var maxGap = 0;
    for (var i = 1; i < sorted.length; i += 1) {
      maxGap = Math.max(maxGap, sorted[i].rect.top - sorted[i - 1].rect.bottom);
    }
    // A structural name alone must not bless an ancestor that contains
    // several vertically separated message blocks. Closely packed paragraphs
    // or code fragments can still remain one outer response block.
    var context = visualContextText(info.element, null);
    if (/(?:messages|message-list|conversation|thread|history|feed|turns)/i.test(context)) { return false; }
    return maxGap <= VISUAL_MESSAGE_GAP;
  }

  function visualOuterShouldYield(info, descendants) {
    if (descendants.length !== 1) { return false; }
    var inner = descendants[0];
    // Prefer a bounded text/bubble block over a full-width row when both
    // render the same message. This keeps wrapper and content nodes from
    // becoming duplicate captures while retaining outer containers for
    // multi-paragraph/code responses.
    return inner.role === info.role && inner.text === info.text && inner.rect.width < info.rect.width * 0.88;
  }

  function visualSelectMessages(infos) {
    var classified = infos.filter(function (info) { return info.role === "user" || info.role === "assistant"; });
    var selected = [];
    // Parent-first selection retains the outermost useful block and prevents
    // a paragraph, code block, and its message wrapper from becoming copies.
    classified.slice().sort(function (a, b) { return a.depth - b.depth || b.userScore + b.assistantScore - (a.userScore + a.assistantScore) || a.index - b.index; }).forEach(function (info) {
      if (selected.some(function (parent) { return parent.element.contains && parent.element.contains(info.element); })) { return; }
      var descendants = visualTopLevelDescendants(info, classified);
      if (descendants.length > 1 && !visualOneMessageContainer(info, descendants)) { return; }
      if (visualOuterShouldYield(info, descendants)) { return; }
      selected.push(info);
    });
    selected.sort(function (a, b) { return a.rect.top - b.rect.top || a.index - b.index; });
    return selected;
  }

  function visualBlocksForRoot(root, index) {
    var rootRect = visualRect(root);
    if (!rootRect || rootRect.width <= 0 || rootRect.height <= 0 || excluded(root) || !visibleElement(root)) {
      return { root: root, index: index, infos: [], selected: [], score: 0, rootRect: rootRect, excluded: true, classifiedCount: 0, ambiguousCount: 0, nearDirectCount: 0 };
    }
    var elements = root.querySelectorAll ? root.querySelectorAll("*") : [];
    var infos = [];
    Array.prototype.forEach.call(elements, function (element, elementIndex) {
      var info = visualBlockInfo(element, root, rootRect, elementIndex);
      if (info) { infos.push(info); }
    });
    var selected = visualSelectMessages(infos);
    // A lone centered/left block can be a welcome panel or UI prose. Keep an
    // assistant block only when its own directional evidence is structural
    // enough to stand alone, or when a user block anchors the conversation.
    // This is deliberately conservative for ambiguous pages.
    var hasUser = selected.some(function (info) { return info.role === "user"; });
    if (!hasUser) {
      selected = selected.filter(function (info) { return info.role !== "assistant" || info.structuralRole; });
    }
    var textLength = selected.reduce(function (total, info) { return total + info.text.length; }, 0);
    var roles = {};
    selected.forEach(function (info) { roles[info.role] = true; });
    var score = selected.length * 20 + Math.min(12, Math.floor(textLength / 80));
    score += Math.min(6, selected.reduce(function (total, info) { return total + Math.max(0, 5 - info.depth); }, 0));
    if (roles.user && roles.assistant) { score += 10; }
    if (root.tagName && String(root.tagName).toUpperCase() === "MAIN") { score += 4; }
    return {
      root: root, index: index, infos: infos, selected: selected, score: score,
      rootRect: rootRect, excluded: false,
      classifiedCount: infos.filter(function (info) { return info.role; }).length,
      ambiguousCount: infos.filter(function (info) { return !info.role; }).length,
      nearDirectCount: selected.filter(function (info) { return info.depth <= 4; }).length
    };
  }

  function visualRootCandidates(documentRef) {
    var roots = [];
    function add(node) {
      if (node && roots.indexOf(node) === -1 && !excluded(node) && !visualRootControlLike(node) && visibleElement(node)) { roots.push(node); }
    }
    var mains = documentRef.querySelectorAll('main, [role="main"]');
    if (mains.length) {
      Array.prototype.forEach.call(mains, add);
      return roots;
    }
    Array.prototype.forEach.call(documentRef.querySelectorAll(VISUAL_ROOT_SELECTORS), add);
    // A thread root nested inside a candidate root is not a second independent
    // conversation. Keep the outer candidate only when it is the same root
    // family; otherwise an ambiguous pair is rejected by the score margin.
    return roots;
  }

  function visualLayoutConversation(documentRef) {
    var mainCount = documentRef.querySelectorAll('main, [role="main"]').length;
    var roots = visualRootCandidates(documentRef);
    var analyses = roots.map(visualBlocksForRoot);
    analyses.sort(function (a, b) { return b.score - a.score || a.index - b.index; });
    var best = analyses[0] || null;
    var second = analyses[1] || null;
    var margin = best && second ? best.score - second.score : best ? best.score : 0;
    var unambiguous = !!(best && best.selected.length && best.score >= 20 && (!second || margin >= 8));
    var diagnostics = {
      source: "visualLayout",
      approximate: true,
      mainRoots: mainCount,
      candidateRoots: roots.length,
      viableRoots: analyses.filter(function (analysis) { return !analysis.excluded && analysis.infos.length; }).length,
      selectedRoot: unambiguous ? "best-visible-layout-root" : null,
      consideredBlocks: best ? best.infos.length : 0,
      classifiedBlocks: best ? best.classifiedCount : 0,
      ambiguousBlocks: best ? best.ambiguousCount : 0,
      nearDirectBlocks: best ? best.nearDirectCount : 0,
      capturedMessages: unambiguous ? best.selected.length : 0,
      excludedBlocks: best ? Math.max(0, best.infos.length - best.classifiedCount) : 0,
      bestScore: best ? best.score : 0,
      scoreMargin: margin
    };
    if (!unambiguous) {
      return {
        messages: [], status: "not-found", source: "visualLayout", diagnostics: diagnostics,
        diagnostic: "Visual-layout fallback found no unambiguous rendered conversation root or message blocks (source: visualLayout; main roots: " + mainCount + ", candidate roots: " + roots.length + ", considered blocks: " + diagnostics.consideredBlocks + ", classified blocks: " + diagnostics.classifiedBlocks + ", ambiguous blocks excluded: " + diagnostics.ambiguousBlocks + "). Nothing was captured."
      };
    }
    var messages = best.selected.map(function (info) { return { role: info.role, text: info.text }; })
      .filter(function (message) { return message.text && (message.role === "user" || message.role === "assistant"); });
    diagnostics.capturedMessages = messages.length;
    return {
      messages: messages.slice(-MAX_MEMORY_TURNS), status: messages.length ? "ok" : "not-found",
      source: "visualLayout", diagnostics: diagnostics,
      diagnostic: messages.length
        ? "Captured " + messages.length + " approximate rendered message block(s) using the conservative visual-layout fallback (source: visualLayout; main roots: " + mainCount + ", candidate roots: " + roots.length + ", considered blocks: " + diagnostics.consideredBlocks + ", classified blocks: " + diagnostics.classifiedBlocks + ", ambiguous blocks excluded: " + diagnostics.ambiguousBlocks + "). Only the latest 40 messages (up to 1800 characters each) are retained; unloaded, hidden, or visually ambiguous history is unavailable."
        : "Visual-layout fallback found no readable rendered message blocks (source: visualLayout; main roots: " + mainCount + ", candidate roots: " + roots.length + "). Nothing was captured."
    };
  }

  function extractConversation(documentRef) {
    var failure = { messages: [], status: "not-found", source: "explicit", diagnostic: "No supported main conversation container was found. Nothing was captured." };
    if (!documentRef || !documentRef.querySelectorAll) { return failure; }
    var roots = conversationRoots(documentRef);
    var nodes = candidateMessageNodes(documentRef);
    var messages = nodes.map(function (node) {
      return { role: roleOf(node), text: renderedText(node) };
    }).filter(function (message) { return message.text && (message.role === "user" || message.role === "assistant"); });
    if (messages.length) {
      return {
        messages: messages.slice(-MAX_MEMORY_TURNS), status: "ok",
        source: "explicit",
        diagnostics: {
          source: "explicit", mainRoots: documentRef.querySelectorAll('main, [role="main"]').length,
          conversationTurns: documentRef.querySelectorAll(TURN_SELECTOR).length,
          authorMarkers: documentRef.querySelectorAll(AUTHOR_SELECTOR).length,
          capturedMessages: messages.length
        },
        diagnostic: roots.some(function (root) { return root.matches && root.matches(TURN_SELECTOR); })
          ? "Captured rendered messages from explicit ChatGPT conversation-turn role markers. Only the latest 40 messages (up to 1800 characters each) are retained; unloaded or hidden history is unavailable."
          : "Captured rendered messages from explicit author-role markers. Only the latest 40 messages (up to 1800 characters each) are retained; unloaded or hidden history is unavailable."
      };
    }
    var mainCount = documentRef.querySelectorAll('main, [role="main"]').length;
    var turnCount = documentRef.querySelectorAll(TURN_SELECTOR).length;
    var authorCount = documentRef.querySelectorAll(AUTHOR_SELECTOR).length;
    var accessible = accessibleLabelConversation(documentRef);
    if (accessible.messages.length) {
      return accessible;
    }
    var visual = visualLayoutConversation(documentRef);
    if (visual.messages.length) {
      return visual;
    }
    failure.diagnostics = visual.diagnostics;
    failure.source = "visualLayout";
    var explicitDiagnostic = roots.length
      ? "Supported conversation roots were found, but no readable explicit user/assistant role markers were available (main roots: " + mainCount + ", conversation turns: " + turnCount + ", author markers: " + authorCount + "). Nothing was captured."
      : documentRef.querySelectorAll(AUTHOR_SELECTOR + ", " + TURN_SELECTOR).length
        ? "Explicit message markers were found outside a supported rendered conversation root (main roots: " + mainCount + ", conversation turns: " + turnCount + ", author markers: " + authorCount + "). Nothing was captured."
        : "The page has no supported explicit message or conversation-turn role markers (main roots: " + mainCount + ", conversation turns: " + turnCount + ", author markers: " + authorCount + "). Nothing was captured.";
    failure.diagnostic = explicitDiagnostic + " Accessible-label capture (source: accessibleLabel) found " + accessible.diagnostics.accessibleLabels + " accessible label(s) and " + accessible.diagnostics.labeledCandidates + " bounded candidate(s). Visual-layout fallback (source: visualLayout) considered " + visual.diagnostics.consideredBlocks + " visible block(s) in " + visual.diagnostics.candidateRoots + " candidate root(s); classified " + visual.diagnostics.classifiedBlocks + ", " + visual.diagnostics.ambiguousBlocks + " ambiguous block(s) were excluded. Nothing approximate was captured.";
    return failure;
  }

  function extractVisibleConversationText(documentRef) {
    return conversationText(extractConversation(documentRef).messages);
  }

  function normalizeMessages(input) {
    if (input && !Array.isArray(input) && Array.isArray(input.messages)) { input = input.messages; }
    if (!Array.isArray(input)) {
      // Parse legacy role boundaries BEFORE whitespace normalization.
      var legacy = String(input || "").replace(/\r\n?/g, "\n");
      var pattern = /^(user|assistant):[ \t]*/gim;
      var match;
      var parsed = [];
      var previous = null;
      while ((match = pattern.exec(legacy))) {
        if (previous) { parsed.push({ role: previous.role, text: legacy.slice(previous.start, match.index) }); }
        previous = { role: match[1].toLowerCase(), start: pattern.lastIndex };
      }
      if (previous) { parsed.push({ role: previous.role, text: legacy.slice(previous.start) }); }
      else if (legacy.trim()) { parsed.push({ role: "user", text: legacy }); }
      input = parsed;
    }
    return input.filter(function (message) {
      return message && (message.role === "user" || message.role === "assistant") && typeof message.text === "string";
    }).map(function (message) { return { role: message.role, text: messageText(message.text) }; })
      .filter(function (message) { return !!message.text; }).slice(-MAX_MEMORY_TURNS);
  }

  function conversationText(messages) {
    return messages.map(function (message) { return message.role + ": " + message.text; }).join("\n");
  }

  function securitySourceText(input, project) {
    var pieces = [];
    normalizeMessages(input).forEach(function (message) {
      // Role labels are retained as bounded captured text context; no DOM or
      // arbitrary memory fields are inspected here.
      pieces.push(message.role + ": " + message.text);
    });
    var explicitProject = project && typeof project === "object" ? project
      : input && !Array.isArray(input) && input.project && typeof input.project === "object" ? input.project : null;
    // The local UI may pass the memory envelope as the optional project
    // argument. Only its explicit project fields are eligible for analysis.
    if (explicitProject && explicitProject.project && typeof explicitProject.project === "object") {
      explicitProject = explicitProject.project;
    }
    if (explicitProject) {
      PROJECT_FIELDS.forEach(function (field) {
        if (typeof explicitProject[field.key] === "string" && explicitProject[field.key].trim()) {
          pieces.push("project " + field.label + ": " + messageText(explicitProject[field.key]));
        }
      });
    }
    return pieces.join("\n");
  }

  function regexMatches(text, pattern) {
    pattern.lastIndex = 0;
    return pattern.test(text);
  }

  function firstSecurityRisk(definition, text) {
    for (var i = 0; i < definition.risks.length; i += 1) {
      if (regexMatches(text, definition.risks[i].pattern)) { return definition.risks[i]; }
    }
    return null;
  }

  function securityChecksFromMemoryOrMessages(input, project) {
    var source = securitySourceText(input, project);
    return SECURITY_CHECK_DEFINITIONS.map(function (definition) {
      var mentioned = definition.mentioned.some(function (pattern) { return regexMatches(source, pattern); });
      var risk = firstSecurityRisk(definition, source);
      var status = risk ? "needs-review" : mentioned ? "mentioned" : "unknown";
      var evidence = "";
      var detail;
      if (risk) {
        // Never echo a possible credential, token, PII value, or code snippet.
        evidence = "Local rule flag: " + risk.label + ".";
        detail = "A local rule-based signal suggests review (" + risk.label + "). This is not a security audit and does not verify exploitability or safety.";
      } else if (mentioned) {
        evidence = "Topic explicitly mentioned in captured material.";
        detail = "The captured messages or explicit project fields mention this topic. Mention is not evidence that it is implemented or secure.";
      } else {
        detail = "No explicit local evidence about this topic was found in the bounded captured messages or explicit project fields.";
      }
      return {
        id: definition.id,
        title: definition.title,
        category: definition.category,
        status: status,
        priority: definition.priority,
        detail: detail,
        evidence: evidence
      };
    });
  }

  function securitySummary(checks) {
    var list = Array.isArray(checks) ? checks : checks && Array.isArray(checks.checks) ? checks.checks
      : checks && (Array.isArray(checks.messages) || checks.project) ? securityChecksFromMemoryOrMessages(checks) : [];
    var counts = { mentioned: 0, needsReview: 0, unknown: 0, total: list.length };
    list.forEach(function (check) {
      if (!check) { return; }
      if (check.status === "mentioned") { counts.mentioned += 1; }
      else if (check.status === "needs-review") { counts.needsReview += 1; }
      else if (check.status === "unknown") { counts.unknown += 1; }
    });
    var scoreLabel;
    var headline;
    if (counts.needsReview) {
      scoreLabel = "Needs review";
      headline = counts.needsReview + " local rule-based topic(s) have review flags; this is not a security audit.";
    } else if (counts.mentioned) {
      scoreLabel = counts.unknown ? "Partial local coverage" : "Topics mentioned";
      headline = counts.mentioned + " topic(s) are mentioned locally, but no security property is verified; this is not a security audit.";
    } else {
      scoreLabel = "No local evidence";
      headline = "No relevant local evidence was captured; this does not indicate safety and is not a security audit.";
    }
    return { scoreLabel: scoreLabel, headline: headline, counts: counts };
  }

  function securityFromMemoryOrMessages(input, project) {
    var checks = securityChecksFromMemoryOrMessages(input, project);
    return { checks: checks, summary: securitySummary(checks) };
  }

  function snapshotFromMessages(messages) { return JSON.stringify(normalizeMessages(messages)); }

  function explicitGoal(text) {
    var patterns = [
      /(?:^|\n|;\s*)(?:project\s+)?(?:goal|objective)\s*:\s*([^\n;]+)/gi,
      /(?:^|[.!?\n]\s*|\b)(?:my|our|the)\s+(?:new\s+)?(?:project\s+)?(?:goal|objective)\s*(?:is\s*:?|:)\s*(?:to\s+)?([^\n]+)/gi,
      /\b(?:i|we)\s+(?:now\s+)?(?:want|need|plan)\s+to\s+([^\n]+)/gi,
      /\b(?:help me(?:\s+to)?|(?:i am|i'm|we are|we're)\s+trying to)\s+([^\n]+)/gi,
      /(?:^|[.!?\n]\s*)(?:instead[, ]+|now[, ]+|let(?:'|’)s\s+)(?:please\s+)?((?:build|create|make|develop|switch to|focus on)\b[^\n]+)/gi,
      /^(?:please\s+)?((?:build|create|develop)\s+[^\n]+)/gi
    ];
    var best = null;
    patterns.forEach(function (pattern) {
      var match;
      while ((match = pattern.exec(text))) {
        if (!best || match.index >= best.index) { best = { index: match.index, text: match[1] }; }
      }
    });
    return best ? trimText(best.text, MAX_TURN_LENGTH) : "";
  }

  function questionFromText(text) {
    var questions = String(text || "").match(/[^.!?\n]{2,}\?/g) || [];
    return questions.length ? trimText(questions[questions.length - 1], MAX_GUIDANCE_LENGTH) : "";
  }

  function deriveGuidance(input, previousGoal) {
    var messages = normalizeMessages(input);
    var latestUser = "";
    var goal = previousGoal || "";
    var question = "";
    messages.forEach(function (message) {
      if (message.role !== "user") { return; }
      latestUser = message.text;
      goal = explicitGoal(message.text) || goal;
      question = questionFromText(message.text) || question;
    });
    return {
      currentGoal: trimText(goal || latestUser || "Clarify the outcome you want from this conversation.", MAX_GUIDANCE_LENGTH),
      openQuestions: question ? "Most recent user question (possibly already answered): " + question : "No explicit user question detected in the captured messages.",
      nextStep: latestUser
        ? "Suggested: choose one small action for the latest user request: " + trimText(latestUser, MAX_GUIDANCE_LENGTH)
        : "Suggested: state the project goal and choose one small next action.",
      source: "Simple deterministic local rules using user messages; suggestions are not confirmed facts or AI analysis."
    };
  }

  function emptyProject() {
    var project = {};
    PROJECT_FIELDS.forEach(function (field) { project[field.key] = ""; });
    return project;
  }

  function copyProject(input) {
    var result = emptyProject();
    PROJECT_FIELDS.forEach(function (field) {
      if (input && typeof input[field.key] === "string") { result[field.key] = messageText(input[field.key]); }
    });
    return result;
  }

  function copyOverrides(memory) {
    var overrides = {};
    // Preserve explicit edits across schema migrations. Values are still
    // limited to known project fields; security is never inferred from them.
    if (memory && memory.schemaVersion === 3 && memory.overrides && typeof memory.overrides === "object") {
      PROJECT_FIELDS.forEach(function (field) {
        if (Object.prototype.hasOwnProperty.call(memory.overrides, field.key) && typeof memory.overrides[field.key] === "string") {
          overrides[field.key] = messageText(memory.overrides[field.key]);
        }
      });
    }
    return overrides;
  }

  function suggestedProject(previous, messages) {
    var result = copyProject(previous);
    messages.forEach(function (message) {
      if (message.role !== "user") { return; }
      var goal = explicitGoal(message.text);
      // Only explicit field-labelled user statements populate other fields.
      // In particular, assistant claims never establish completed work or readiness.
      message.text.split(/\n|;\s*/).forEach(function (line) {
        PROJECT_FIELDS.forEach(function (field) {
          var aliases = [field.label, field.key.replace(/([A-Z])/g, " $1")];
          if (field.key === "projectName") { aliases.push("project", "name"); }
          if (field.key === "objective") { aliases.push("goal", "project goal"); }
          if (field.key === "technologyStack") { aliases.push("tech stack", "stack"); }
          var label = new RegExp("^\\s*(?:" + aliases.join("|") + ")\\s*:\\s*(.*)$", "i");
          var match = line.match(label);
          if (match) { result[field.key] = trimText(match[1], MAX_TURN_LENGTH); }
        });
      });
      // A later replacement in the same message wins over an earlier labelled goal.
      if (goal) { result.objective = goal; }
    });
    return result;
  }

  function mergedProject(suggestions, overrides) {
    var result = copyProject(suggestions);
    Object.keys(overrides).forEach(function (key) { result[key] = overrides[key]; });
    return result;
  }

  function boundedTurns(turns) {
    return (Array.isArray(turns) ? turns : []).slice(-MAX_MEMORY_TURNS).filter(function (turn) {
      return turn && typeof turn.text === "string";
    }).map(function (turn) {
      return { text: messageText(turn.text), observedAt: trimText(turn.observedAt, 80), kind: turn.kind === "user-edit" ? "user-edit" : "capture" };
    });
  }

  function baseMemory(existing, key, now) {
    var current = existing && existing.conversationKey === key ? existing : null;
    // Schema 2 stored suggestions separately; older values commonly stored a
    // merged project. Both are retained as unconfirmed project values.
    var sourceProject = current && current.suggestions && typeof current.suggestions === "object"
      ? current.suggestions : current && current.project;
    var suggestions = copyProject(sourceProject);
    var overrides = copyOverrides(current);
    var memory = {
      schemaVersion: 3, conversationKey: key,
      createdAt: current && current.createdAt || now,
      updatedAt: current && current.updatedAt || now,
      consentGranted: !!(current && current.consentGranted === true),
      turns: boundedTurns(current && current.turns),
      messages: normalizeMessages(current && current.messages || []),
      guidance: deriveGuidance([]), project: mergedProject(suggestions, overrides),
      suggestions: suggestions, overrides: overrides, security: null, markdown: ""
    };
    memory.security = securityFromMemoryOrMessages(memory.messages, memory.project);
    return memory;
  }

  function stateSnapshot(memory) {
    return JSON.stringify({
      schemaVersion: memory.schemaVersion, conversationKey: memory.conversationKey,
      createdAt: memory.createdAt, consentGranted: memory.consentGranted,
      turns: memory.turns, messages: memory.messages, guidance: memory.guidance,
      project: memory.project, suggestions: memory.suggestions, overrides: memory.overrides,
      security: memory.security
    });
  }

  function memoryGuidance(memory) {
    var guidance = deriveGuidance(memory.messages, memory.suggestions.objective);
    // Confirmed corrections, including intentionally empty fields, are authoritative.
    if (Object.prototype.hasOwnProperty.call(memory.overrides, "objective")) {
      guidance.currentGoal = memory.overrides.objective
        ? "User-confirmed: " + trimText(memory.overrides.objective, MAX_GUIDANCE_LENGTH)
        : "Project objective intentionally cleared by the user.";
    } else if (memory.project.objective) {
      guidance.currentGoal = trimText(memory.project.objective, MAX_GUIDANCE_LENGTH);
    }
    if (Object.prototype.hasOwnProperty.call(memory.overrides, "nextSteps")) {
      guidance.nextStep = memory.overrides.nextSteps ? "User-confirmed: " + trimText(memory.overrides.nextSteps, MAX_GUIDANCE_LENGTH) : "Next steps intentionally cleared by the user.";
    }
    return guidance;
  }

  function answerLocalQuestion(question, memory) {
    var asked = trimText(question, MAX_GUIDANCE_LENGTH);
    var safeMemory = memory && typeof memory === "object" ? memory : {};
    var checks = securityChecksFromMemoryOrMessages(safeMemory.messages || [], safeMemory.project);
    var summary = securitySummary(checks);
    var lower = asked.toLowerCase();
    if (!asked) {
      return "No local question was provided. No AI model is connected; only bounded local rules are available.";
    }
    if (/\b(?:security|secure|vulnerab|readiness|audit|risk|attack|auth|secret|cors|csrf|pii|dependency)\b/.test(lower)) {
      return "Local rule-based response: " + summary.headline + " Counts — " + summary.counts.needsReview + " needs review, " + summary.counts.mentioned + " mentioned, " + summary.counts.unknown + " unknown. No security assurance is provided.";
    }
    if (/\b(?:goal|objective|aim)\b/.test(lower)) {
      return "Local memory says the current goal is: " + trimText(safeMemory.guidance && safeMemory.guidance.currentGoal || safeMemory.project && safeMemory.project.objective || "not available", MAX_GUIDANCE_LENGTH) + ". This is captured local text, not an AI answer.";
    }
    if (/\b(?:next|todo|task|progress|status|project)\b/.test(lower)) {
      return "Local memory says: " + trimText(safeMemory.guidance && safeMemory.guidance.nextStep || "no local next step is available", MAX_GUIDANCE_LENGTH) + " No AI model is connected.";
    }
    return "No AI model is connected. I can only answer from bounded captured messages, explicit project fields, and deterministic local rules.";
  }

  function finishMemory(memory, existing, now) {
    if (!existing || stateSnapshot(memory) !== stateSnapshot(existing)) { memory.updatedAt = now; }
    memory.markdown = markdownFromMemory(memory);
    return memory;
  }

  function memoryFromObservation(existing, key, messagesOrLegacyText, now) {
    var current = existing && existing.conversationKey === key ? existing : null;
    var memory = baseMemory(current, key, now);
    var messages = normalizeMessages(messagesOrLegacyText);
    var previousMessages = memory.messages;
    memory.messages = messages;
    memory.suggestions = suggestedProject(memory.suggestions, messages);
    memory.project = mergedProject(memory.suggestions, memory.overrides);
    if (snapshotFromMessages(messages) !== snapshotFromMessages(previousMessages)) {
      var changed = messages.filter(function (message, index) {
        return !previousMessages[index] || previousMessages[index].role !== message.role || previousMessages[index].text !== message.text;
      });
      var last = changed.length ? changed[changed.length - 1] : null;
      memory.turns.push({
        text: last ? messageText(last.role + ": " + last.text) : "The rendered conversation capture is now empty.",
        observedAt: now, kind: "capture"
      });
      memory.turns = memory.turns.slice(-MAX_MEMORY_TURNS);
    }
    memory.guidance = memoryGuidance(memory);
    memory.security = securityFromMemoryOrMessages(memory.messages, memory.project);
    return finishMemory(memory, current, now);
  }

  function applyProjectEdits(existing, edits, now) {
    var memory = baseMemory(existing, existing && existing.conversationKey || "", now);
    var changedLabels = [];
    PROJECT_FIELDS.forEach(function (field) {
      if (!edits || !Object.prototype.hasOwnProperty.call(edits, field.key) || typeof edits[field.key] !== "string") { return; }
      var value = messageText(edits[field.key]);
      if (!Object.prototype.hasOwnProperty.call(memory.overrides, field.key) || memory.overrides[field.key] !== value) {
        memory.overrides[field.key] = value;
        changedLabels.push(field.label);
      }
    });
    memory.project = mergedProject(memory.suggestions, memory.overrides);
    memory.security = securityFromMemoryOrMessages(memory.messages, memory.project);
    if (changedLabels.length) {
      memory.turns.push({ text: "User-confirmed edits: " + changedLabels.join(", ") + ".", observedAt: now, kind: "user-edit" });
      memory.turns = memory.turns.slice(-MAX_MEMORY_TURNS);
    }
    memory.guidance = memoryGuidance(memory);
    return finishMemory(memory, existing, now);
  }

  function markdownFromMemory(memory) {
    var safe = memory || {};
    var guidance = safe.guidance || {};
    var project = copyProject(safe.project);
    var overrides = copyOverrides(safe);
    var security = securityFromMemoryOrMessages(safe.messages || [], project);
    var lines = [
      "# Bob mentor project memory", "",
      "> Bob is an independent extension and is not affiliated with or endorsed by OpenAI or ChatGPT.", "",
      "- Conversation key: " + (safe.conversationKey || "unknown"),
      "- Created: " + (safe.createdAt || "unknown"), "- Updated: " + (safe.updatedAt || "unknown"),
      "- Storage: local browser storage only", "",
      "## Interpretation", "",
      "Suggestions come from simple deterministic local rules applied to user messages. User-confirmed means edited in Bob, not independently verified. Tests, completed work, and deployment have not been verified by Bob. Older imported values remain suggestions, never confirmed inferences.", "",
      "## Project", ""
    ];
    PROJECT_FIELDS.forEach(function (field) {
      var confirmed = Object.prototype.hasOwnProperty.call(overrides, field.key);
      lines.push("### " + field.label + " — " + (confirmed ? "User-confirmed" : "Suggested / unconfirmed"));
      lines.push(project[field.key] || (confirmed ? "Intentionally cleared by the user." : "Not provided."), "");
    });
    lines.push("## Current goal", guidance.currentGoal || "Not available", "", "## Question to review", guidance.openQuestions || "Not available", "", "## Next step", guidance.nextStep || "Not available", "", "## Guidance source", guidance.source || "Simple deterministic local rules.", "", "## Separate automatic suggestions", "");
    PROJECT_FIELDS.forEach(function (field) {
      var value = safe.suggestions && safe.suggestions[field.key];
      if (typeof value === "string" && value) { lines.push("- " + field.label + " (suggested): " + trimText(value, MAX_TURN_LENGTH)); }
    });
    lines.push(
      "", "## Security & readiness review", "",
      "Local rule-based signals from bounded captured user/assistant text and explicit project fields only. This is not a security audit, does not verify security, and does not claim that any control is present.", "",
      "### Summary", "",
      "- Score label: " + security.summary.scoreLabel,
      "- Headline: " + security.summary.headline,
      "- Counts: " + security.summary.counts.needsReview + " needs-review, " + security.summary.counts.mentioned + " mentioned, " + security.summary.counts.unknown + " unknown (" + security.summary.counts.total + " total).", ""
    );
    security.checks.forEach(function (check) {
      lines.push(
        "### " + check.title,
        "",
        "- Status: " + check.status,
        "- Category: " + check.category,
        "- Priority: " + check.priority,
        "- Detail: " + check.detail,
        "- Evidence: " + (check.evidence || "None captured."), ""
      );
    });
    lines.push("", "## Latest captured messages", "", "Only the latest 40 rendered messages, up to 1800 characters each. This is not a complete transcript.", "");
    normalizeMessages(safe.messages || []).forEach(function (message, index) {
      lines.push("### " + (index + 1) + ". " + message.role, "", message.text, "");
    });
    lines.push("## Recent change history", "", "Bounded change summaries, not cumulative transcript snapshots. Capture summaries are observations, not confirmed project facts.", "");
    boundedTurns(safe.turns).forEach(function (turn) {
      lines.push("- " + turn.observedAt + " — " + (turn.kind === "user-edit" ? "User edit" : "Observation") + ": " + turn.text);
    });
    return lines.join("\n") + "\n";
  }

  var api = {
    MAX_MEMORY_TURNS: MAX_MEMORY_TURNS, MAX_TURN_LENGTH: MAX_TURN_LENGTH,
    PROJECT_FIELDS: PROJECT_FIELDS, trimText: trimText,
    conversationKeyFromUrl: conversationKeyFromUrl,
    extractConversation: extractConversation, extractVisibleConversationText: extractVisibleConversationText,
    conversationRoots: conversationRoots, candidateMessageNodes: candidateMessageNodes,
    normalizeMessages: normalizeMessages, snapshotFromMessages: snapshotFromMessages,
    deriveGuidance: deriveGuidance, memoryFromObservation: memoryFromObservation,
    applyProjectEdits: applyProjectEdits, markdownFromMemory: markdownFromMemory,
    securityChecksFromMemoryOrMessages: securityChecksFromMemoryOrMessages,
    securitySummary: securitySummary, answerLocalQuestion: answerLocalQuestion
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  global.BobMentorCore = api;
}(typeof globalThis !== "undefined" ? globalThis : window));
