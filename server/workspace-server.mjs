import http from "node:http";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOST,
  AGENT_ANALYSIS_PATH,
  LOCAL_GUIDANCE_PATH,
  HEALTH_PATH,
  MAX_REQUEST_BYTES,
  MENTOR_PATH,
  CHATBASE_MENTOR_PATH,
  GENERIC_MENTOR_PATH,
  getConfig,
  handleAgentAnalysis,
  handleLocalGuidance,
  handleChatbaseMentor,
  handleGenericMentor,
  handleMentor
} from "./openrouter-proxy.mjs";

export const DEFAULT_WEB_PORT = 4173;
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const DEFAULT_DATA_DIR = path.join(fileURLToPath(new URL("../", import.meta.url)), ".bob");
export const WORKSPACE_BODY_MAX_BYTES = MAX_REQUEST_BYTES;

const require = createRequire(import.meta.url);
const workspaceModel = require("../web/project.js");
const WORKSPACE_ROUTE_PREFIX = "/api/workspaces/";
const WORKSPACE_FILE_SUFFIX = ".json";
const WORKSPACE_TOP_LEVEL_FIELDS = new Set([
  "schemaVersion", "id", "name", "createdAt", "updatedAt", "nextSequence",
  "messages", "sources", "memory", "projectSources", "scope", "scopeSource", "checks"
]);
const MESSAGE_FIELDS = new Set(["id", "role", "text", "source", "createdAt"]);
const CHECK_FIELDS = new Set(["id", "checked", "reported", "scope", "source", "updatedAt"]);
const SCOPE_SOURCE_FIELDS = new Set([
  "kind", "messageId", "role", "source", "reference", "label", "retained", "updatedAt"
]);
const DATA_DIR_ERROR = "BOB_DATA_DIR must identify a safe local directory.";

// These are the entire public filesystem surface. Never resolve a request URL
// into a filesystem path or fall back to serving the repository root.
export const STATIC_ROUTES = Object.freeze({
  "/": "web/index.html",
  "/index.html": "web/index.html",
  "/styles.css": "web/styles.css",
  "/app.js": "web/app.js",
  "/project.js": "web/project.js",
  "/core.js": "src/core.js",
  "/widget-demo.html": "integrations/widget/demo.html",
  "/bob-agent-widget.js": "integrations/widget/bob-agent-widget.js"
});

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
});
const SECURITY_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join("; ")
});

export function getWorkspaceConfig(env = process.env) {
  const raw = env.BOB_WEB_PORT === undefined || env.BOB_WEB_PORT === ""
    ? String(DEFAULT_WEB_PORT)
    : String(env.BOB_WEB_PORT).trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("BOB_WEB_PORT must be an integer from 0 to 65535.");
  }
  // The extension's BOB_PORT setting is independent of the workspace listener.
  const { model, apiKey, chatbaseSecret, genericSecret } = getConfig({
    OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    BOB_CHATBASE_SHARED_SECRET: env.BOB_CHATBASE_SHARED_SECRET,
    BOB_MENTOR_SHARED_SECRET: env.BOB_MENTOR_SHARED_SECRET,
    BOB_GENERIC_SHARED_SECRET: env.BOB_GENERIC_SHARED_SECRET
  });
  const config = { host: DEFAULT_HOST, port, model, apiKey };
  Object.defineProperty(config, "chatbaseSecret", { value: chatbaseSecret, enumerable: false });
  Object.defineProperty(config, "genericSecret", { value: genericSecret, enumerable: false });
  // Keep the original enumerable config shape stable for callers that expose
  // it, while making the local persistence location available to the listener.
  Object.defineProperty(config, "dataDir", { value: getWorkspaceDataDir(env), enumerable: false });
  return config;
}

export function getWorkspaceDataDir(env = process.env) {
  const raw = env.BOB_DATA_DIR === undefined || env.BOB_DATA_DIR === ""
    ? ""
    : String(env.BOB_DATA_DIR).trim();
  if (!raw) return DEFAULT_DATA_DIR;
  if (raw.includes("\0")) throw new Error(DATA_DIR_ERROR);

  const candidate = path.resolve(ROOT, raw);
  // Relative configuration is intentionally confined to the repository. An
  // explicit absolute path is allowed for a local test/runtime directory; no
  // request value ever reaches this function.
  if (!path.isAbsolute(raw)) {
    const relative = path.relative(ROOT, candidate);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(DATA_DIR_ERROR);
    }
  }
  const root = path.parse(candidate).root;
  if (candidate === root || candidate === ROOT) throw new Error(DATA_DIR_ERROR);
  return candidate;
}

function headerCount(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function allowedRequestOrigin(req) {
  const host = req.headers.host;
  const port = req.socket.localPort;
  if (req.socket.localAddress !== DEFAULT_HOST || typeof host !== "string" || headerCount(req, "host") !== 1) return null;
  const authority = host.toLowerCase();
  const allowedHosts = [`${DEFAULT_HOST}:${port}`, `localhost:${port}`];
  if (port === 80) allowedHosts.push(DEFAULT_HOST, "localhost");
  if (!allowedHosts.includes(authority)) return null;
  return new URL(`http://${authority}`).origin;
}

function sendJson(req, res, status, body) {
  if (res.headersSent) return;
  const encoded = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(encoded)
  });
  res.end(req.method === "HEAD" ? undefined : encoded);
}

function sendError(req, res, status, code, message) {
  sendJson(req, res, status, { error: { code, message } });
}

function sendText(req, res, status, body, contentType, extraHeaders = {}) {
  if (res.headersSent) return;
  const encoded = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": encoded.byteLength,
    ...extraHeaders
  });
  res.end(req.method === "HEAD" ? undefined : encoded);
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function knownKeys(value, allowed) {
  return isPlainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function boundedString(value, max) {
  return typeof value === "string" && value.length <= max;
}

function validMessageRecord(value, { source = false } = {}) {
  if (!knownKeys(value, MESSAGE_FIELDS) || typeof value.id !== "string" ||
      !/^m[1-9][0-9]{0,15}$/.test(value.id) ||
      !Number.isSafeInteger(Number(value.id.slice(1))) ||
      (source ? value.role !== "user" : value.role !== "user" && value.role !== "assistant") ||
      !boundedString(value.text, workspaceModel.MAX_TEXT_LENGTH)) return false;
  if (Object.hasOwn(value, "source") && !boundedString(value.source, 80)) return false;
  if (Object.hasOwn(value, "createdAt") && !boundedString(value.createdAt, 80)) return false;
  return true;
}

function validCheckRecord(value) {
  if (!knownKeys(value, CHECK_FIELDS) || typeof value.id !== "string" || value.id.length > 80) return false;
  if (Object.hasOwn(value, "checked") && typeof value.checked !== "boolean") return false;
  if (Object.hasOwn(value, "reported") && typeof value.reported !== "boolean") return false;
  if (Object.hasOwn(value, "scope") && !["demo", "production", "unspecified"].includes(value.scope)) return false;
  if (Object.hasOwn(value, "source") && !boundedString(value.source, 80)) return false;
  if (Object.hasOwn(value, "updatedAt") && !boundedString(value.updatedAt, 80)) return false;
  return true;
}

function validScopeSource(value) {
  if (!isPlainObject(value) || !knownKeys(value, SCOPE_SOURCE_FIELDS)) return false;
  for (const key of ["kind", "role", "source", "reference", "label", "updatedAt"]) {
    if (Object.hasOwn(value, key) && !boundedString(value[key], 180)) return false;
  }
  if (Object.hasOwn(value, "messageId") && value.messageId !== null && !boundedString(value.messageId, 80)) return false;
  if (Object.hasOwn(value, "retained") && typeof value.retained !== "boolean") return false;
  return true;
}

/**
 * Validate the input envelope before restoreWorkspace canonicalizes it. The
 * model intentionally discards derived fields, but persistence still rejects
 * unknown top-level state and records that would exceed model bounds.
 */
export function validateWorkspaceState(input, routeId) {
  if (!isPlainObject(input) || !knownKeys(input, WORKSPACE_TOP_LEVEL_FIELDS)) return false;
  if (input.schemaVersion !== workspaceModel.SCHEMA_VERSION || input.id !== routeId ||
      !WORKSPACE_ID_PATTERN.test(routeId) || !Array.isArray(input.messages) ||
      input.messages.length > workspaceModel.MAX_MESSAGES) return false;
  if (Object.hasOwn(input, "name") && !boundedString(input.name, 120)) return false;
  for (const key of ["createdAt", "updatedAt"]) {
    if (Object.hasOwn(input, key) && !boundedString(input[key], 80)) return false;
  }
  if (Object.hasOwn(input, "nextSequence") &&
      (!Number.isSafeInteger(input.nextSequence) || input.nextSequence < 1 || input.nextSequence >= Number.MAX_SAFE_INTEGER - 1)) return false;
  if (Object.hasOwn(input, "sources")) {
    if (!Array.isArray(input.sources) || input.sources.length > workspaceModel.MAX_SOURCES ||
        !input.sources.every(item => validMessageRecord(item, { source: true }))) return false;
  }
  if (!input.messages.every(item => validMessageRecord(item))) return false;
  if (Object.hasOwn(input, "memory") && !isPlainObject(input.memory)) return false;
  if (Object.hasOwn(input, "projectSources") && !isPlainObject(input.projectSources)) return false;
  if (Object.hasOwn(input, "scope") && !["demo", "production", "unspecified"].includes(input.scope)) return false;
  if (Object.hasOwn(input, "scopeSource") && input.scopeSource !== null && !validScopeSource(input.scopeSource)) return false;
  if (Object.hasOwn(input, "checks")) {
    if (!Array.isArray(input.checks) || input.checks.length > workspaceModel.CHECK_DEFINITIONS.length ||
        !input.checks.every(validCheckRecord)) return false;
  }
  return true;
}

function workspaceDirectory(dataDir) {
  return path.join(dataDir, "workspaces");
}

function workspaceFile(dataDir, id) {
  return path.join(workspaceDirectory(dataDir), `${id}${WORKSPACE_FILE_SUFFIX}`);
}

async function safeDirectory(dataDir, create) {
  const target = workspaceDirectory(dataDir);
  const root = path.parse(target).root;
  const relative = path.relative(root, target);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error?.code !== "ENOENT" || !create) return false;
      await mkdir(current, { mode: 0o700 });
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
  }
  return target;
}

async function readWorkspace(dataDir, id) {
  const directory = await safeDirectory(dataDir, false);
  if (!directory) return { kind: "missing" };
  const file = workspaceFile(dataDir, id);
  let stat;
  try {
    stat = await lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > WORKSPACE_BODY_MAX_BYTES) return { kind: "invalid" };
    const text = await readFile(file, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: "invalid" };
    }
    if (!validateWorkspaceState(parsed, id)) return { kind: "invalid" };
    const restored = workspaceModel.restoreWorkspace(parsed);
    if (!restored) return { kind: "invalid" };
    return { kind: "ok", state: restored };
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") return { kind: "missing" };
    return { kind: "error" };
  }
}

async function replaceWorkspace(dataDir, id, state) {
  const directory = await safeDirectory(dataDir, true);
  if (!directory) throw new Error("Workspace directory is not safe.");
  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded, "utf8") > WORKSPACE_BODY_MAX_BYTES) throw new Error("Workspace is too large.");
  const file = workspaceFile(dataDir, id);
  const temp = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temp, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
}

async function removeWorkspace(dataDir, id) {
  const directory = await safeDirectory(dataDir, false);
  if (!directory) return;
  const file = workspaceFile(dataDir, id);
  try {
    const stat = await lstat(file);
    if (stat.isDirectory()) throw new Error("Workspace path is not a file.");
    await unlink(file);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw error;
  }
}

function parseWorkspaceRoute(pathname) {
  if (!pathname.startsWith(WORKSPACE_ROUTE_PREFIX)) return null;
  const parts = pathname.slice(WORKSPACE_ROUTE_PREFIX.length).split("/");
  const id = parts[0];
  if (!WORKSPACE_ID_PATTERN.test(id)) return { kind: "invalid" };
  if (parts.length === 1) return { kind: "workspace", id };
  if (parts.length === 2 && parts[1] === "export.md") return { kind: "export", id };
  return { kind: "invalid" };
}

async function handleWorkspaceRoute(req, res, config, route) {
  if (route.kind === "invalid") {
    sendError(req, res, 400, "invalid_workspace_id", "Workspace route is invalid.");
    return;
  }

  if (route.kind === "export") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendError(req, res, 405, "method_not_allowed", "Use GET.");
      return;
    }
    const loaded = await readWorkspace(config.dataDir, route.id);
    if (loaded.kind === "missing") {
      sendError(req, res, 404, "workspace_not_found", "Workspace was not found.");
      return;
    }
    if (loaded.kind !== "ok") {
      sendError(req, res, 422, "invalid_workspace", "Workspace data is invalid.");
      return;
    }
    sendText(req, res, 200, workspaceModel.exportMarkdown(loaded.state), "text/markdown; charset=utf-8", {
      "Content-Disposition": `attachment; filename="bob-workspace-${route.id}.md"`
    });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    const loaded = await readWorkspace(config.dataDir, route.id);
    if (loaded.kind === "missing") {
      sendError(req, res, 404, "workspace_not_found", "Workspace was not found.");
      return;
    }
    if (loaded.kind !== "ok") {
      sendError(req, res, 422, "invalid_workspace", "Workspace data is invalid.");
      return;
    }
    sendJson(req, res, 200, loaded.state);
    return;
  }

  if (req.method === "DELETE") {
    await removeWorkspace(config.dataDir, route.id);
    res.writeHead(204, { "Content-Length": "0" });
    res.end();
    return;
  }

  if (req.method !== "PUT") {
    res.setHeader("Allow", "GET, HEAD, PUT, DELETE");
    sendError(req, res, 405, "method_not_allowed", "Use GET, PUT, or DELETE.");
    return;
  }

  const type = String(req.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase();
  if (type !== "application/json") {
    sendError(req, res, 415, "unsupported_media_type", "Use application/json.");
    return;
  }
  let bodyText;
  try {
    const contentLength = Number(req.headers["content-length"]);
    if (Number.isFinite(contentLength) && contentLength > WORKSPACE_BODY_MAX_BYTES) throw new Error("too_large");
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      total += Buffer.byteLength(chunk);
      if (total > WORKSPACE_BODY_MAX_BYTES) throw new Error("too_large");
      chunks.push(chunk);
    }
    bodyText = Buffer.concat(chunks).toString("utf8");
  } catch (error) {
    req.resume();
    if (error?.message === "too_large") {
      sendError(req, res, 413, "payload_too_large", "Workspace request is too large.");
    } else {
      sendError(req, res, 400, "invalid_request", "Workspace request is invalid.");
    }
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    sendError(req, res, 400, "invalid_json", "Workspace must contain valid JSON.");
    return;
  }
  if (!validateWorkspaceState(parsed, route.id)) {
    sendError(req, res, 400, "invalid_workspace", "Workspace data is invalid.");
    return;
  }
  const restored = workspaceModel.restoreWorkspace(parsed);
  if (!restored) {
    sendError(req, res, 400, "invalid_workspace", "Workspace data is invalid.");
    return;
  }
  try {
    await replaceWorkspace(config.dataDir, route.id, restored);
  } catch {
    sendError(req, res, 500, "storage_error", "Workspace could not be saved.");
    return;
  }
  sendJson(req, res, 200, restored);
}

async function routeRequest(req, res, config, fetchImpl) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  const expectedOrigin = allowedRequestOrigin(req);
  if (!expectedOrigin) {
    sendError(req, res, 403, "host_not_allowed", "Host is not allowed.");
    return;
  }

  const origin = req.headers.origin;
  const readOnly = req.method === "GET" || req.method === "HEAD";
  const serverToServerIntegration = [CHATBASE_MENTOR_PATH, GENERIC_MENTOR_PATH].includes((req.url || "").split("?", 1)[0]);
  // A missing Origin is useful for navigation and local health checks, but
  // never authorizes a cloud request. Aliases must still match the Host used.
  if (headerCount(req, "origin") > 1 || (origin !== undefined && origin !== expectedOrigin) || (!readOnly && origin !== expectedOrigin && !(serverToServerIntegration && origin === undefined))) {
    sendError(req, res, 403, "origin_not_allowed", "A same-origin request is required.");
    return;
  }

  // Match the raw origin-form path, not a URL-normalized or decoded path. This
  // also rejects encoded traversal, backslashes and absolute-form targets.
  const target = req.url || "/";
  if (!target.startsWith("/") || target.includes("#")) {
    sendError(req, res, 400, "invalid_request", "Invalid request.");
    return;
  }
  const pathname = target.split("?", 1)[0];

  const workspaceRoute = parseWorkspaceRoute(pathname);
  if (workspaceRoute) {
    await handleWorkspaceRoute(req, res, config, workspaceRoute);
    return;
  }

  if (pathname === HEALTH_PATH && readOnly) {
    sendJson(req, res, 200, { ok: true, providerConfigured: Boolean(config.apiKey), model: config.model });
    return;
  }

  if ([MENTOR_PATH, AGENT_ANALYSIS_PATH, LOCAL_GUIDANCE_PATH, CHATBASE_MENTOR_PATH, GENERIC_MENTOR_PATH].includes(pathname)) {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { Allow: "POST, OPTIONS" });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS");
      sendError(req, res, 405, "method_not_allowed", "Use POST.");
      return;
    }
    const handler = pathname === AGENT_ANALYSIS_PATH
      ? handleAgentAnalysis
      : pathname === LOCAL_GUIDANCE_PATH ? handleLocalGuidance
        : pathname === CHATBASE_MENTOR_PATH ? handleChatbaseMentor
          : pathname === GENERIC_MENTOR_PATH ? handleGenericMentor : handleMentor;
    await handler(req, res, null, config, fetchImpl);
    return;
  }

  const relativePath = Object.hasOwn(STATIC_ROUTES, pathname) ? STATIC_ROUTES[pathname] : null;
  if (!relativePath) {
    sendError(req, res, 404, "not_found", "Not found.");
    return;
  }
  if (!readOnly) {
    res.setHeader("Allow", "GET, HEAD");
    sendError(req, res, 405, "method_not_allowed", "Use GET or HEAD.");
    return;
  }

  let content;
  try {
    const filePath = path.join(ROOT, relativePath);
    const stat = await lstat(filePath);
    // A fixed allowlist is still not permission to follow a replacement
    // symlink into a private file.
    if (!stat.isFile() || stat.isSymbolicLink()) {
      sendError(req, res, 404, "not_found", "Not found.");
      return;
    }
    content = await readFile(filePath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") {
      sendError(req, res, 404, "not_found", "Not found.");
      return;
    }
    throw error;
  }
  res.writeHead(200, {
    "Content-Type": CONTENT_TYPES[path.extname(relativePath)],
    "Content-Length": content.byteLength
  });
  res.end(req.method === "HEAD" ? undefined : content);
}

export function createWorkspaceServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getWorkspaceConfig(env);
  return http.createServer((req, res) => {
    routeRequest(req, res, config, fetchImpl).catch(() => {
      sendError(req, res, 500, "internal_error", "The server could not complete the request.");
    });
  });
}

export function startWorkspaceServer({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const config = getWorkspaceConfig(env);
  const server = createWorkspaceServer({ env, fetchImpl });
  return new Promise((resolve, reject) => {
    const onError = error => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve({ server, host: config.host, port: address.port });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  startWorkspaceServer()
    .then(({ host, port }) => {
      console.log(`Bob workspace listening on http://${host}:${port}`);
    })
    .catch(error => {
      if (error && error.code === "EADDRINUSE") {
        console.error("Bob workspace could not start: port 4173 is already in use. Open http://127.0.0.1:4173 or set BOB_WEB_PORT to another port.");
      } else {
        console.error("Bob workspace could not start: " + (error && error.message ? error.message : "unknown startup error") + ".");
      }
      process.exitCode = 1;
    });
}
