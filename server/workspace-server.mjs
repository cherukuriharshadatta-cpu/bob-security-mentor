import http from "node:http";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HOST,
  HEALTH_PATH,
  MENTOR_PATH,
  getConfig,
  handleMentor
} from "./openrouter-proxy.mjs";

export const DEFAULT_WEB_PORT = 4173;

// These are the entire public filesystem surface. Never resolve a request URL
// into a filesystem path or fall back to serving the repository root.
export const STATIC_ROUTES = Object.freeze({
  "/": "web/index.html",
  "/index.html": "web/index.html",
  "/styles.css": "web/styles.css",
  "/app.js": "web/app.js",
  "/project.js": "web/project.js",
  "/core.js": "src/core.js"
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
  const { model, apiKey } = getConfig({
    OPENROUTER_MODEL: env.OPENROUTER_MODEL,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY
  });
  return { host: DEFAULT_HOST, port, model, apiKey };
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

async function routeRequest(req, res, config, fetchImpl) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

  const expectedOrigin = allowedRequestOrigin(req);
  if (!expectedOrigin) {
    sendError(req, res, 403, "host_not_allowed", "Host is not allowed.");
    return;
  }

  const origin = req.headers.origin;
  const readOnly = req.method === "GET" || req.method === "HEAD";
  // A missing Origin is useful for navigation and local health checks, but
  // never authorizes a cloud request. Aliases must still match the Host used.
  if (headerCount(req, "origin") > 1 || (origin !== undefined && origin !== expectedOrigin) || (!readOnly && origin !== expectedOrigin)) {
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

  if (pathname === HEALTH_PATH && readOnly) {
    sendJson(req, res, 200, { ok: true, providerConfigured: Boolean(config.apiKey), model: config.model });
    return;
  }

  if (pathname === MENTOR_PATH) {
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
    await handleMentor(req, res, null, config, fetchImpl);
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
    .catch(() => {
      console.error("Bob workspace could not start.");
      process.exitCode = 1;
    });
}
