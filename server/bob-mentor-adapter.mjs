import { timingSafeEqual } from "node:crypto";

export const GENERIC_MENTOR_PATH = "/v1/integrations/mentor";
export const GENERIC_MENTOR_MAX_RESPONSE_BYTES = 64 * 1024;
export const GENERIC_MENTOR_MAX_ID_LENGTH = 160;
export const GENERIC_MENTOR_MAX_CAPABILITIES = 20;

const TOP_LEVEL_FIELDS = new Set([
  "source", "conversationId", "userMessage", "consent", "messages", "project", "scope", "userId", "capabilities"
]);
const MESSAGE_FIELDS = new Set(["role", "text"]);
const PROJECT_FIELDS = new Set([
  "projectName", "description", "objective", "audience", "requirements", "features", "technologyStack",
  "designPreferences", "architecture", "completedMilestones", "pendingTasks", "knownIssues", "decisions",
  "recentChanges", "nextSteps", "experienceLevel", "currentStage", "deploymentReadiness"
]);
const SOURCE_PATTERN = /^[A-Za-z0-9_.:-]+$/;
const MAX_TEXT_LENGTH = 1800;
const MAX_MESSAGE_COUNT = 40;
const MAX_CONTEXT_BYTES = 96 * 1024;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, max = MAX_TEXT_LENGTH, allowEmpty = true) {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function boundedId(value, required = false) {
  if (typeof value !== "string") return required ? null : "";
  const normalized = value.trim();
  if (!normalized || normalized.length > GENERIC_MENTOR_MAX_ID_LENGTH || !SOURCE_PATTERN.test(normalized)) {
    return required ? null : "";
  }
  return normalized;
}

function normalizeMessages(value, userMessage) {
  if (value === undefined) return [{ role: "user", text: userMessage }];
  if (!Array.isArray(value) || value.length > MAX_MESSAGE_COUNT) return null;
  const messages = [];
  for (const message of value) {
    if (!isPlainObject(message) || Object.keys(message).some(key => !MESSAGE_FIELDS.has(key))) return null;
    if ((message.role !== "user" && message.role !== "assistant") || !boundedString(message.text, MAX_TEXT_LENGTH, false)) return null;
    messages.push({ role: message.role, text: message.text });
  }
  return messages;
}

function normalizeProject(value) {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const project = Object.create(null);
  for (const key of Object.keys(value)) {
    if (!PROJECT_FIELDS.has(key) || !boundedString(value[key])) return null;
    project[key] = value[key];
  }
  return project;
}

function normalizeCapabilities(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > GENERIC_MENTOR_MAX_CAPABILITIES) return null;
  const capabilities = [];
  for (const capability of value) {
    if (!boundedString(capability, 120, false)) return null;
    capabilities.push(capability);
  }
  return capabilities;
}

/**
 * Normalize provider-neutral integration input into the existing bounded
 * standalone-agent context. Unknown fields are rejected rather than forwarded.
 */
export function normalizeGenericMentorRequest(input) {
  if (!isPlainObject(input) || Object.keys(input).some(key => !TOP_LEVEL_FIELDS.has(key))) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  const source = boundedId(input.source, true);
  const conversationId = boundedId(input.conversationId, true);
  const userId = input.userId === undefined ? "" : boundedId(input.userId);
  if (!source || !conversationId || (input.userId !== undefined && !userId)) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  if (input.consent !== true) {
    return { ok: false, code: "consent_required", message: "Cloud consent is required." };
  }
  if (!boundedString(input.userMessage, MAX_TEXT_LENGTH, false)) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  const messages = normalizeMessages(input.messages, input.userMessage);
  const project = normalizeProject(input.project);
  const capabilities = normalizeCapabilities(input.capabilities);
  if (!messages || !project || !capabilities) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  const scope = input.scope === undefined ? "unspecified" : input.scope;
  if (!["demo", "production", "unspecified"].includes(scope)) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  const workspaceContext = {
    workspaceId: `${source}:${conversationId}`,
    name: `${source} conversation ${conversationId}`,
    scope,
    project,
    messages,
    capabilities,
    intent: { current: [], replaced: [], uncertain: [] },
    flow: [],
    checks: []
  };
  if (Buffer.byteLength(JSON.stringify(workspaceContext), "utf8") > MAX_CONTEXT_BYTES) {
    return { ok: false, code: "invalid_request", message: "Invalid request." };
  }
  return {
    ok: true,
    value: {
      source,
      conversationId,
      userId,
      capabilities,
      cloudConsent: true,
      workspaceContext,
      userQuestion: input.userMessage
    }
  };
}

export const validateGenericMentorRequest = normalizeGenericMentorRequest;

export function sharedSecretMatches(req, secret) {
  if (!secret) return false;
  const header = req.headers["x-bob-integration-secret"] || req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (typeof header !== "string" || !header) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(header);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function genericMentorResponse(output, input) {
  return {
    status: "success",
    data: {
      ...output,
      source: input.source,
      conversationId: input.conversationId,
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.capabilities.length ? { capabilities: input.capabilities } : {}),
      untrusted: true
    }
  };
}
