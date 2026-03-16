# Full Suite Test Instructions

This document drives an AI agent through a complete proof-of-function run for all 12 native tools. Every test requires the AI to call a specific tool with specific parameters, extract a unique piece of data from the actual response, and record that data in `full-suite/TEST-RESULTS.md`.

"Verify" is not acceptable. Proof means real output captured into the results file.

**Fixture root:** `/home/buzzkill/Projects/goodvibes-tui/full-suite/`
**Project root:** `/home/buzzkill/Projects/goodvibes-tui/`
**Results file:** `/home/buzzkill/Projects/goodvibes-tui/full-suite/TEST-RESULTS.md`

---

## Section 1: Setup

Before running any tests, perform these two steps.

### 1.1 Create TEST-RESULTS.md

**Call:** `write` tool with:
```
path: full-suite/TEST-RESULTS.md
mode: overwrite
content: (the full markdown skeleton below)
```

Initial content for TEST-RESULTS.md:
```markdown
# Tool Test Results
Generated: {REPLACE_WITH_ACTUAL_TIMESTAMP}

## read
| Test | Proof | Status |
|------|-------|--------|

## write
| Test | Proof | Status |
|------|-------|--------|

## edit
| Test | Proof | Status |
|------|-------|--------|

## find
| Test | Proof | Status |
|------|-------|--------|

## exec
| Test | Proof | Status |
|------|-------|--------|

## fetch
| Test | Proof | Status |
|------|-------|--------|

## analyze
| Test | Proof | Status |
|------|-------|--------|

## inspect
| Test | Proof | Status |
|------|-------|--------|

## agent
| Test | Proof | Status |
|------|-------|--------|

## state
| Test | Proof | Status |
|------|-------|--------|

## workflow
| Test | Proof | Status |
|------|-------|--------|

## registry
| Test | Proof | Status |
|------|-------|--------|

## Summary
| Metric | Value |
|--------|-------|
| Total tests | 0 |
| Passed | 0 |
| Failed | 0 |
```

**Capture:** The `bytes_written` field from the response and the `path` field.
**Record:** Append this to the `write` section immediately after (this is also the first write test).

### 1.2 Create output directory

**Call:** `write` tool with:
```
path: full-suite/output/.keep
mode: overwrite
content: (empty string)
```

**Capture:** Confirm the file was created without error.
**Record:** Note the result inline; this is not a scored test.

---

## Section 2: `read` Tool (6 tests)

For each test, append a row to the `## read` table in TEST-RESULTS.md.

### 2.1 content mode

**Call:** `read` tool with:
```
files: [{ path: "full-suite/src/index.ts" }]
extract: "content"
```

**Capture from response:**
- The exact line count returned (e.g., `42`)
- The name of the first exported function found on line 1 or nearby (e.g., `greet`)

**Record row:**
```
| content mode | Line count: {N}, First export: `{name}` | PASS/FAIL |
```

### 2.2 outline mode

**Call:** `read` tool with:
```
files: [{ path: "full-suite/src/index.ts", extract: "outline" }]
```

**Capture from response:**
- The complete list of symbol names that appear in the outline (e.g., `greet, add, VERSION, UserService, unusedHelper`)

**Record row:**
```
| outline mode | Symbols in outline: {comma-separated list} | PASS/FAIL |
```

### 2.3 symbols mode

**Call:** `read` tool with:
```
files: [{ path: "full-suite/src/index.ts", extract: "symbols" }]
```

**Capture from response:**
- The exact count of exported symbols returned (e.g., `5`)

**Record row:**
```
| symbols mode | Exported symbol count: {N} | PASS/FAIL |
```

### 2.4 lines mode with range

**Call:** `read` tool with:
```
files: [{ path: "full-suite/src/index.ts", extract: "lines", range: { start: 1, end: 10 } }]
```

**Capture from response:**
- The exact text of line 1 as returned in the response

**Record row:**
```
| lines mode (1-10) | Line 1: `{exact text}` | PASS/FAIL |
```

### 2.5 batch read (two files)

**Call:** `read` tool with:
```
files: [
  { path: "full-suite/src/index.ts" },
  { path: "full-suite/src/auth.ts" }
]
```

**Capture from response:**
- The count of files returned in the response (must be `2`)
- The total line count across both files combined

**Record row:**
```
| batch read 2 files | Files returned: {N}, Total lines: {N} | PASS/FAIL |
```

### 2.6 count_only output format

**Call:** `read` tool with:
```
files: [{ path: "full-suite/src/index.ts" }]
output: { format: "count_only" }
```

**Capture from response:**
- The token estimate number returned

**Record row:**
```
| count_only format | Token estimate: {N} | PASS/FAIL |
```

---

## Section 3: `write` Tool (5 tests)

For each test, append a row to the `## write` table in TEST-RESULTS.md.

### 3.1 Create new file

**Call:** `write` tool with:
```
path: "full-suite/output/test-write.txt"
mode: "fail_if_exists"
content: "hello world"
```

**Capture from response:**
- The `bytes_written` value
- The `path` value as returned (resolved path)

**Record row:**
```
| create new file | bytes_written: {N}, path: {path} | PASS/FAIL |
```

### 3.2 fail_if_exists guard

**Call:** `write` tool with:
```
path: "full-suite/output/test-write.txt"
mode: "fail_if_exists"
content: "this should not overwrite"
```

**Capture from response:**
- The exact error message text returned (must contain something like "already exists")

**Record row:**
```
| fail_if_exists | Error: "{exact error text}" | PASS/FAIL |
```

### 3.3 overwrite mode

**Call:** `write` tool with:
```
path: "full-suite/output/test-write.txt"
mode: "overwrite"
content: "overwritten content"
```

**Capture from response:**
- The new `bytes_written` value (must differ from test 3.1)

**Record row:**
```
| overwrite mode | bytes_written: {N} (differs from 3.1) | PASS/FAIL |
```

### 3.4 base64 content write

**Call:** `write` tool with:
```
path: "full-suite/output/test-base64.txt"
mode: "fail_if_exists"
content_base64: {base64 encoding of "base64 proof content"}
```

The base64 value for "base64 proof content" is: `YmFzZTY0IHByb29mIGNvbnRlbnQ=`

**Capture from response:**
- The `bytes_written` value returned

**Record row:**
```
| base64 write | bytes_written: {N} | PASS/FAIL |
```

### 3.5 dry_run mode

**Call:** `write` tool with:
```
path: "full-suite/output/test-dry-run.txt"
dry_run: true
content: "this should never be written"
```

**Capture from response:**
- Confirmation that dry_run was acknowledged (e.g., a `dry_run: true` field or equivalent in the response)

Then immediately call `read` on `full-suite/output/test-dry-run.txt` and confirm it returns a "file not found" error.

**Capture from read response:**
- The error confirming the file does not exist

**Record row:**
```
| dry_run write | dry_run acknowledged, file not found on read: "{error}" | PASS/FAIL |
```

---

## Section 4: `edit` Tool (6 tests)

Before running edit tests, copy `full-suite/src/index.ts` to `full-suite/output/edit-test.ts` using the `write` tool (read the source first, write to output). Each edit test should work on `full-suite/output/edit-test.ts` to preserve the original.

For each test, append a row to the `## edit` table in TEST-RESULTS.md.

### 4.1 Exact find/replace

**Call:** `edit` tool with:
```
edits: [{
  path: "full-suite/output/edit-test.ts",
  find: "hello",
  replace: "hello_edited"
}]
```

(If "hello" does not appear in index.ts, use an actual string that does appear — read the file first to confirm.)

**Capture from response:**
- A line from the generated diff output showing the replacement (the `+` line)

**Record row:**
```
| exact find/replace | Diff line: `{+ line from diff}` | PASS/FAIL |
```

### 4.2 Regex replace

**Call:** `edit` tool with:
```
edits: [{
  path: "full-suite/output/edit-test.ts",
  find: "export function (\\w+)",
  replace: "export function $1_v2",
  regex: true,
  occurrence: "first"
}]
```

**Capture from response:**
- The matched pattern text (the original text that was matched)

**Record row:**
```
| regex replace | Matched: `{original matched text}` | PASS/FAIL |
```

### 4.3 occurrence: all

First reset `full-suite/output/edit-test.ts` by writing the original content back (overwrite).

**Call:** `edit` tool with:
```
edits: [{
  path: "full-suite/output/edit-test.ts",
  find: "export",
  replace: "export",
  occurrence: "all"
}]
```

(This is a no-op replacement that still exercises the `occurrence: all` code path.)

**Capture from response:**
- The count of replacements made (how many occurrences were processed)

**Record row:**
```
| occurrence: all | Replacements made: {N} | PASS/FAIL |
```

### 4.4 Fuzzy/whitespace-insensitive match

**Call:** `edit` tool with an `options` field enabling whitespace-insensitive matching:
```
edits: [{
  path: "full-suite/output/edit-test.ts",
  find: "export   function   greet",
  replace: "export function greet",
  options: { whitespace_insensitive: true }
}]
```

(The find string has extra spaces; the whitespace-insensitive mode should still match.)

**Capture from response:**
- Confirmation that the match succeeded despite the whitespace difference (e.g., a diff line or `matched: true`)

**Record row:**
```
| fuzzy/whitespace match | Matched despite extra spaces: {evidence} | PASS/FAIL |
```

### 4.5 dry_run edit

**Call:** `edit` tool with:
```
edits: [{
  path: "full-suite/output/edit-test.ts",
  find: "greet",
  replace: "greet_DRY_RUN"
}]
dry_run: true
```

**Capture from response:**
- A line from the diff preview showing the proposed change

Then immediately call `read` on `full-suite/output/edit-test.ts` and confirm `greet_DRY_RUN` does NOT appear in the content.

**Capture from read response:**
- Confirmation that `greet_DRY_RUN` is absent

**Record row:**
```
| dry_run edit | Diff preview: `{+ line}`, file unchanged: `greet_DRY_RUN` absent | PASS/FAIL |
```

### 4.6 Atomic transaction — one bad edit aborts all

**Call:** `edit` tool with two edits in a single call:
```
edits: [
  {
    path: "full-suite/output/edit-test.ts",
    find: "greet",
    replace: "greet_ATOMIC"
  },
  {
    path: "full-suite/output/edit-test.ts",
    find: "THIS_STRING_DOES_NOT_EXIST_IN_THE_FILE",
    replace: "should never apply"
  }
]
```

**Capture from response:**
- The error returned for the second edit

Then immediately call `read` on `full-suite/output/edit-test.ts` and confirm `greet_ATOMIC` does NOT appear (rollback succeeded).

**Capture from read response:**
- Confirmation that `greet_ATOMIC` is absent

**Record row:**
```
| atomic rollback | Error: "{error text}", `greet_ATOMIC` absent from file | PASS/FAIL |
```

---

## Section 5: `find` Tool (7 tests)

For each test, append a row to the `## find` table in TEST-RESULTS.md.

### 5.1 files mode — glob for .ts files

**Call:** `find` tool with:
```
mode: "files"
glob: "full-suite/src/**/*.ts"
```

**Capture from response:**
- The exact count of .ts files found

**Record row:**
```
| files glob *.ts | File count: {N} | PASS/FAIL |
```

### 5.2 files mode — glob for .tsx files

**Call:** `find` tool with:
```
mode: "files"
glob: "full-suite/src/**/*.tsx"
```

**Capture from response:**
- The exact file path(s) returned (even if just one file)

**Record row:**
```
| files glob *.tsx | Paths: {exact paths} | PASS/FAIL |
```

### 5.3 content mode — search for pattern

**Call:** `find` tool with:
```
mode: "content"
pattern: "export function"
glob: "full-suite/src/**/*.ts"
```

**Capture from response:**
- The total match count returned

**Record row:**
```
| content search "export function" | Match count: {N} | PASS/FAIL |
```

### 5.4 content mode — count_only format

**Call:** `find` tool with:
```
mode: "content"
pattern: "export"
glob: "full-suite/src/**/*.ts"
output: { format: "count_only" }
```

**Capture from response:**
- The single number returned (the match count)

**Record row:**
```
| content count_only | Count: {N} | PASS/FAIL |
```

### 5.5 content mode — files_only format

**Call:** `find` tool with:
```
mode: "content"
pattern: "export"
glob: "full-suite/src/**/*.ts"
output: { format: "files_only" }
```

**Capture from response:**
- The list of file paths returned (no line numbers, just paths)

**Record row:**
```
| content files_only | Files: {list of paths} | PASS/FAIL |
```

### 5.6 symbols mode — find all functions

**Call:** `find` tool with:
```
mode: "symbols"
glob: "full-suite/src/**/*.ts"
kinds: ["function"]
```

**Capture from response:**
- The symbol names returned (e.g., `greet, add, unusedHelper`)

**Record row:**
```
| symbols functions | Names: {comma-separated} | PASS/FAIL |
```

### 5.7 batch query — files + content in one call

**Call:** `find` tool with two queries in a single call (using `queries` array if supported, or two separate `mode` values if the tool supports it):
```
queries: [
  { id: "ts_files", mode: "files", glob: "full-suite/src/**/*.ts" },
  { id: "exports", mode: "content", pattern: "export", glob: "full-suite/src/**/*.ts" }
]
```

**Capture from response:**
- Both result IDs (`ts_files` and `exports`) present in the response
- The count for each

**Record row:**
```
| batch find query | ts_files count: {N}, exports count: {N} | PASS/FAIL |
```

---

## Section 6: `exec` Tool (5 tests)

For each test, append a row to the `## exec` table in TEST-RESULTS.md.

### 6.1 echo command

**Call:** `exec` tool with:
```
commands: [{ cmd: "echo proof_token_exec_works" }]
```

**Capture from response:**
- The exact stdout content returned (must be `proof_token_exec_works`)

**Record row:**
```
| echo command | stdout: `{exact output}` | PASS/FAIL |
```

### 6.2 Read a file via cat with exit code

**Call:** `exec` tool with:
```
commands: [{ cmd: "cat full-suite/package.json" }]
```

**Capture from response:**
- The `exit_code` from the response
- The first line of stdout (must start with `{`)

**Record row:**
```
| cat package.json | exit_code: {N}, stdout line 1: `{text}` | PASS/FAIL |
```

### 6.3 Exit code expectation — success

**Call:** `exec` tool with:
```
commands: [{
  cmd: "node --version",
  expect: { exit_code: 0 }
}]
```

**Capture from response:**
- The `success: true` field (or equivalent) confirming expectation was met
- The Node.js version string from stdout

**Record row:**
```
| exit_code expectation | success: {value}, node version: `{v...}` | PASS/FAIL |
```

### 6.4 file_ops copy

**Call:** `exec` tool with a `file_ops` copy operation (or equivalent):
```
file_ops: [{
  op: "copy",
  src: "full-suite/src/index.ts",
  dest: "full-suite/output/index-copy.ts"
}]
```

If `file_ops` is not supported by exec, use `cmd: "cp full-suite/src/index.ts full-suite/output/index-copy.ts"`.

**Capture from response:**
- Confirmation the operation succeeded (exit_code or success field)

Then immediately call `read` on `full-suite/output/index-copy.ts` to confirm it exists.

**Capture from read response:**
- The line count of the copied file (proving it is non-empty)

**Record row:**
```
| file_ops copy | Copy succeeded, read confirmed line count: {N} | PASS/FAIL |
```

### 6.5 Background mode

**Call:** `exec` tool with:
```
commands: [{
  cmd: "sleep 2 && echo background_done",
  background: true
}]
```

**Capture from response:**
- The `process_id` (or job ID) returned in the response

**Record row:**
```
| background mode | process_id: `{ID}` | PASS/FAIL |
```

---

## Section 7: `fetch` Tool (4 tests)

For each test, append a row to the `## fetch` table in TEST-RESULTS.md.

### 7.1 GET request

**Call:** `fetch` tool with:
```
urls: [{ url: "https://httpbin.org/get" }]
```

**Capture from response:**
- The HTTP status code returned (should be `200`)
- The value of the `url` field in the JSON body (should be `https://httpbin.org/get`)

**Record row:**
```
| GET request | status: {N}, url field: `{value}` | PASS/FAIL |
```

### 7.2 POST request with JSON body

**Call:** `fetch` tool with:
```
urls: [{
  url: "https://httpbin.org/post",
  method: "POST",
  body: { proof_key: "fetch_post_works" },
  headers: { "Content-Type": "application/json" }
}]
```

**Capture from response:**
- The value of `json.proof_key` from the echoed response body (must be `fetch_post_works`)

**Record row:**
```
| POST with body | json.proof_key: `{value}` | PASS/FAIL |
```

### 7.3 extract: json mode

**Call:** `fetch` tool with:
```
urls: [{
  url: "https://httpbin.org/json",
  extract: "json"
}]
```

**Capture from response:**
- A specific top-level field name from the parsed JSON object returned

**Record row:**
```
| extract json | Top-level field: `{field_name}` | PASS/FAIL |
```

### 7.4 Batch fetch two URLs

**Call:** `fetch` tool with:
```
urls: [
  { url: "https://httpbin.org/status/200" },
  { url: "https://httpbin.org/status/201" }
]
```

**Capture from response:**
- The status code for the first URL (must be `200`)
- The status code for the second URL (must be `201`)

**Record row:**
```
| batch 2 URLs | URL1 status: 200, URL2 status: 201 | PASS/FAIL |
```

---

## Section 8: `analyze` Tool (6 tests)

For each test, append a row to the `## analyze` table in TEST-RESULTS.md.

### 8.1 dependencies mode

**Call:** `analyze` tool with:
```
mode: "dependencies"
path: "full-suite/"
```

**Capture from response:**
- At least one import path found (e.g., `./auth` or `./utils`)

**Record row:**
```
| dependencies | Import found: `{path}` | PASS/FAIL |
```

### 8.2 circular deps mode

**Call:** `analyze` tool with:
```
mode: "circular"
path: "full-suite/"
```

**Capture from response:**
- The full circular chain detected (e.g., `utils → auth → utils`)

**Record row:**
```
| circular deps | Chain: `{A → B → A}` | PASS/FAIL |
```

### 8.3 dead_code mode

**Call:** `analyze` tool with:
```
mode: "dead_code"
path: "full-suite/"
```

**Capture from response:**
- The name `unusedHelper` appearing in the list of dead exports

**Record row:**
```
| dead_code | Dead export found: `unusedHelper` | PASS/FAIL |
```

### 8.4 security mode

**Call:** `analyze` tool with:
```
mode: "security"
path: "full-suite/"
```

**Capture from response:**
- The detected secret pattern (e.g., `AKIA...` for AWS key or `sk-secret...` for API key) and the file it was found in

**Record row:**
```
| security | Pattern: `{pattern}` in `{file}` | PASS/FAIL |
```

### 8.5 surface mode

**Call:** `analyze` tool with:
```
mode: "surface"
path: "full-suite/src/index.ts"
```

**Capture from response:**
- The complete list of exported symbol names from the surface analysis

**Record row:**
```
| surface | Exports: {list} | PASS/FAIL |
```

### 8.6 preview mode (proposed edit)

**Call:** `analyze` tool with:
```
mode: "preview"
path: "full-suite/src/index.ts"
proposed_edit: {
  find: "unusedHelper",
  replace: "unusedHelper_renamed"
}
```

**Capture from response:**
- A line from the diff preview showing the rename (the `+` line)

**Record row:**
```
| preview edit | Diff: `{+ line showing rename}` | PASS/FAIL |
```

---

## Section 9: `inspect` Tool (5 tests)

For each test, append a row to the `## inspect` table in TEST-RESULTS.md.

### 9.1 project mode

**Call:** `inspect` tool with:
```
mode: "project"
path: "/home/buzzkill/Projects/goodvibes-tui"
```

**Capture from response:**
- The detected project type (e.g., `node`, `typescript`, `nextjs`)
- The detected package manager (e.g., `npm`, `pnpm`, `yarn`)

**Record row:**
```
| project inspect | Type: `{type}`, Package manager: `{pm}` | PASS/FAIL |
```

### 9.2 database mode

**Call:** `inspect` tool with:
```
mode: "database"
path: "/home/buzzkill/Projects/goodvibes-tui"
```

**Capture from response:**
- Model names found in the Prisma schema (e.g., `User`, `Post`)

**Record row:**
```
| database inspect | Models: `{name1}, {name2}` | PASS/FAIL |
```

### 9.3 components mode

**Call:** `inspect` tool with:
```
mode: "components"
path: "full-suite/src/Button.tsx"
```

**Capture from response:**
- The component name found (e.g., `Button`)
- At least one prop name detected (e.g., `onClick`, `label`)

**Record row:**
```
| components inspect | Component: `{name}`, Props: `{list}` | PASS/FAIL |
```

### 9.4 accessibility mode

**Call:** `inspect` tool with:
```
mode: "accessibility"
path: "full-suite/src/Button.tsx"
```

**Capture from response:**
- The specific accessibility issue detected (e.g., `img element missing alt attribute` or `div with onClick lacks role or keyboard handler`)

**Record row:**
```
| accessibility | Issue: `{exact issue description}` | PASS/FAIL |
```

### 9.5 scaffold mode (dry_run)

**Call:** `inspect` tool with:
```
mode: "scaffold"
template: "component"
name: "ProofComponent"
dry_run: true
```

**Capture from response:**
- The list of file paths that would be generated (e.g., `src/components/ProofComponent/index.tsx`, `src/components/ProofComponent/ProofComponent.tsx`)

**Record row:**
```
| scaffold dry_run | Would generate: {file1}, {file2} | PASS/FAIL |
```

---

## Section 10: `agent` Tool (4 tests)

For each test, append a row to the `## agent` table in TEST-RESULTS.md.

### 10.1 Spawn agent

**Call:** `agent` tool with:
```
action: "spawn"
template: "researcher"
task: "proof test: just respond with OK"
```

**Capture from response:**
- The generated agent ID (format: `agent-XXXX`)

**Record row:**
```
| spawn agent | agent_id: `{agent-XXXX}` | PASS/FAIL |
```

### 10.2 Status check on spawned agent

**Call:** `agent` tool with:
```
action: "status"
agent_id: "{agent-XXXX from test 10.1}"
```

**Capture from response:**
- The `status` field value (e.g., `running`, `pending`, `complete`)

**Record row:**
```
| agent status | status: `{value}` | PASS/FAIL |
```

### 10.3 List templates

**Call:** `agent` tool with:
```
action: "templates"
```

**Capture from response:**
- The total count of templates available
- At least two template names

**Record row:**
```
| list templates | Count: {N}, Examples: `{name1}`, `{name2}` | PASS/FAIL |
```

### 10.4 Cancel agent

**Call:** `agent` tool with:
```
action: "cancel"
agent_id: "{agent-XXXX from test 10.1}"
```

**Capture from response:**
- Confirmation that status changed (e.g., `status: "cancelled"` or `success: true`)

**Record row:**
```
| cancel agent | Result: `{status or success field}` | PASS/FAIL |
```

---

## Section 11: `state` Tool (5 tests)

For each test, append a row to the `## state` table in TEST-RESULTS.md.

### 11.1 Set a key

**Call:** `state` tool with:
```
action: "set"
keys: { test_proof: "working" }
```

**Capture from response:**
- The `keys_written` count (must be `1`)

**Record row:**
```
| state set | keys_written: {N} | PASS/FAIL |
```

### 11.2 Get the key back

**Call:** `state` tool with:
```
action: "get"
keys: ["test_proof"]
```

**Capture from response:**
- The value of `test_proof` (must be `"working"`)

**Record row:**
```
| state get | test_proof: `working` | PASS/FAIL |
```

### 11.3 Budget mode

**Call:** `state` tool with:
```
action: "budget"
```

**Capture from response:**
- The session start time OR the current token estimate from the response

**Record row:**
```
| state budget | Session start or token estimate: `{value}` | PASS/FAIL |
```

### 11.4 List mode

**Call:** `state` tool with:
```
action: "list"
```

**Capture from response:**
- Confirm that `test_proof` appears in the list of keys

**Record row:**
```
| state list | `test_proof` in keys: true | PASS/FAIL |
```

### 11.5 Clear a key

**Call:** `state` tool with:
```
action: "clear"
keys: ["test_proof"]
```

Then immediately call `state` with `action: "get"` and `keys: ["test_proof"]`.

**Capture from get response:**
- That `test_proof` is now absent or returns null/undefined

**Record row:**
```
| state clear | After clear, get returns: `{null/empty/absent}` | PASS/FAIL |
```

---

## Section 12: `workflow` Tool (5 tests)

For each test, append a row to the `## workflow` table in TEST-RESULTS.md.

### 12.1 Start a WRFC workflow

**Call:** `workflow` tool with:
```
action: "start"
template: "WRFC"
task: "proof test workflow"
```

**Capture from response:**
- The generated workflow ID (format: `wf-XXXX`)

**Record row:**
```
| workflow start | workflow_id: `{wf-XXXX}` | PASS/FAIL |
```

### 12.2 Status check — initial state is gather

**Call:** `workflow` tool with:
```
action: "status"
workflow_id: "{wf-XXXX from test 12.1}"
```

**Capture from response:**
- The `currentState` field (must be `"gather"`)

**Record row:**
```
| workflow status | currentState: `gather` | PASS/FAIL |
```

### 12.3 Transition to plan state

**Call:** `workflow` tool with:
```
action: "transition"
workflow_id: "{wf-XXXX from test 12.1}"
target_state: "plan"
```

**Capture from response:**
- The `success: true` field
- The new state value (must be `"plan"`)

**Record row:**
```
| workflow transition | success: true, new state: `plan` | PASS/FAIL |
```

### 12.4 Add a trigger

**Call:** `workflow` tool with:
```
action: "trigger"
workflow_id: "{wf-XXXX from test 12.1}"
trigger: { event: "test_event", condition: "always" }
```

**Capture from response:**
- The generated trigger ID (format: `trg-XXXX`)

**Record row:**
```
| workflow trigger | trigger_id: `{trg-XXXX}` | PASS/FAIL |
```

### 12.5 Cancel the workflow

**Call:** `workflow` tool with:
```
action: "cancel"
workflow_id: "{wf-XXXX from test 12.1}"
```

**Capture from response:**
- Confirmation that status changed to cancelled (e.g., `status: "cancelled"` or `success: true`)

**Record row:**
```
| workflow cancel | Result: `{status or success field}` | PASS/FAIL |
```

---

## Section 13: `registry` Tool (4 tests)

For each test, append a row to the `## registry` table in TEST-RESULTS.md.

### 13.1 Search for a skill by name

**Call:** `registry` tool with:
```
action: "search"
query: "code-review"
type: "skills"
```

**Capture from response:**
- The exact skill name returned (must include or equal `code-review`)

**Record row:**
```
| search skills | Skill found: `{name}` | PASS/FAIL |
```

### 13.2 Search for tools — count

**Call:** `registry` tool with:
```
action: "search"
type: "tools"
```

**Capture from response:**
- The total count of tools found (expected: `12`)

**Record row:**
```
| search tools | Count: {N} | PASS/FAIL |
```

### 13.3 Get skill content

**Call:** `registry` tool with:
```
action: "content"
name: "code-review"
```

**Capture from response:**
- A verbatim line from the skill content (any line that proves real content was returned)

**Record row:**
```
| skill content | Line from content: `{exact line}` | PASS/FAIL |
```

### 13.4 Skill dependencies

**Call:** `registry` tool with:
```
action: "dependencies"
name: "code-review"
```

**Capture from response:**
- Confirm that `testing-strategy` appears in the dependency list

**Record row:**
```
| skill dependencies | `testing-strategy` in deps: true | PASS/FAIL |
```

---

## Section 14: Summary

After all tests are complete:

1. Count the total number of test rows across all 12 tool sections (not counting setup).
2. Count the number of rows with `PASS`.
3. Count the number of rows with `FAIL`.
4. Update the `## Summary` table at the bottom of TEST-RESULTS.md with the final counts.

**Call:** `edit` tool to overwrite the Summary table with actual values:
```
find: the existing Summary table
replace: the completed Summary table with real counts
```

**The final Summary table must contain:**
```markdown
## Summary
| Metric | Value |
|--------|-------|
| Total tests | {N} |
| Passed | {N} |
| Failed | {N} |
```

The test run is complete when TEST-RESULTS.md exists, all tables are populated with real proof data, and the Summary section contains accurate counts.
