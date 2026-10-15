/**
 * Provider-neutral, deterministic Bob guidance.
 *
 * This module has no network, filesystem, clock, DOM, or provider dependency.
 * It deliberately treats all captured text as untrusted evidence. In
 * particular, assistant text can describe a decision or claim a test result,
 * but it can never establish user intent or proof of implementation here.
 */

export const GUIDANCE_CONTRACT_VERSION = "bob-guidance-core.v1";
export const MAX_CONTEXT_MESSAGES = 40;
export const MAX_CONTEXT_TEXT = 1800;
export const MAX_CONTEXT_ARRAY = 20;
export const MAX_GUIDANCE_TEXT = 800;
export const MAX_CONTEXT_BYTES = 96 * 1024;

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,160}$/;
const ROLES = new Set(["user", "assistant"]);
const SCOPES = new Set(["demo", "production", "unspecified"]);
const PROJECT_KEYS = new Set([
  "projectName", "description", "objective", "audience", "requirements", "features",
  "technologyStack", "designPreferences", "architecture", "completedMilestones",
  "pendingTasks", "knownIssues", "decisions", "recentChanges", "nextSteps",
  "experienceLevel", "currentStage", "deploymentReadiness"
]);

const CONTEXT_KEYS = new Set([
  "source", "conversationId", "scope", "messages", "project", "userMessage",
  "capabilities", "checks"
]);
const MESSAGE_KEYS = new Set(["role", "text"]);
const CHECK_KEYS = new Set(["id", "text", "checked"]);

const SECRET_PATTERNS = [
  /\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|client[ _-]?secret|password|passwd|secret)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|[^\s,;]+)/gi,
  /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=?/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/g
];

const INTENT_LABELS = new Map([
  ["goal", "goal"], ["objective", "goal"], ["requirement", "requirement"],
  ["feature", "requirement"], ["constraint", "constraint"], ["decision", "decision"],
  ["scope", "constraint"]
]);

const SECURITY_AREAS = [
  {
    id: "secrets", area: "Secrets and credentials",
    mention: /\b(?:secret(?:s)?|api[ _-]?key|access[ _-]?token|passwords?|credentials?|\.env|process\.env)\b/i,
    risk: /\b(?:commit|share|publish|expose|log|print|hardcode|client[ -]side|frontend)\b[\s\S]{0,70}\b(?:secret|api[ _-]?key|password|token|credential)/i,
    action: "Keep real credentials in server-side configuration, avoid copying them into clients or logs, and inspect the built output manually."
  },
  {
    id: "identity", area: "Authentication and authorization",
    mention: /\b(?:account(?:s)?|auth(?:entication|orization)?|login|log[ -]?in|sign[ -]?in|permission(?:s)?|role(?:s)?|ownership|session(?:s)?|cookie(?:s)?)\b/i,
    risk: /\b(?:no|without|missing|skip|bypass|trust)\b[\s\S]{0,45}\b(?:auth|login|permission|ownership|session|role|access)/i,
    action: "Write down signed-out, wrong-user, and allowed-user cases; enforce identity and per-record ownership on the server."
  },
  {
    id: "inputs", area: "Input validation and output handling",
    mention: /\b(?:input|validation|validate|sanitize|escape|encode|XSS|injection|HTML|schema)\b/i,
    risk: /\b(?:no|without|missing|raw|unescaped|unvalidated|skip)\b[\s\S]{0,45}\b(?:input|validation|escape|encoding|HTML)/i,
    action: "Define type, length, and format limits on the server and render untrusted content as text."
  },
  {
    id: "data", area: "Data access and privacy",
    mention: /\b(?:database|data|SQL|query|storage|record|PII|personal data|privacy|owner)\b/i,
    risk: /\b(?:raw|concatenat|interpolat|without|missing|no)\b[\s\S]{0,55}\b(?:query|SQL|ownership|access|privacy|data)/i,
    action: "Review parameterized access, server-derived ownership, data minimization, and handling of test versus real data."
  },
  {
    id: "abuse", area: "Abuse and rate controls",
    mention: /\b(?:rate[ -]?limit|throttl|brute[ -]?force|abuse|quota|retry|bot)\b/i,
    risk: /\b(?:no|without|missing|unbounded|unlimited)\b[\s\S]{0,40}\b(?:rate|limit|retry|attempt|abuse)/i,
    action: "Choose bounded request and retry behavior, especially for sign-in, search, uploads, and expensive operations."
  },
  {
    id: "errors", area: "Errors and failure responses",
    mention: /\b(?:error|exception|failure|fallback|stack trace|debug)\b/i,
    risk: /\b(?:show|return|expose|leak|send)\b[\s\S]{0,45}\b(?:stack|exception|internal|debug)/i,
    action: "Check that public failures are generic enough and that internal details do not reach users or logs unnecessarily."
  },
  {
    id: "logging", area: "Logging and sensitive data",
    mention: /\b(?:log(?:ging)?|telemetry|audit|PII|privacy|redact|mask)\b/i,
    risk: /\b(?:log|store|dump|record)\b[\s\S]{0,50}\b(?:password|secret|token|cookie|PII|personal data|request)/i,
    action: "Review logs for secrets, credentials, and personal data; retain only what is needed for diagnosis."
  },
  {
    id: "dependencies", area: "Dependencies and supply chain",
    mention: /\b(?:dependenc(?:y|ies)|package|npm|yarn|pnpm|lockfile|third[ -]?party|audit)\b/i,
    risk: /\b(?:latest|floating|unlocked|untrusted|skip|without|no)\b[\s\S]{0,45}\b(?:package|dependency|lockfile|audit)/i,
    action: "Record dependency versions and review the lockfile and audit results before sharing or deploying."
  },
  {
    id: "sessions", area: "Web sessions and cross-origin behavior",
    mention: /\b(?:CORS|CSRF|XSRF|cross[ -]?origin|SameSite|HttpOnly|HTTPS|TLS|session|cookie)\b/i,
    risk: /\b(?:allow all|wildcard|missing|without|disable|sameSite\s*[:=]\s*none|httpOnly\s*[:=]\s*false)\b/i,
    action: "Review the origin allowlist, CSRF posture, cookie flags, expiry, logout invalidation, and transport settings."
  },
  {
    id: "deployment", area: "Deployment and configuration",
    mention: /\b(?:deploy(?:ment)?|production|staging|Docker|Kubernetes|config(?:uration)?|CI\/CD|debug)\b/i,
    risk: /\b(?:debug|development)\s*[:=]\s*(?:true|on|enabled)|\b(?:disable|skip|bypass)\b[\s\S]{0,35}\b(?:TLS|HTTPS|certificate)/i,
    action: "Document the intended environment and inspect production configuration, transport security, and debug settings manually."
  }
];

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function bounded(value, limit = MAX_CONTEXT_TEXT, allowEmpty = true) {
  return typeof value === "string" && value.length <= limit && (allowEmpty || value.trim().length > 0);
}

function clean(value, limit = MAX_GUIDANCE_TEXT) {
  let result = typeof value === "string" ? value.replace(/\r\n?/g, "\n").replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  result = result.replace(SECRET_PATTERNS[0], "$1[REDACTED]");
  for (const pattern of SECRET_PATTERNS.slice(1)) result = result.replace(pattern, "[REDACTED]");
  result = result.replace(/\s+/g, " ").trim();
  return result.length > limit ? result.slice(0, limit - 1).trimEnd() + "…" : result;
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function id(value, required = false) {
  if (typeof value !== "string") return required ? null : "";
  const result = value.trim();
  return ID_PATTERN.test(result) ? result : required ? null : "";
}

function normalizeMessages(value, fallback) {
  const source = value === undefined ? [{ role: "user", text: fallback }] : value;
  if (!Array.isArray(source) || source.length > MAX_CONTEXT_MESSAGES) return null;
  const result = [];
  for (const message of source) {
    if (!isPlainObject(message) || [...Object.keys(message)].some(key => !MESSAGE_KEYS.has(key)) ||
        !ROLES.has(message.role) || !bounded(message.text, MAX_CONTEXT_TEXT, false)) return null;
    result.push({ role: message.role, text: message.text });
  }
  return result;
}

function normalizeProject(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!PROJECT_KEYS.has(key) || !bounded(item)) return null;
    result[key] = item;
  }
  return result;
}

function normalizeChecks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_ARRAY) return null;
  const result = [];
  for (const check of value) {
    if (!isPlainObject(check) || [...Object.keys(check)].some(key => !CHECK_KEYS.has(key)) ||
        !id(check.id) || !bounded(check.text, MAX_GUIDANCE_TEXT, false) || typeof check.checked !== "boolean") return null;
    result.push({ id: check.id, text: check.text, checked: check.checked });
  }
  return result;
}

function effectiveMessages(value) {
  const last = value.messages[value.messages.length - 1];
  return last && last.role === "user" && last.text === value.userMessage
    ? value.messages
    : value.messages.concat([{ role: "user", text: value.userMessage }]);
}

/** Normalize a provider-neutral, bounded context without inferring anything. */
export function normalizeUniversalContext(input) {
  if (!isPlainObject(input) || [...Object.keys(input)].some(key => !CONTEXT_KEYS.has(key))) {
    return { ok: false, code: "invalid_context" };
  }
  const source = input.source === undefined ? "" : id(input.source, true);
  const conversationId = input.conversationId === undefined ? "" : id(input.conversationId, true);
  if (input.source !== undefined && !source || input.conversationId !== undefined && !conversationId) {
    return { ok: false, code: "invalid_context" };
  }
  if (!bounded(input.userMessage, MAX_CONTEXT_TEXT, false)) return { ok: false, code: "invalid_context" };
  const messages = normalizeMessages(input.messages, input.userMessage);
  const project = normalizeProject(input.project);
  const checks = normalizeChecks(input.checks);
  const capabilities = input.capabilities === undefined ? [] : input.capabilities;
  if (!messages || !project || !checks || !Array.isArray(capabilities) || capabilities.length > MAX_CONTEXT_ARRAY ||
      !capabilities.every(item => bounded(item, 120, false))) return { ok: false, code: "invalid_context" };
  const scope = input.scope === undefined ? "unspecified" : input.scope;
  if (!SCOPES.has(scope)) return { ok: false, code: "invalid_context" };
  const value = {
    ...(source ? { source } : {}), ...(conversationId ? { conversationId } : {}), scope,
    messages, project, userMessage: input.userMessage, capabilities: [...capabilities], checks
  };
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_CONTEXT_BYTES) return { ok: false, code: "invalid_context" };
  return { ok: true, value: freeze(value) };
}

function evidence(idValue, role, text, options = {}) {
  return {
    id: idValue, role, text: clean(text), untrusted: true,
    canEstablishIntent: role === "user-intent",
    canEstablishProof: false, ...options
  };
}

/** Classify provenance without upgrading assistant text into decisions or proof. */
export function classifyEvidenceRoles(context) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const messages = effectiveMessages(normalized.value).map((message, index) => {
    const explicit = message.role === "user" && extractIntentLines(message.text).length > 0;
    return evidence(`message-${index + 1}`, explicit ? "user-intent" : message.role === "user" ? "user-context" : "assistant-context", message.text, {
      sourceRole: message.role, canEstablishIntent: explicit
    });
  });
  const project = Object.entries(normalized.value.project).map(([key, value]) => evidence(`project-${key}`, "declared-project-context", `${key}: ${value}`, {
    field: key, canEstablishIntent: true
  }));
  return freeze({ ok: true, value: { messages, project, all: messages.concat(project) } });
}

function extractIntentLines(text) {
  const lines = String(text || "").split(/\n|[.!?]\s+|;\s*/).map(line => line.trim()).filter(Boolean);
  const results = [];
  for (const line of lines) {
    if (/\?/.test(line) || /\b(?:maybe|might|could|perhaps|possibly|not sure|uncertain|undecided)\b/i.test(line)) continue;
    const labeled = line.match(/^(goal|objective|requirement|feature|constraint|decision|scope)\s*:\s*(.+)$/i);
    const implicit = line.match(/\b(?:I|we)\s+(?:want|need|plan|intend)\s+to\s+(.+)/i) || line.match(/\b(?:build|create|make|develop)\s+(.+)/i);
    if (labeled && labeled[2].trim()) results.push({ type: INTENT_LABELS.get(labeled[1].toLowerCase()), text: clean(labeled[2]) });
    else if (implicit && implicit[1].trim()) results.push({ type: "goal", text: clean(implicit[1]) });
  }
  return results;
}

function uniqueItems(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = `${item.type || item.id}:${String(item.text || item.change).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0, MAX_CONTEXT_ARRAY);
}

function suggestion(idValue, text) {
  return { id: idValue, text: clean(text), untrusted: true };
}

export function deriveIntentAndProjectUnderstanding(context) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const value = normalized.value;
  const current = [];
  const projectIntent = [];
  effectiveMessages(value).forEach(message => {
    if (message.role !== "user") return;
    extractIntentLines(message.text).forEach(item => current.push({ ...item, source: "user-message", untrusted: true }));
  });
  for (const [key, item] of Object.entries(value.project)) {
    if (["objective", "requirements", "features", "constraints", "decisions", "audience"].includes(key) && item) {
      projectIntent.push({ type: key === "objective" ? "goal" : key === "audience" ? "constraint" : "requirement", text: clean(item), source: `project.${key}`, untrusted: true });
    }
  }
  const intents = uniqueItems(current.concat(projectIntent));
  const goals = intents.filter(item => item.type === "goal");
  const what = clean(value.project.objective || value.project.projectName || goals.at(-1)?.text || "The project is not explicitly described yet.");
  const why = clean(value.project.description || value.project.objective ? `The stated objective is: ${value.project.objective || value.project.description}` : "The user's purpose is not explicitly stated yet.");
  const targetUsers = clean(value.project.audience || "Target users are not specified yet.");
  const currentSuggestions = intents.map((item, index) => suggestion(`intent-${index + 1}`, `${item.type}: ${item.text}`));
  const understanding = {
    whatIsBeingBuilt: what || "Not specified.", why: why || "Not specified.", targetUsers: targetUsers || "Not specified.", untrusted: true
  };
  return freeze({ ok: true, value: {
    current: currentSuggestions, replaced: [], uncertain: goals.length ? [] : [suggestion("intent-uncertain", "The user's concrete goal still needs an explicit statement.")],
    projectUnderstanding: understanding, intents
  } });
}

/** Detect explicit replacement language and simple mutually exclusive choices. */
export function detectRequirementChanges(context) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const userText = effectiveMessages(normalized.value).filter(message => message.role === "user").map(message => message.text);
  const changes = [];
  for (const text of userText) {
    const replacement = text.match(/(?:changed?|switch(?:ed)?|replace(?:d)?|now)\s+(?:the\s+)?(?:requirement|goal|plan|scope)?\s*(?:from\s+)?(.{3,100}?)\s+(?:to|with)\s+(.{3,140})/i);
    const reversal = text.match(/(?:no longer|not anymore|instead of|drop(?:ping)?|remove)\s+(.{3,140})/i);
    if (replacement) changes.push({ change: `Replace ${clean(replacement[1], 240)} with ${clean(replacement[2], 240)}`, impact: "Review dependent screens, data boundaries, tests, and deployment assumptions before continuing.", confidence: "explicit user change", untrusted: true });
    else if (reversal) changes.push({ change: `The user says to stop using ${clean(reversal[1], 240)}.`, impact: "Check whether prior implementation plans or checks still apply.", confidence: "explicit user change", untrusted: true });
  }
  const all = userText.join(" ");
  const conflicts = [];
  const pairs = [
    [/\b(?:demo|prototype|fake accounts?)\b/i, /\b(?:production|real users?|public deployment)\b/i, "demo scope and production scope"],
    [/\b(?:no|without)\s+(?:accounts?|login|auth)/i, /\b(?:accounts?|login|sign[ -]?in|auth)/i, "no-account and account-based access"],
    [/\b(?:local[- ]only|offline)\b/i, /\b(?:cloud|remote|hosted|openrouter)\b/i, "local-only and cloud processing"],
    [/\b(?:web|browser)\b/i, /\b(?:mobile|ios|android)\b/i, "web and mobile targets"]
  ];
  for (const [left, right, label] of pairs) {
    if (left.test(all) && right.test(all) && !new RegExp(`(?:not|without)\\s+[^.]{0,30}${right.source}`, "i").test(all)) {
      conflicts.push({ conflict: label, impact: "Ask which boundary is current; do not choose one from assistant text or a topic mention.", untrusted: true });
    }
  }
  return freeze({ ok: true, value: { changes: changes.slice(0, MAX_CONTEXT_ARRAY), conflicts: conflicts.slice(0, MAX_CONTEXT_ARRAY) } });
}

export function generateSecurityReviewSuggestions(context) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const text = effectiveMessages(normalized.value).concat(Object.entries(normalized.value.project).map(([key, value]) => ({ role: "user", text: `${key}: ${value}` }))).map(item => item.text).join("\n");
  const review = SECURITY_AREAS.map(area => {
    const mentioned = area.mention.test(text);
    const risk = area.risk.test(text);
    if (!mentioned && !risk) return null;
    return { id: area.id, area: area.area, status: risk ? "needs-review" : "mentioned", reason: risk ? "The bounded text contains a possible control gap; text is not implementation evidence." : "The topic is mentioned, but no control is verified from text.", recommendedAction: area.action, untrusted: true };
  }).filter(Boolean).slice(0, MAX_CONTEXT_ARRAY);
  if (!review.length) review.push({ id: "baseline", area: "General security review", status: "needs-review", reason: "No implementation evidence was provided by the universal context.", recommendedAction: "Review identity, inputs, data access, secrets, abuse controls, errors, logging, dependencies, sessions, and deployment before treating the project as ready.", untrusted: true });
  return freeze({ ok: true, value: review });
}

export function generatePlanningOptions(context, derived = null) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const changes = derived?.changes || detectRequirementChanges(normalized.value).value.changes;
  const options = changes.length ? [
    { id: "clarify-change", title: "Clarify the changed boundary first", steps: ["Write the old and new requirement in one sentence.", "List the feature, data, and verification work affected.", "Choose the current requirement explicitly."], reason: "A requirement change can invalidate earlier plans.", untrusted: true },
    { id: "small-slice", title: "Build a smallest safe slice", steps: ["Choose one user action.", "Write success, invalid-input, and denied outcomes.", "Run a human check before adding another feature."], reason: "A small slice makes assumptions visible early.", untrusted: true }
  ] : [
    { id: "clarify-boundaries", title: "Clarify the project boundary", steps: ["State the goal and target users.", "Choose demo or production scope.", "Name data, identity, and failure boundaries."], reason: "Clear boundaries prevent accidental assumptions.", untrusted: true },
    { id: "acceptance-slice", title: "Write one acceptance slice", steps: ["Choose one user action.", "Describe success and failure outcomes.", "Add a human-run verification check."], reason: "A concrete example gives implementation and review a shared target.", untrusted: true }
  ];
  return freeze({ ok: true, value: options.slice(0, 3) });
}

export function deriveNextAction(context, derived = null) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const changes = derived?.changes || detectRequirementChanges(normalized.value).value.changes;
  const conflicts = derived?.conflicts || detectRequirementChanges(normalized.value).value.conflicts;
  const understanding = derived?.understanding || deriveIntentAndProjectUnderstanding(normalized.value).value;
  if (changes.length || conflicts.length) return { ok: true, value: { text: "Resolve the requirement change or conflict in one explicit sentence before coding.", reason: "The current plan is ambiguous and earlier checks may no longer apply.", untrusted: true } };
  if (!understanding.current.length) return { ok: true, value: { text: "Write one explicit Goal: statement describing what to build and who it is for.", reason: "No explicit user goal was found; assistant text cannot supply one.", untrusted: true } };
  if (normalized.value.scope === "unspecified" && /\b(?:account|login|sign[ -]?in|password|personal data|production|real users?)\b/i.test(JSON.stringify(normalized.value))) return { ok: true, value: { text: "Choose whether this is a private demo with fake data or a production app for real users.", reason: "The scope changes identity, data, secret, and deployment review.", untrusted: true } };
  return { ok: true, value: { text: "Write one acceptance example with success, invalid-input, and access-denied outcomes.", reason: "A concrete example is the smallest useful boundary for implementation and human verification.", untrusted: true } };
}

export function deriveVerificationStates(context, security = []) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return { ok: false, code: normalized.code };
  const states = security.slice(0, MAX_CONTEXT_ARRAY).map(item => ({ id: item.id, status: item.status === "mentioned" ? "mentioned" : "not-verified", text: `Human review needed for ${item.area.toLowerCase()}.`, verified: false, untrusted: true }));
  normalized.value.checks.forEach(check => states.push({ id: check.id, status: check.checked ? "user-reported" : "not-verified", text: clean(check.text), verified: false, untrusted: true }));
  if (!states.length) states.push({ id: "implementation", status: "not-verified", text: "Run the relevant tests and inspect implementation results outside Bob.", verified: false, untrusted: true });
  return freeze({ ok: true, value: { states: states.slice(0, MAX_CONTEXT_ARRAY), suggestions: states.slice(0, MAX_CONTEXT_ARRAY).map(item => suggestion(`verify-${item.id}`, item.text)), limitations: [suggestion("limitation-text", "Text and user-reported checks do not prove implementation, security, test execution, or deployment.")], untrusted: true } });
}

export function buildBobGuidance(context) {
  const normalized = normalizeUniversalContext(context);
  if (!normalized.ok) return normalized;
  const value = normalized.value;
  const evidenceResult = classifyEvidenceRoles(value);
  const understandingResult = deriveIntentAndProjectUnderstanding(value);
  const changeResult = detectRequirementChanges(value);
  const securityResult = generateSecurityReviewSuggestions(value);
  const verificationResult = deriveVerificationStates(value, securityResult.value);
  const nextResult = deriveNextAction(value, {
    changes: changeResult.value.changes, conflicts: changeResult.value.conflicts,
    understanding: understandingResult.value
  });
  const planningResult = generatePlanningOptions(value, changeResult.value);
  const openQuestions = [];
  if (value.scope === "unspecified" && securityResult.value.some(item => ["identity", "data", "sessions"].includes(item.id))) openQuestions.push(suggestion("scope", "Is this a private demo with fake data, or a production app for real users?"));
  if (!understandingResult.value.projectUnderstanding.targetUsers || understandingResult.value.projectUnderstanding.targetUsers === "Target users are not specified yet.") openQuestions.push(suggestion("audience", "Who is the intended user for the first acceptance example?"));
  const uncertainty = [suggestion("evidence-boundary", "Assistant text is context only; it cannot establish user intent or prove that a control, test, or deployment exists.")];
  const reply = clean(`Deterministic Bob guidance: ${nextResult.value.text} This is bounded review guidance, not proof.`);
  return freeze({ ok: true, value: {
    contractVersion: GUIDANCE_CONTRACT_VERSION, untrusted: true,
    evidence: evidenceResult.value.all.slice(0, MAX_CONTEXT_ARRAY),
    projectUnderstanding: understandingResult.value.projectUnderstanding,
    intent: { current: understandingResult.value.current, replaced: understandingResult.value.replaced, uncertain: understandingResult.value.uncertain, untrusted: true },
    changedRequirements: changeResult.value.changes,
    conflicts: changeResult.value.conflicts,
    securityReview: securityResult.value,
    planningOptions: planningResult.value,
    nextAction: nextResult.value,
    verification: verificationResult.value,
    openQuestions, uncertainty, reply
  } });
}

/** Convert deterministic guidance to the existing agent-analysis.v1 contract. */
export function toAgentAnalysisOutput(guidance) {
  const value = guidance?.value || guidance;
  if (!value || !value.intent || !value.verification) return null;
  const nodes = value.securityReview.slice(0, 20).map(item => ({
    id: item.id, status: item.status === "mentioned" ? "likely" : "not-verified", summary: clean(item.reason), untrusted: true
  }));
  const question = value.openQuestions[0] || { text: "", reason: "No additional clarification was derived from the bounded context." };
  return {
    contractVersion: "agent-analysis.v1", untrusted: true, reply: value.reply,
    intentUpdate: { current: value.intent.current, replaced: value.intent.replaced, uncertain: value.intent.uncertain, untrusted: true },
    flowReview: { nodes, untrusted: true }, nextAction: value.nextAction,
    lesson: { title: "Boundaries make guidance reviewable.", text: "Treat stated intent as user evidence and every implementation or verification claim as unverified until a person checks it.", untrusted: true },
    clarification: { question: clean(question.text), reason: clean(question.reason || "The bounded context leaves this decision open."), untrusted: true },
    verification: value.verification
  };
}

export const normalizeBoundedUniversalContext = normalizeUniversalContext;
export const classifyEvidence = classifyEvidenceRoles;
export const deriveProjectUnderstanding = deriveIntentAndProjectUnderstanding;
export const detectRequirementConflicts = detectRequirementChanges;
export const generateSecurityReview = generateSecurityReviewSuggestions;
export const generatePlanning = generatePlanningOptions;
export const deriveVerification = deriveVerificationStates;
