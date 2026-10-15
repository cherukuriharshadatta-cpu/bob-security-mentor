import { randomUUID } from "node:crypto";

/**
 * Contract-only boundary for a future codebase/CLI adapter.
 *
 * This module deliberately does not import fs, child_process, or a shell. It
 * validates a request and can hand an already-safe request to a runner that
 * explicitly implements the safe-runner boundary below.
 */
export const CODEBASE_ADAPTER_VERSION = "codebase-adapter.v1";
export const SAFE_RUNNER_VERSION = "safe-codebase-runner.v1";

export const CODEBASE_CAPABILITIES = Object.freeze([
  "listFiles",
  "readFile",
  "searchCode",
  "inspectPackageManifest",
  "inspectEnvironmentNames",
  "runTests",
  "runTypecheck",
  "runLint",
  "runBuild",
  "runSecretScan",
  "runDependencyAudit",
  "inspectGitDiff"
]);

export const READ_ONLY_CAPABILITIES = CODEBASE_CAPABILITIES;
export const EXECUTION_CAPABILITIES = Object.freeze([
  "runTests", "runTypecheck", "runLint", "runBuild", "runSecretScan", "runDependencyAudit"
]);
export const PERMISSION_FLAGS = CODEBASE_CAPABILITIES;
export const CAPABILITY_DEFINITIONS = Object.freeze(Object.fromEntries(CODEBASE_CAPABILITIES.map(capability => [
  capability,
  Object.freeze({
    capability,
    permission: capability,
    readOnly: true,
    execution: EXECUTION_CAPABILITIES.includes(capability)
  })
])));

export const EVIDENCE_PROVENANCE = Object.freeze([
  "suggested",
  "user-reported",
  "tool-observed"
]);

export const RECEIPT_STATUS = Object.freeze(["pass", "fail", "blocked"]);

export const DEFAULT_BOUNDS = Object.freeze({
  timeoutMs: 30_000,
  maxOutputBytes: 64 * 1024,
  maxResults: 200
});

export const MAX_BOUNDS = Object.freeze({
  timeoutMs: 120_000,
  maxOutputBytes: 1024 * 1024,
  maxResults: 2_000
});

const PERMISSION_FLAG_SET = new Set(CODEBASE_CAPABILITIES);
const DECLARATION_FIELDS = new Set([
  "contractVersion", "capabilities", "declaredCapabilities", "permissions", "scope", "bounds",
  "allowWrites", "allowDeploys"
]);
const SCOPE_FIELDS = new Set(["root", "include", "exclude"]);
const BOUNDS_FIELDS = new Set(["timeoutMs", "maxOutputBytes", "maxResults"]);
const RECEIPT_FIELDS = new Set([
  "receiptVersion", "id", "capability", "status", "provenance", "summary", "scope", "bounds",
  "observedAt", "output", "reasonCode"
]);
const PATH_CAPABILITIES = new Set([
  "listFiles", "readFile", "searchCode", "inspectPackageManifest", "inspectGitDiff"
]);
const EXECUTION_CAPABILITY_SET = new Set([
  "runTests", "runTypecheck", "runLint", "runBuild", "runSecretScan", "runDependencyAudit"
]);
const PACKAGE_MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"
]);

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value, max, allowEmpty = true) {
  return typeof value === "string" && value.length <= max && (allowEmpty || value.length > 0);
}

function invalid(code, message = "The adapter request is invalid.") {
  return { ok: false, code, message };
}

function validKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

/** Paths are relative to the declared root and use one separator style. */
export function normalizeRelativePath(value, { allowRoot = true } = {}) {
  if (typeof value !== "string" || value.length > 260 || value.includes("\0") || value.includes("\\")) return null;
  const path = value.trim();
  if (!path || path === ".") return allowRoot ? "." : null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return null;
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return parts.join("/");
}

/**
 * Sensitive paths are never made readable by this contract, even when a
 * caller has a broad read permission. Environment names are metadata only;
 * their values are outside this boundary.
 */
export function isSensitivePath(value) {
  const path = typeof value === "string" ? value.replaceAll("\\", "/") : "";
  return path.split("/").some(segment =>
    /^\.env(?:\..*)?$/i.test(segment) ||
    /^(?:credentials?|secrets?)(?:\..*)?$/i.test(segment) ||
    /^(?:id_(?:rsa|dsa|ecdsa)|authorized_keys)$/i.test(segment) ||
    /private[-_.]?key/i.test(segment) ||
    /\.(?:pem|key|p12|pfx|jks|kdbx|crt|cer)$/i.test(segment)
  );
}

function normalizePathList(value, { required = true, allowSensitive = false } = {}) {
  if (!Array.isArray(value) || value.length === 0 && required || value.length > 100) return null;
  const result = [];
  for (const item of value) {
    const path = normalizeRelativePath(item);
    if (!path || (!allowSensitive && isSensitivePath(path))) return null;
    if (!result.includes(path)) result.push(path);
  }
  return result;
}

export function normalizeScope(value) {
  if (!isPlainObject(value) || !validKeys(value, SCOPE_FIELDS)) return null;
  if (!boundedString(value.root, 260, false) || value.root.includes("\0")) return null;
  const include = normalizePathList(value.include);
  const exclude = value.exclude === undefined ? [] : normalizePathList(value.exclude, { required: false });
  if (!include || !exclude) return null;
  if (isSensitivePath(value.root)) return null;
  return Object.freeze({ root: value.root.trim(), include, exclude });
}

export function normalizeBounds(value = {}) {
  if (!isPlainObject(value) || !validKeys(value, BOUNDS_FIELDS)) return null;
  const bounds = { ...DEFAULT_BOUNDS };
  for (const key of BOUNDS_FIELDS) {
    if (value[key] === undefined) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 1 || value[key] > MAX_BOUNDS[key]) return null;
    bounds[key] = value[key];
  }
  return Object.freeze(bounds);
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > CODEBASE_CAPABILITIES.length) return null;
  const result = [];
  for (const capability of value) {
    if (!CODEBASE_CAPABILITIES.includes(capability) || result.includes(capability)) return null;
    result.push(capability);
  }
  return result;
}

function normalizePermissions(value, capabilities) {
  if (!isPlainObject(value) || Object.keys(value).some(key => !PERMISSION_FLAG_SET.has(key))) return null;
  const permissions = Object.create(null);
  for (const capability of CODEBASE_CAPABILITIES) {
    if (value[capability] !== undefined && typeof value[capability] !== "boolean") return null;
    permissions[capability] = value[capability] === true;
  }
  if (capabilities.some(capability => permissions[capability] !== true)) return null;
  return permissions;
}

/** Validate a complete declaration before any capability is considered. */
export function validateCapabilityDeclaration(input) {
  if (!isPlainObject(input) || !validKeys(input, DECLARATION_FIELDS)) return invalid("invalid_declaration");
  if (input.contractVersion !== CODEBASE_ADAPTER_VERSION) return invalid("unsupported_contract");
  const declared = input.capabilities ?? input.declaredCapabilities;
  const capabilities = normalizeCapabilities(declared);
  if (!capabilities) return invalid("invalid_capabilities");
  if (input.capabilities !== undefined && input.declaredCapabilities !== undefined &&
      JSON.stringify(input.capabilities) !== JSON.stringify(input.declaredCapabilities)) {
    return invalid("capability_declaration_mismatch");
  }
  const permissions = normalizePermissions(input.permissions, capabilities);
  if (!permissions) return invalid("permission_required", "Every declared capability needs an explicit true permission flag.");
  const scope = normalizeScope(input.scope);
  if (!scope) return invalid("invalid_scope", "A non-empty, relative include scope is required.");
  const bounds = normalizeBounds(input.bounds);
  if (!bounds) return invalid("invalid_bounds");
  if ((input.allowWrites !== undefined && typeof input.allowWrites !== "boolean") ||
      (input.allowDeploys !== undefined && typeof input.allowDeploys !== "boolean")) {
    return invalid("invalid_declaration", "Write and deploy flags must be boolean.");
  }
  if (input.allowWrites === true || input.allowDeploys === true) {
    return invalid("write_or_deploy_not_allowed", "This adapter is read-only and cannot authorize writes or deploys.");
  }
  return {
    ok: true,
    value: Object.freeze({
      contractVersion: CODEBASE_ADAPTER_VERSION,
      capabilities,
      declaredCapabilities: capabilities,
      permissions,
      scope,
      bounds,
      allowWrites: false,
      allowDeploys: false
    })
  };
}

function pathWithinScope(path, scope) {
  if (!path || isSensitivePath(path)) return false;
  const included = scope.include.some(prefix => prefix === "." || path === prefix || path.startsWith(`${prefix}/`));
  const excluded = scope.exclude.some(prefix => path === prefix || path.startsWith(`${prefix}/`));
  return included && !excluded;
}

function operationFields(capability) {
  if (capability === "searchCode") return new Set(["path", "query"]);
  if (capability === "inspectGitDiff") return new Set(["path", "base"]);
  if (capability === "inspectPackageManifest") return new Set(["path"]);
  if (capability === "readFile") return new Set(["path"]);
  if (capability === "listFiles") return new Set(["path"]);
  if (EXECUTION_CAPABILITY_SET.has(capability)) return new Set(["target"]);
  return new Set();
}

function normalizeOperationArgs(capability, input) {
  if (!isPlainObject(input) || !validKeys(input, operationFields(capability))) return null;
  const args = {};
  if (PATH_CAPABILITIES.has(capability)) {
    if ((capability === "readFile" || capability === "inspectPackageManifest") && input.path === undefined) return null;
    const path = input.path === undefined ? "." : normalizeRelativePath(input.path);
    if (!path || isSensitivePath(path)) return null;
    args.path = path;
  }
  if (capability === "searchCode") {
    if (!boundedString(input.query, 400, false)) return null;
    args.query = input.query;
  }
  if (capability === "inspectGitDiff" && input.base !== undefined) {
    if (!boundedString(input.base, 160, false) || /[\r\n;&|`$<>]/.test(input.base)) return null;
    args.base = input.base;
  }
  if (EXECUTION_CAPABILITY_SET.has(capability) && input.target !== undefined) {
    if (!boundedString(input.target, 200, false) || /[\r\n;&|`$<>]/.test(input.target)) return null;
    args.target = input.target;
  }
  if (capability === "inspectPackageManifest") {
    const name = args.path.split("/").at(-1);
    if (!PACKAGE_MANIFEST_NAMES.has(name)) return null;
  }
  return args;
}

/** Validate one requested operation against its declared permissions/scope. */
export function validateCapabilityRequest(input) {
  if (!isPlainObject(input) || !isPlainObject(input.declaration) ||
      !boundedString(input.capability, 80, false)) return invalid("invalid_request");
  if (Object.keys(input).some(key => !new Set(["declaration", "capability", "args"]).has(key))) return invalid("invalid_request");
  const declaration = validateCapabilityDeclaration(input.declaration);
  if (!declaration.ok) return declaration;
  const { capability } = input;
  if (!CODEBASE_CAPABILITIES.includes(capability) || !declaration.value.capabilities.includes(capability)) {
    return invalid("capability_not_declared");
  }
  if (declaration.value.permissions[capability] !== true) return invalid("permission_required");
  const args = normalizeOperationArgs(capability, input.args ?? {});
  if (!args) return invalid("invalid_arguments");
  if (args.path && !pathWithinScope(args.path, declaration.value.scope)) {
    return invalid("outside_scope", "The requested path is outside the declared scope or is protected.");
  }
  return { ok: true, value: Object.freeze({ declaration: declaration.value, capability, args }) };
}

export const validateCodebaseAdapterRequest = validateCapabilityRequest;
export const validateDeclaredCapabilities = validateCapabilityDeclaration;

function safeJsonSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return Infinity;
  }
}

function containsCredentialMaterial(value) {
  if (typeof value !== "string") return false;
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,}]+|Bearer\s+[A-Za-z0-9._-]{8,}/i.test(value);
}

function validateOutput(value, maxBytes) {
  if (safeJsonSize(value) > maxBytes) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return !containsCredentialMaterial(text);
}

export function createEvidenceReceipt({
  capability,
  status,
  provenance,
  summary,
  scope,
  bounds = DEFAULT_BOUNDS,
  output,
  reasonCode,
  id = `r_${randomUUID()}`,
  observedAt = new Date().toISOString()
}) {
  const receipt = {
    receiptVersion: CODEBASE_ADAPTER_VERSION,
    id,
    capability,
    status,
    provenance,
    summary,
    scope,
    bounds,
    observedAt,
    ...(output !== undefined ? { output } : {}),
    ...(reasonCode !== undefined ? { reasonCode } : {})
  };
  const validation = validateEvidenceReceipt(receipt);
  if (!validation.ok) throw new TypeError(validation.message);
  return validation.value;
}

export function createBlockedReceipt({ capability, declaration, reasonCode, summary }) {
  return createEvidenceReceipt({
    capability,
    status: "blocked",
    provenance: "tool-observed",
    summary: summary || "The adapter blocked this operation before any codebase or command access.",
    scope: declaration?.scope || { root: "unavailable", include: ["."], exclude: [] },
    bounds: declaration?.bounds || DEFAULT_BOUNDS,
    reasonCode: reasonCode || "blocked_by_boundary"
  });
}

/** Validate a receipt without treating it as proof of implementation. */
export function validateEvidenceReceipt(input) {
  if (!isPlainObject(input) || !validKeys(input, RECEIPT_FIELDS)) return invalid("invalid_receipt");
  if (input.receiptVersion !== CODEBASE_ADAPTER_VERSION ||
      !/^r_[A-Za-z0-9_-]{8,100}$/.test(input.id) ||
      !CODEBASE_CAPABILITIES.includes(input.capability) ||
      !RECEIPT_STATUS.includes(input.status) || !EVIDENCE_PROVENANCE.includes(input.provenance) ||
      !boundedString(input.summary, 2_000, false) || !boundedString(input.observedAt, 80, false)) {
    return invalid("invalid_receipt");
  }
  const scope = normalizeScope(input.scope);
  const bounds = normalizeBounds(input.bounds);
  if (!scope || !bounds) return invalid("invalid_receipt");
  if (input.reasonCode !== undefined && !boundedString(input.reasonCode, 120, false)) return invalid("invalid_receipt");
  if (input.output !== undefined && !validateOutput(input.output, bounds.maxOutputBytes)) {
    return invalid("unsafe_or_oversized_output", "Receipt output is oversized or contains protected credential material.");
  }
  return { ok: true, value: Object.freeze({ ...input, scope, bounds }) };
}

export const validateReceipt = validateEvidenceReceipt;

export function supportsSafeRunner(runner) {
  return isPlainObject(runner) && runner.kind === SAFE_RUNNER_VERSION && runner.readOnly === true &&
    runner.allowWrites !== true && runner.allowDeploys !== true && typeof runner.runCapability === "function";
}

/**
 * Plan-only by default. An actual runner must opt into a named, read-only
 * protocol; arbitrary command strings are never accepted by this module.
 */
export async function executeCapabilityRequest(input, { runner } = {}) {
  const validation = validateCapabilityRequest(input);
  if (!validation.ok) {
    return { ok: false, receipt: createBlockedReceipt({ capability: input?.capability || "listFiles", reasonCode: validation.code, summary: validation.message }) };
  }
  const request = validation.value;
  if (!supportsSafeRunner(runner)) {
    return { ok: false, receipt: createBlockedReceipt({ capability: request.capability, declaration: request.declaration, reasonCode: "safe_runner_required" }) };
  }
  try {
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ timedOut: true }), request.declaration.bounds.timeoutMs);
      timer.unref?.();
    });
    const result = await Promise.race([Promise.resolve().then(() => runner.runCapability(request)), timeout]);
    if (timer) clearTimeout(timer);
    if (result?.timedOut) {
      return { ok: false, receipt: createBlockedReceipt({ capability: request.capability, declaration: request.declaration, reasonCode: "timeout", summary: "The safe runner exceeded the declared time bound." }) };
    }
    const receipt = validateEvidenceReceipt(result);
    if (!receipt.ok) {
      return { ok: false, receipt: createBlockedReceipt({ capability: request.capability, declaration: request.declaration, reasonCode: "invalid_runner_receipt", summary: "The safe runner returned an invalid evidence receipt." }) };
    }
    const observed = receipt.value;
    const requestScope = JSON.stringify(request.declaration.scope);
    const observedScope = JSON.stringify(observed.scope);
    if (observed.capability !== request.capability || observedScope !== requestScope ||
        observed.bounds.timeoutMs > request.declaration.bounds.timeoutMs ||
        observed.bounds.maxOutputBytes > request.declaration.bounds.maxOutputBytes ||
        observed.bounds.maxResults > request.declaration.bounds.maxResults) {
      return { ok: false, receipt: createBlockedReceipt({ capability: request.capability, declaration: request.declaration, reasonCode: "runner_bounds_exceeded", summary: "The safe runner returned evidence outside the requested bounds." }) };
    }
    return { ok: true, receipt: observed };
  } catch {
    return {
      ok: false,
      receipt: createEvidenceReceipt({
        capability: request.capability,
        status: "fail",
        provenance: "tool-observed",
        summary: "The safe runner failed without exposing its error details.",
        scope: request.declaration.scope,
        bounds: request.declaration.bounds,
        reasonCode: "runner_failed"
      })
    };
  }
}

export const requestCapability = executeCapabilityRequest;
