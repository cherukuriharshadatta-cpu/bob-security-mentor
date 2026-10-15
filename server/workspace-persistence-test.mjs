import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  MAX_REQUEST_BYTES
} from "./openrouter-proxy.mjs";
import {
  startWorkspaceServer,
  getWorkspaceConfig,
  getWorkspaceDataDir
} from "./workspace-server.mjs";

const require = createRequire(import.meta.url);
const workspaceModel = require("../web/project.js");

async function close(server) {
  if (!server.listening) return;
  await new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  });
}

async function responseJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

let checks = 0;
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}

const dataDir = await mkdtemp(path.join(os.tmpdir(), "bob-workspace-test-"));
const state = workspaceModel.createWorkspace({
  id: "timer-demo",
  name: "Timer demo",
  brief: "Goal: Build a timer for a private demo.",
  now: "2026-01-01T00:00:00.000Z"
});
const canonicalState = workspaceModel.restoreWorkspace(state);
const { server, host, port } = await startWorkspaceServer({
  env: { BOB_WEB_PORT: "0", BOB_DATA_DIR: dataDir },
  fetchImpl: async () => { throw new Error("Unexpected provider call."); }
});
const base = `http://${host}:${port}`;
const workspaceUrl = `${base}/api/workspaces/${state.id}`;

try {
  await check("BOB_DATA_DIR is explicit and relative paths stay in the repository", () => {
    assert.equal(getWorkspaceConfig({ BOB_DATA_DIR: dataDir }).dataDir, dataDir);
    assert.equal(getWorkspaceDataDir({}), path.join(process.cwd(), ".bob"));
    assert.throws(() => getWorkspaceDataDir({ BOB_DATA_DIR: "../outside" }), /safe local directory/);
  });

  await check("missing workspaces use a safe 404 and do not create repository files", async () => {
    const response = await fetch(workspaceUrl);
    assert.equal(response.status, 404);
    assert.deepEqual(await responseJson(response), {
      error: { code: "workspace_not_found", message: "Workspace was not found." }
    });
    await assert.rejects(() => stat(path.join(dataDir, "workspaces")), error => error?.code === "ENOENT");
  });

  await check("PUT replaces through restoreWorkspace and GET loads the canonical state", async () => {
    const response = await fetch(workspaceUrl, {
      method: "PUT",
      headers: { Origin: base, "content-type": "application/json" },
      body: JSON.stringify(state)
    });
    assert.equal(response.status, 200);
    const saved = await responseJson(response);
    assert.deepEqual(saved, canonicalState);

    const file = path.join(dataDir, "workspaces", `${state.id}.json`);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), canonicalState);
    assert.deepEqual(await readdir(path.join(dataDir, "workspaces")), [`${state.id}.json`]);

    const loadedResponse = await fetch(workspaceUrl);
    assert.equal(loadedResponse.status, 200);
    assert.deepEqual(await responseJson(loadedResponse), canonicalState);
  });

  await check("export returns only the restored workspace as Markdown", async () => {
    const response = await fetch(`${workspaceUrl}/export.md`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/markdown; charset=utf-8");
    assert.equal(response.headers.get("content-disposition"), 'attachment; filename="bob-workspace-timer-demo.md"');
    const text = await response.text();
    assert.match(text, /^# Bob workspace: Timer demo/m);
    assert.match(text, /Goal: Build a timer/);
  });

  await check("unknown, malformed and oversized workspace state is rejected without replacement", async () => {
    const unknown = { ...state, unexpected: "not persisted" };
    const unknownResponse = await fetch(workspaceUrl, {
      method: "PUT", headers: { Origin: base, "content-type": "application/json" }, body: JSON.stringify(unknown)
    });
    assert.equal(unknownResponse.status, 400);
    assert.equal((await responseJson(unknownResponse)).error.code, "invalid_workspace");

    const malformedResponse = await fetch(workspaceUrl, {
      method: "PUT", headers: { Origin: base, "content-type": "application/json" }, body: "{"
    });
    assert.equal(malformedResponse.status, 400);
    assert.equal((await responseJson(malformedResponse)).error.code, "invalid_json");

    const oversizedResponse = await fetch(workspaceUrl, {
      method: "PUT", headers: { Origin: base, "content-type": "application/json" }, body: "x".repeat(MAX_REQUEST_BYTES + 1)
    });
    assert.equal(oversizedResponse.status, 413);
    assert.equal((await responseJson(oversizedResponse)).error.code, "payload_too_large");

    const loadedResponse = await fetch(workspaceUrl);
    assert.deepEqual(await responseJson(loadedResponse), canonicalState);
  });

  await check("writes require same-origin JSON and unsafe routes never reach storage", async () => {
    const absentOrigin = await fetch(workspaceUrl, {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(state)
    });
    assert.equal(absentOrigin.status, 403);
    assert.equal((await responseJson(absentOrigin)).error.code, "origin_not_allowed");

    const unsafe = await fetch(`${base}/api/workspaces/%2e%2e%2fprivate`);
    assert.equal(unsafe.status, 400);
    assert.equal((await responseJson(unsafe)).error.code, "invalid_workspace_id");

    for (const route of ["/.bob/workspaces/timer-demo.json", "/.bob/", "/server/workspace-server.mjs"]) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 404, route);
    }
  });

  await check("DELETE removes the workspace and is idempotent", async () => {
    const first = await fetch(workspaceUrl, { method: "DELETE", headers: { Origin: base } });
    assert.equal(first.status, 204);
    assert.equal(await first.text(), "");
    const second = await fetch(workspaceUrl, { method: "DELETE", headers: { Origin: base } });
    assert.equal(second.status, 204);
    const loaded = await fetch(workspaceUrl);
    assert.equal(loaded.status, 404);
  });
} finally {
  await close(server);
  await rm(dataDir, { recursive: true, force: true });
}

console.log(`\n${checks} workspace persistence checks passed. No payloads were logged.`);
