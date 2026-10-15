# Read-only codebase/CLI adapter boundary

`codebase-adapter.mjs` defines the contract for a future adapter that can
inspect an explicitly scoped codebase and report bounded evidence. It is
intentionally separate from the standalone web UI and currently performs no
filesystem or shell access by itself.

## Declared capabilities

The contract version is `codebase-adapter.v1`. A declaration must list one or
more of these capabilities and set the matching permission flag to `true`:

```text
listFiles
readFile
searchCode
inspectPackageManifest
inspectEnvironmentNames
runTests
runTypecheck
runLint
runBuild
runSecretScan
runDependencyAudit
inspectGitDiff
```

Example declaration:

```json
{
  "contractVersion": "codebase-adapter.v1",
  "capabilities": ["listFiles", "readFile", "runTests"],
  "permissions": {
    "listFiles": true,
    "readFile": true,
    "runTests": true
  },
  "scope": {
    "root": "C:/workspace/project",
    "include": ["src", "tests", "package.json"],
    "exclude": []
  },
  "bounds": {
    "timeoutMs": 30000,
    "maxOutputBytes": 65536,
    "maxResults": 200
  },
  "allowWrites": false,
  "allowDeploys": false
}
```

The adapter rejects undeclared capabilities, missing `true` permission flags,
empty scopes, paths outside `include`/`exclude`, oversized bounds, arbitrary
command strings, and any write/deploy authorization. Supported paths are
relative to `scope.root`; absolute paths, traversal, and backslashes are
rejected to avoid platform ambiguity.

## Protected data and environment metadata

`.env` files, `.env.*`, private-key/certificate files, credential/secret files,
SSH key files, and their descendants are protected by the validator. They are
not readable or searchable even when a general read flag is enabled.
`inspectEnvironmentNames` is metadata-only: it may report names in a future
safe runner, but never values. The contract does not load `.env` files or
process credentials automatically.

## Evidence receipts

Every result is a bounded receipt with independent `status` and `provenance`
fields:

```json
{
  "receiptVersion": "codebase-adapter.v1",
  "id": "r_…",
  "capability": "runTests",
  "status": "pass",
  "provenance": "tool-observed",
  "summary": "The safe runner observed all tests pass.",
  "scope": {"root": "C:/workspace/project", "include": ["tests"], "exclude": []},
  "bounds": {"timeoutMs": 30000, "maxOutputBytes": 65536, "maxResults": 200},
  "observedAt": "2026-01-01T00:00:00.000Z",
  "output": {"passed": 12, "failed": 0}
}
```

`provenance` is one of `suggested`, `user-reported`, or `tool-observed`.
`status` is one of `pass`, `fail`, or `blocked`. A suggestion or user report
must not be presented as tool observation. Receipt output is bounded and
rejects recognizable credential/private-key material.

## Runner boundary

`executeCapabilityRequest` is plan/block-first. Without a separately supplied
object with `kind: "safe-codebase-runner.v1"`, `readOnly: true`, no write or
deploy flags, and a `runCapability` function, it returns a `blocked` receipt
with `safe_runner_required`. This module does not import `node:fs`,
`node:child_process`, invoke a shell, or accept a raw command. A future runner
owns the actual implementation and must return a validated receipt.

Run the focused contract checks with:

```text
node server/codebase-adapter-test.mjs
```
