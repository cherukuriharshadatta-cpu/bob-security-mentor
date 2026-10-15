import assert from "node:assert/strict";
import {
  CODEBASE_ADAPTER_VERSION,
  CODEBASE_CAPABILITIES,
  DEFAULT_BOUNDS,
  EVIDENCE_PROVENANCE,
  RECEIPT_STATUS,
  createBlockedReceipt,
  createEvidenceReceipt,
  executeCapabilityRequest,
  isSensitivePath,
  normalizeRelativePath,
  supportsSafeRunner,
  validateCapabilityDeclaration,
  validateCapabilityRequest,
  validateEvidenceReceipt
} from "./codebase-adapter.mjs";

const scope = { root: "C:/workspace/ai-mentor", include: ["src", "tests", "package.json"], exclude: [] };
const capabilities = [...CODEBASE_CAPABILITIES];
const permissions = Object.fromEntries(capabilities.map(capability => [capability, true]));
const declaration = {
  contractVersion: CODEBASE_ADAPTER_VERSION,
  capabilities,
  permissions,
  scope,
  bounds: { timeoutMs: 5_000, maxOutputBytes: 16_384, maxResults: 50 },
  allowWrites: false,
  allowDeploys: false
};

let checks = 0;
async function check(name, run) {
  await run();
  checks += 1;
  console.log(`PASS ${name}`);
}

await check("the declared capability set is complete and read-only", () => {
  assert.deepEqual(capabilities, [
    "listFiles", "readFile", "searchCode", "inspectPackageManifest", "inspectEnvironmentNames",
    "runTests", "runTypecheck", "runLint", "runBuild", "runSecretScan", "runDependencyAudit", "inspectGitDiff"
  ]);
  assert.equal(validateCapabilityDeclaration(declaration).ok, true);
  assert.equal(validateCapabilityDeclaration({ ...declaration, allowWrites: true }).code, "write_or_deploy_not_allowed");
  assert.equal(validateCapabilityDeclaration({ ...declaration, permissions: { ...permissions, runBuild: false } }).code, "permission_required");
  assert.equal(validateCapabilityDeclaration({ ...declaration, capabilities: ["listFiles", "not-a-capability"] }).code, "invalid_capabilities");
});

await check("scope, path, and bounds validators fail closed", () => {
  assert.equal(normalizeRelativePath("src/project.js"), "src/project.js");
  assert.equal(normalizeRelativePath("../private.txt"), null);
  assert.equal(normalizeRelativePath("C:/private.txt"), null);
  for (const path of [".env", "config/.env.local", "id_rsa", "cert.pem", "credentials.json", "nested/private.key"]) {
    assert.equal(isSensitivePath(path), true, path);
  }
  assert.equal(validateCapabilityDeclaration({ ...declaration, bounds: { timeoutMs: 120_001 } }).code, "invalid_bounds");
  assert.equal(validateCapabilityDeclaration({ ...declaration, scope: { ...scope, include: [".env"] } }).code, "invalid_scope");
});

await check("each capability needs an explicit declared permission and stays in scope", () => {
  const requests = [
    ["listFiles", { path: "src" }],
    ["readFile", { path: "src/core.js" }],
    ["searchCode", { path: "src", query: "evidence" }],
    ["inspectPackageManifest", { path: "package.json" }],
    ["inspectEnvironmentNames", {}],
    ["runTests", { target: "server/codebase-adapter-test.mjs" }],
    ["runTypecheck", {}],
    ["runLint", {}],
    ["runBuild", {}],
    ["runSecretScan", {}],
    ["runDependencyAudit", {}],
    ["inspectGitDiff", { path: "src" }]
  ];
  for (const [capability, args] of requests) {
    const result = validateCapabilityRequest({ declaration, capability, args });
    assert.equal(result.ok, true, capability);
  }
  assert.equal(validateCapabilityRequest({ declaration, capability: "readFile", args: { path: ".env" } }).code, "invalid_arguments");
  assert.equal(validateCapabilityRequest({ declaration, capability: "readFile", args: {} }).code, "invalid_arguments");
  assert.equal(validateCapabilityRequest({ declaration, capability: "readFile", args: { path: "server/test.mjs" } }).code, "outside_scope");
  assert.equal(validateCapabilityRequest({ declaration: { ...declaration, capabilities: ["readFile"], permissions: { readFile: true } }, capability: "runBuild", args: {} }).code, "capability_not_declared");
  assert.equal(validateCapabilityRequest({ declaration, capability: "runTests", args: { command: "npm test; deploy" } }).code, "invalid_arguments");
});

await check("receipts preserve provenance, status, bounds, and protected-output rules", () => {
  const pass = createEvidenceReceipt({
    capability: "runTests",
    status: "pass",
    provenance: "tool-observed",
    summary: "The safe runner observed all tests pass.",
    scope,
    bounds: DEFAULT_BOUNDS,
    output: { passed: 3, failed: 0 }
  });
  assert.equal(validateEvidenceReceipt(pass).ok, true);
  for (const provenance of EVIDENCE_PROVENANCE) {
    for (const status of RECEIPT_STATUS) {
      assert.equal(validateEvidenceReceipt({ ...pass, provenance, status }).ok, true);
    }
  }
  assert.equal(validateEvidenceReceipt({ ...pass, output: "OPENAI_API_KEY=secret-value" }).code, "unsafe_or_oversized_output");
  assert.equal(validateEvidenceReceipt({ ...pass, output: "-----BEGIN PRIVATE KEY-----" }).code, "unsafe_or_oversized_output");
  const blocked = createBlockedReceipt({ capability: "runBuild", declaration, reasonCode: "safe_runner_required" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.provenance, "tool-observed");
  assert.equal(blocked.reasonCode, "safe_runner_required");
});

await check("no runner means no filesystem or command execution", async () => {
  assert.equal(supportsSafeRunner(null), false);
  const result = await executeCapabilityRequest({ declaration, capability: "runTests", args: {} });
  assert.equal(result.ok, false);
  assert.equal(result.receipt.status, "blocked");
  assert.equal(result.receipt.reasonCode, "safe_runner_required");
});

await check("a separately supplied safe runner can return a validated receipt", async () => {
  let calls = 0;
  const runner = {
    kind: "safe-codebase-runner.v1",
    readOnly: true,
    allowWrites: false,
    allowDeploys: false,
    runCapability: async request => {
      calls += 1;
      assert.equal(request.capability, "inspectPackageManifest");
      return createEvidenceReceipt({
        capability: request.capability,
        status: "pass",
        provenance: "tool-observed",
        summary: "The safe runner observed the manifest.",
        scope: request.declaration.scope,
        bounds: request.declaration.bounds,
        output: { packageName: "ai-mentor" }
      });
    }
  };
  assert.equal(supportsSafeRunner(runner), true);
  const result = await executeCapabilityRequest({ declaration, capability: "inspectPackageManifest", args: { path: "package.json" } }, { runner });
  assert.equal(result.ok, true);
  assert.equal(result.receipt.status, "pass");
  assert.equal(calls, 1);
});

await check("runner results cannot widen request bounds and slow runners time out", async () => {
  const widened = await executeCapabilityRequest(
    { declaration, capability: "runLint", args: {} },
    {
      runner: {
        kind: "safe-codebase-runner.v1", readOnly: true, allowWrites: false, allowDeploys: false,
        runCapability: async request => createEvidenceReceipt({
          capability: request.capability,
          status: "pass",
          provenance: "tool-observed",
          summary: "Widened.",
          scope: request.declaration.scope,
          bounds: { timeoutMs: 120_000, maxOutputBytes: 1024 * 1024, maxResults: 2_000 }
        })
      }
    }
  );
  assert.equal(widened.ok, false);
  assert.equal(widened.receipt.reasonCode, "runner_bounds_exceeded");

  const timeoutDeclaration = { ...declaration, bounds: { timeoutMs: 10, maxOutputBytes: 16_384, maxResults: 50 } };
  const timedOut = await executeCapabilityRequest(
    { declaration: timeoutDeclaration, capability: "runLint", args: {} },
    {
      runner: {
        kind: "safe-codebase-runner.v1", readOnly: true, allowWrites: false, allowDeploys: false,
        runCapability: async () => new Promise(resolve => setTimeout(() => resolve(createEvidenceReceipt({
          capability: "runLint", status: "pass", provenance: "tool-observed", summary: "Late.", scope, bounds: timeoutDeclaration.bounds
        })), 50))
      }
    }
  );
  assert.equal(timedOut.ok, false);
  assert.equal(timedOut.receipt.reasonCode, "timeout");
});

console.log(`\n${checks} codebase adapter checks passed. No runner was configured for command or filesystem access.`);
