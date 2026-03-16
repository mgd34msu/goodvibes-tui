# Native Tool Test Suite
> Follow these instructions top-to-bottom. Record all proof data in TEST-RESULTS.md.
> Do NOT skip setup. Do NOT skip ahead. Do NOT re-use files across tests.

---

## Setup (do this first)

Before running any tests:

1. Create `full-suite/TEST-RESULTS.md` with this exact header:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

2. Create directory `full-suite/output/` (for write tests — all writes go here, never to src/)

3. Create directory `full-suite/edit-tests/` and copy `full-suite/src/index.ts` to each of the following:
   - `full-suite/edit-tests/test-1.ts`
   - `full-suite/edit-tests/test-2.ts`
   - `full-suite/edit-tests/test-3.ts`
   - `full-suite/edit-tests/test-4.ts`
   - `full-suite/edit-tests/test-5.ts`
   - `full-suite/edit-tests/test-6.ts`

   Each edit test operates on its own copy. They MUST NOT share a file.

---

## Phase 1: Read-Only Tests

> These tests do not modify any files. Run them first.

---

### 1. read tool (7 tests)

#### Test 1.1: content mode
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "standard" }
```
**Capture:** From the response, extract `summary.line_count` and the first line of the file content.
**Record:**
| 1.1 | read content mode | lineCount=<N>, firstLine=<exact text> | PASS/FAIL |

---

#### Test 1.2: outline mode
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "outline" }], "verbosity": "standard" }
```
**Capture:** The list of symbol names shown in the outline (function/class/const names).
**Record:**
| 1.2 | read outline mode | symbols=<comma-separated names> | PASS/FAIL |

---

#### Test 1.3: symbols mode
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "symbols" }], "verbosity": "standard" }
```
**Capture:** Count of exported symbols returned.
**Record:**
| 1.3 | read symbols mode | symbol_count=<N> | PASS/FAIL |

---

#### Test 1.4: lines mode (range 1-5)
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "lines", "range": { "start": 1, "end": 5 } }], "verbosity": "standard" }
```
**Capture:** The exact text of line 1.
**Record:**
| 1.4 | read lines mode | line1=<exact text> | PASS/FAIL |

---

#### Test 1.5: batch read two files
**Call:** `read` with parameters:
```json
{
  "files": [
    { "path": "full-suite/src/index.ts", "extract": "outline" },
    { "path": "full-suite/src/auth.ts", "extract": "outline" }
  ],
  "verbosity": "standard"
}
```
**Capture:** The `files_read` count from the summary (should be 2).
**Record:**
| 1.5 | read batch two files | files_read=<N> | PASS/FAIL |

---

#### Test 1.6: count_only format
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "count_only" }
```
**Capture:** The `total_tokens` value from the summary.
**Record:**
| 1.6 | read count_only | total_tokens=<N> | PASS/FAIL |

---

#### Test 1.7: cache test (read same file again)
**Call:** `read` with parameters:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "standard" }
```
**Capture:** The `cache.status` field or equivalent cache indicator. Expected value: `"unchanged"` or `"cached"`.
**Record:**
| 1.7 | read cache status | cache.status=<value> | PASS/FAIL |

---

### 2. find tool (8 tests)

> Known issue: `max_results` has a count/matches mismatch bug. Do NOT test `max_results` in this suite.

#### Test 2.1: files mode — *.ts in src/
**Call:** `find` with parameters:
```json
{ "type": "files", "patterns": ["full-suite/src/*.ts"] }
```
**Capture:** Count of files returned.
**Record:**
| 2.1 | find files *.ts | file_count=<N> | PASS/FAIL |

---

#### Test 2.2: files mode — *.tsx paths
**Call:** `find` with parameters:
```json
{ "type": "files", "patterns": ["full-suite/src/*.tsx"] }
```
**Capture:** The exact file paths returned (e.g. `full-suite/src/Button.tsx`).
**Record:**
| 2.2 | find files *.tsx | paths=<list> | PASS/FAIL |

---

#### Test 2.3: content mode — search "export function"
**Call:** `find` with parameters:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/" }
```
**Capture:** The total match count across all files.
**Record:**
| 2.3 | find content match count | match_count=<N> | PASS/FAIL |

---

#### Test 2.4: content mode — count_only output
**Call:** `find` with parameters:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/", "output": { "format": "count_only" } }
```
**Capture:** The numeric count value.
**Record:**
| 2.4 | find content count_only | count=<N> | PASS/FAIL |

---

#### Test 2.5: content mode — files_only output
**Call:** `find` with parameters:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/", "output": { "format": "files_only" } }
```
**Capture:** The list of file paths returned (no line content, just paths).
**Record:**
| 2.5 | find content files_only | files=<list> | PASS/FAIL |

---

#### Test 2.6: symbols mode — all symbols
**Call:** `find` with parameters:
```json
{ "type": "symbols", "path": "full-suite/src/" }
```
**Capture:** Symbol names and total count.
**Record:**
| 2.6 | find symbols all | symbol_count=<N>, names=<list> | PASS/FAIL |

---

#### Test 2.7: symbols mode — filter kind=class
**Call:** `find` with parameters:
```json
{ "type": "symbols", "path": "full-suite/src/", "filter": { "kind": "class" } }
```
**Capture:** Verify `UserService` appears in the result.
**Record:**
| 2.7 | find symbols class filter | contains_UserService=<true/false> | PASS/FAIL |

---

#### Test 2.8: batch query — two queries with IDs
**Call:** `find` with parameters:
```json
{
  "queries": [
    { "id": "q1", "type": "files", "patterns": ["full-suite/src/*.ts"] },
    { "id": "q2", "type": "content", "pattern": "import", "path": "full-suite/src/" }
  ]
}
```
**Capture:** Both result IDs (`q1` and `q2`) present in the response.
**Record:**
| 2.8 | find batch two queries | result_ids=q1,q2 present=<true/false> | PASS/FAIL |

---

### 3. analyze tool (6 tests)

#### Test 3.1: dependencies
**Call:** `analyze` with parameters:
```json
{ "type": "dependencies", "path": "full-suite/src/" }
```
**Capture:** One import path from the dependency graph (e.g. `"./auth"` or similar).
**Record:**
| 3.1 | analyze dependencies | import_path=<value> | PASS/FAIL |

---

#### Test 3.2: circular dependencies
**Call:** `analyze` with parameters:
```json
{ "type": "circular", "path": "full-suite/src/" }
```
**Capture:** The cycle chain string (e.g. `a.ts → b.ts → a.ts`).
**Record:**
| 3.2 | analyze circular deps | cycle=<chain> | PASS/FAIL |

---

#### Test 3.3: dead code
**Call:** `analyze` with parameters:
```json
{ "type": "dead_code", "path": "full-suite/src/" }
```
**Capture:** Verify `unusedHelper` appears as a dead export.
**Record:**
| 3.3 | analyze dead code | unusedHelper_found=<true/false> | PASS/FAIL |

---

#### Test 3.4: security scan
**Call:** `analyze` with parameters:
```json
{ "type": "security", "path": "full-suite/src/" }
```
**Capture:** The detected secret pattern (should match `AKIA...` or `sk-secret...`).
**Record:**
| 3.4 | analyze security | secret_pattern=<value> | PASS/FAIL |

---

#### Test 3.5: surface on single file
**Call:** `analyze` with parameters:
```json
{ "type": "surface", "path": "full-suite/src/index.ts" }
```
**Capture:** The exported symbol names from the public surface.
**Record:**
| 3.5 | analyze surface | exports=<list> | PASS/FAIL |

---

#### Test 3.6: preview proposed change
**Call:** `analyze` with parameters:
```json
{ "type": "preview", "path": "full-suite/src/index.ts", "find": "greet", "replace": "hello" }
```
**Capture:** A diff line showing the proposed change (e.g. `-greet` / `+hello`).
**Record:**
| 3.6 | analyze preview diff | diff_line=<value> | PASS/FAIL |

---

### 4. inspect tool (5 tests)

#### Test 4.1: project mode
**Call:** `inspect` with parameters:
```json
{ "type": "project", "path": "full-suite/" }
```
**Capture:** The detected `type` (e.g. `"node"`) and `package_manager` (e.g. `"npm"`).
**Record:**
| 4.1 | inspect project | type=<value>, pm=<value> | PASS/FAIL |

---

#### Test 4.2: database mode
**Call:** `inspect` with parameters:
```json
{ "type": "database", "path": "full-suite/" }
```
**Capture:** Model names found (should include `User` and `Post`).
**Record:**
| 4.2 | inspect database | models=<list> | PASS/FAIL |

---

#### Test 4.3: components mode
**Call:** `inspect` with parameters:
```json
{ "type": "components", "path": "full-suite/src/Button.tsx" }
```
**Capture:** The component name and its prop names.
**Record:**
| 4.3 | inspect components | component=<name>, props=<list> | PASS/FAIL |

---

#### Test 4.4: accessibility on Button.tsx
**Call:** `inspect` with parameters:
```json
{ "type": "accessibility", "path": "full-suite/src/Button.tsx" }
```
**Capture:** The specific issue text (should mention `img` without `alt` or similar).
**Record:**
| 4.4 | inspect accessibility | issue=<exact text> | PASS/FAIL |

---

#### Test 4.5: scaffold dry_run
**Call:** `inspect` with parameters:
```json
{ "type": "scaffold", "template": "component", "name": "DryWidget", "dry_run": true }
```
**Capture:** The list of files that would be created (dry run only — no files should actually exist).
**Record:**
| 4.5 | inspect scaffold dry_run | would_create=<list> | PASS/FAIL |

---

### 5. registry tool (4 tests)

#### Test 5.1: list all tools
**Call:** `registry` with parameters:
```json
{ "action": "list" }
```
**Capture:** Total count of tools registered.
**Record:**
| 5.1 | registry list | tool_count=<N> | PASS/FAIL |

---

#### Test 5.2: get schema for read tool
**Call:** `registry` with parameters:
```json
{ "action": "schema", "tool": "read" }
```
**Capture:** One required parameter name from the schema.
**Record:**
| 5.2 | registry schema read | required_param=<name> | PASS/FAIL |

---

#### Test 5.3: search for write tool
**Call:** `registry` with parameters:
```json
{ "action": "search", "query": "write" }
```
**Capture:** Verify `write` tool appears in search results.
**Record:**
| 5.3 | registry search write | write_found=<true/false> | PASS/FAIL |

---

#### Test 5.4: capabilities
**Call:** `registry` with parameters:
```json
{ "action": "capabilities" }
```
**Capture:** One capability category name from the response.
**Record:**
| 5.4 | registry capabilities | category=<name> | PASS/FAIL |

---

## Phase 2: Write Tests

> All writes go to `full-suite/output/`. NEVER write to `src/`.

---

### 6. write tool (5 tests)

#### Test 6.1: create new file
**Call:** `write` with parameters:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "hello from write test", "mode": "fail_if_exists" }] }
```
**Capture:** The `bytes_written` value from the response.
**Record:**
| 6.1 | write create new file | bytes_written=<N> | PASS/FAIL |

---

#### Test 6.2: fail_if_exists on existing file
**Call:** `write` with parameters:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "should fail", "mode": "fail_if_exists" }] }
```
**Capture:** The exact error message text returned.
**Record:**
| 6.2 | write fail_if_exists | error=<exact text> | PASS/FAIL |

---

#### Test 6.3: overwrite with different content
**Call:** `write` with parameters:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "overwritten content — different length!!", "mode": "overwrite" }] }
```
**Capture:** The new `bytes_written` value. It MUST differ from Test 6.1's value.
**Record:**
| 6.3 | write overwrite | new_bytes_written=<N> (differs from 6.1=<N>) | PASS/FAIL |

---

#### Test 6.4: base64 write
**Call:** `write` with parameters:
```json
{ "files": [{ "path": "full-suite/output/b64.txt", "content_base64": "aGVsbG8gYmFzZTY0", "mode": "fail_if_exists" }] }
```
(Note: `aGVsbG8gYmFzZTY0` decodes to `hello base64`)
**Capture:** The `bytes_written` value.
**Record:**
| 6.4 | write base64 | bytes_written=<N> | PASS/FAIL |

---

#### Test 6.5: dry_run — verify no file created
**Call:** `write` with parameters:
```json
{ "files": [{ "path": "full-suite/output/dry.txt", "content": "this should not exist" }], "dry_run": true }
```
**Capture:** Verify `dry_run: true` in the response.
Then immediately call `read` on `full-suite/output/dry.txt` — it must return a file-not-found error.
**Record:**
| 6.5 | write dry_run | dry_run=true, file_exists=false | PASS/FAIL |

---

## Phase 3: Edit Tests

> CRITICAL: Each test uses its own file copy. test-1.ts through test-6.ts were created in Setup.
> NEVER share a file across edit tests. NEVER edit src/index.ts directly.

---

### 7. edit tool (6 tests)

#### Test 7.1: exact match replacement
File: `full-suite/edit-tests/test-1.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [{
    "path": "full-suite/edit-tests/test-1.ts",
    "find": "greet",
    "replace": "hello",
    "match": "exact"
  }]
}
```
**Capture:** The replacement count or diff showing `greet` → `hello`.
**Record:**
| 7.1 | edit exact match | replacements=<N> or diff=<line> | PASS/FAIL |

---

#### Test 7.2: regex replacement
File: `full-suite/edit-tests/test-2.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [{
    "path": "full-suite/edit-tests/test-2.ts",
    "find": "string",
    "replace": "str",
    "match": "regex"
  }]
}
```
**Capture:** The total replacement count (all occurrences of `string` replaced).
**Record:**
| 7.2 | edit regex match | replacement_count=<N> | PASS/FAIL |

---

#### Test 7.3: occurrence=first (only first match)
File: `full-suite/edit-tests/test-3.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [{
    "path": "full-suite/edit-tests/test-3.ts",
    "find": "return",
    "replace": "yield",
    "match": "exact",
    "occurrence": "first"
  }]
}
```
**Capture:** Replacement count must be exactly 1 (only first `return` changed).
Verify with a `read` of test-3.ts — remaining `return` keywords should still exist.
**Record:**
| 7.3 | edit occurrence first | replacements=1, others_unchanged=<true/false> | PASS/FAIL |

---

#### Test 7.4: fuzzy match (whitespace insensitive)
File: `full-suite/edit-tests/test-4.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [{
    "path": "full-suite/edit-tests/test-4.ts",
    "find": "export  function",
    "replace": "export function",
    "match": "fuzzy"
  }]
}
```
(The double space in find string tests whitespace-insensitive matching)
**Capture:** Success indicator or replacement count.
**Record:**
| 7.4 | edit fuzzy match | success=<true/false> or replacements=<N> | PASS/FAIL |

---

#### Test 7.5: dry_run — verify file unchanged
File: `full-suite/edit-tests/test-5.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [{
    "path": "full-suite/edit-tests/test-5.ts",
    "find": "greet",
    "replace": "dryReplaced",
    "match": "exact"
  }],
  "dry_run": true
}
```
**Capture:** The diff output from dry_run.
Then call `read` on `full-suite/edit-tests/test-5.ts` to confirm `dryReplaced` does NOT appear.
**Record:**
| 7.5 | edit dry_run | diff_shown=<true/false>, file_unchanged=<true/false> | PASS/FAIL |

---

#### Test 7.6: atomic failure — one good + one bad edit
File: `full-suite/edit-tests/test-6.ts`
**Call:** `edit` with parameters:
```json
{
  "edits": [
    { "path": "full-suite/edit-tests/test-6.ts", "find": "greet", "replace": "hello", "match": "exact" },
    { "path": "full-suite/edit-tests/test-6.ts", "find": "THIS_STRING_DOES_NOT_EXIST_XYZ", "replace": "fail", "match": "exact" }
  ]
}
```
**Capture:** The error message returned.
Then call `read` on `full-suite/edit-tests/test-6.ts` — the file must be unchanged (atomic rollback means `greet` must still be `greet`).
**Record:**
| 7.6 | edit atomic failure | error=<text>, file_unchanged=<true/false> | PASS/FAIL |

---

## Phase 4: Exec Tests

> These run shell commands. Output goes to stdout/stderr only, not to files unless explicitly stated.

---

### 8. exec tool (5 tests)

#### Test 8.1: echo command
**Call:** `exec` with parameters:
```json
{ "commands": [{ "cmd": "echo 'hello from exec'" }] }
```
**Capture:** The exact stdout text.
**Record:**
| 8.1 | exec echo | stdout=<exact text> | PASS/FAIL |

---

#### Test 8.2: cat package.json
**Call:** `exec` with parameters:
```json
{ "commands": [{ "cmd": "cat full-suite/package.json" }] }
```
**Capture:** The `exit_code` (should be 0) and the first line of stdout.
**Record:**
| 8.2 | exec cat package.json | exit_code=<N>, first_line=<text> | PASS/FAIL |

---

#### Test 8.3: echo with exit_code expectation
**Call:** `exec` with parameters:
```json
{ "commands": [{ "cmd": "echo 'checking expectations'", "expect": { "exit_code": 0 } }] }
```
**Capture:** The `success: true` indicator from the expectation check.
**Record:**
| 8.3 | exec with expectation | success=<true/false> | PASS/FAIL |

---

#### Test 8.4: file_ops — copy file
**Call:** `exec` with parameters:
```json
{ "commands": [{ "cmd": "cp full-suite/src/index.ts full-suite/output/copied.ts" }] }
```
Then call `read` on `full-suite/output/copied.ts` to verify it exists and has content.
**Capture:** That the file exists and the first line matches the original.
**Record:**
| 8.4 | exec copy file | file_exists=<true/false>, first_line=<text> | PASS/FAIL |

---

#### Test 8.5: ls src directory
**Call:** `exec` with parameters:
```json
{ "commands": [{ "cmd": "ls full-suite/src/" }] }
```
**Capture:** The full file listing from stdout.
**Record:**
| 8.5 | exec ls | file_list=<list> | PASS/FAIL |

---

## Phase 5: In-Memory Tests

> These tests use in-memory state, workflow, and agent systems. No file conflicts.

---

### 9. state tool (5 tests)

#### Test 9.1: set a value
**Call:** `state` with parameters:
```json
{ "action": "set", "key": "test_proof", "value": "working" }
```
**Capture:** The `keys_written` count (should be 1).
**Record:**
| 9.1 | state set | keys_written=<N> | PASS/FAIL |

---

#### Test 9.2: get the value back
**Call:** `state` with parameters:
```json
{ "action": "get", "key": "test_proof" }
```
**Capture:** The value returned. Must be exactly `"working"`.
**Record:**
| 9.2 | state get | value=<exact> | PASS/FAIL |

---

#### Test 9.3: budget info
**Call:** `state` with parameters:
```json
{ "action": "budget" }
```
**Capture:** Any numeric field from the response (e.g. `tokens_used`, `session_time_seconds`, etc.).
**Record:**
| 9.3 | state budget | field=<name>, value=<N> | PASS/FAIL |

---

#### Test 9.4: list all keys
**Call:** `state` with parameters:
```json
{ "action": "list" }
```
**Capture:** Verify `test_proof` appears in the key list.
**Record:**
| 9.4 | state list | test_proof_present=<true/false> | PASS/FAIL |

---

#### Test 9.5: clear and verify gone
**Call:** `state` with parameters:
```json
{ "action": "clear", "key": "test_proof" }
```
Then immediately call `state` with `{ "action": "get", "key": "test_proof" }` and verify it returns null or not-found.
**Capture:** The get-after-clear result (must be null/missing).
**Record:**
| 9.5 | state clear | value_after_clear=<null or not-found> | PASS/FAIL |

---

### 10. workflow tool (5 tests)

#### Test 10.1: start a WRFC workflow
**Call:** `workflow` with parameters:
```json
{ "action": "start", "type": "wrfc" }
```
**Capture:** The workflow ID (format: `wf-XXXX`).
**Record:**
| 10.1 | workflow start | wf_id=<wf-XXXX> | PASS/FAIL |

---

#### Test 10.2: get workflow status
**Call:** `workflow` with parameters:
```json
{ "action": "status", "id": "<wf-XXXX from 10.1>" }
```
**Capture:** The `currentState` field. Expected: `"gather"`.
**Record:**
| 10.2 | workflow status | currentState=<value> | PASS/FAIL |

---

#### Test 10.3: transition to plan state
**Call:** `workflow` with parameters:
```json
{ "action": "transition", "id": "<wf-XXXX from 10.1>", "to": "plan" }
```
**Capture:** The success indicator and the new state value.
**Record:**
| 10.3 | workflow transition | success=<true/false>, new_state=<value> | PASS/FAIL |

---

#### Test 10.4: add a trigger
**Call:** `workflow` with parameters:
```json
{ "action": "triggers", "subaction": "add", "id": "<wf-XXXX from 10.1>", "trigger": { "event": "file_change", "pattern": "*.ts" } }
```
**Capture:** The trigger ID (format: `trg-XXXX`).
**Record:**
| 10.4 | workflow triggers add | trg_id=<trg-XXXX> | PASS/FAIL |

---

#### Test 10.5: cancel workflow
**Call:** `workflow` with parameters:
```json
{ "action": "cancel", "id": "<wf-XXXX from 10.1>" }
```
Then call `workflow` with `{ "action": "status", "id": "<wf-XXXX>" }` and capture the new status.
**Capture:** The status after cancel (should be `"cancelled"` or `"terminated"`).
**Record:**
| 10.5 | workflow cancel | status_after=<value> | PASS/FAIL |

---

### 11. agent tool (4 tests)

#### Test 11.1: spawn a researcher agent
**Call:** `agent` with parameters:
```json
{ "action": "spawn", "template": "researcher", "task": "find all exported functions in full-suite/src/" }
```
**Capture:** The agent ID (format: `agent-XXXX`).
**Record:**
| 11.1 | agent spawn | agent_id=<agent-XXXX> | PASS/FAIL |

---

#### Test 11.2: get agent status
**Call:** `agent` with parameters:
```json
{ "action": "status", "id": "<agent-XXXX from 11.1>" }
```
**Capture:** The `status` field value (e.g. `"running"`, `"pending"`, `"complete"`).
**Record:**
| 11.2 | agent status | status=<value> | PASS/FAIL |

---

#### Test 11.3: list templates
**Call:** `agent` with parameters:
```json
{ "action": "templates" }
```
**Capture:** The count of available templates (expected: 5).
**Record:**
| 11.3 | agent templates | template_count=<N> | PASS/FAIL |

---

#### Test 11.4: cancel the agent
**Call:** `agent` with parameters:
```json
{ "action": "cancel", "id": "<agent-XXXX from 11.1>" }
```
Then call `agent` with `{ "action": "status", "id": "<agent-XXXX>" }` and capture the new status.
**Capture:** The status after cancel (should be `"cancelled"` or `"terminated"`).
**Record:**
| 11.4 | agent cancel | status_after=<value> | PASS/FAIL |

---

## Phase 6: Network Tests

> These tests make real HTTP requests. Requires network access.

---

### 12. fetch tool (4 tests)

#### Test 12.1: GET request
**Call:** `fetch` with parameters:
```json
{ "urls": [{ "url": "https://httpbin.org/get" }] }
```
**Capture:** The `url` field from the response JSON (should echo back `https://httpbin.org/get`).
**Record:**
| 12.1 | fetch GET | url_field=<value> | PASS/FAIL |

---

#### Test 12.2: POST request with body
**Call:** `fetch` with parameters:
```json
{
  "urls": [{
    "url": "https://httpbin.org/post",
    "method": "POST",
    "body": { "test_key": "test_value_probe" }
  }]
}
```
**Capture:** The echoed `json.test_key` value from the response (should be `"test_value_probe"`).
**Record:**
| 12.2 | fetch POST body | json.test_key=<value> | PASS/FAIL |

---

#### Test 12.3: extract json mode
**Call:** `fetch` with parameters:
```json
{ "urls": [{ "url": "https://httpbin.org/json", "extract": "json" }] }
```
**Capture:** Any top-level key name from the parsed JSON response.
**Record:**
| 12.3 | fetch extract json | key=<name> | PASS/FAIL |

---

#### Test 12.4: batch fetch two URLs
**Call:** `fetch` with parameters:
```json
{
  "urls": [
    { "url": "https://httpbin.org/get" },
    { "url": "https://httpbin.org/uuid" }
  ]
}
```
**Capture:** The count of results returned (must be 2).
**Record:**
| 12.4 | fetch batch 2 URLs | result_count=<N> | PASS/FAIL |

---

## Summary

After completing all 58 tests:

1. Count rows in TEST-RESULTS.md
2. Count PASSes and FAILs
3. Add this final line to TEST-RESULTS.md:

```
## Final Score
- Total: 58
- Passed: <N>
- Failed: <N>
- Pass rate: <N>%
```

4. If any test FAILed, add a `## Failures` section listing each failed test ID and the captured value that indicated failure.

---

## Known Issues

- **Test 2.x — max_results bug**: The `max_results` parameter has a count/matches mismatch. It is intentionally NOT tested in this suite.
- **Test 12.x — network dependency**: fetch tests require live network access to httpbin.org. If httpbin.org is unreachable, mark those tests as SKIP not FAIL.
