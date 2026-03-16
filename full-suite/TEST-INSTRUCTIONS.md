# Full Suite Test Instructions

This document is a self-contained checklist for an AI agent to verify every mode and option of all 12 native tools in goodvibes-tui. Work through each section top-to-bottom. Mark each item `[x]` when verified. The fixture files you need are all in this directory (`full-suite/`).

**Fixture root:** `/home/buzzkill/Projects/goodvibes-tui/full-suite/`
**Project root:** `/home/buzzkill/Projects/goodvibes-tui/`

---

## 1. `read` — File Reading

Tool schema: `src/tools/read/schema.ts`. Fields: `files[]` (required), `extract`, `output`, `token_budget`, `page`.

### 1.1 content mode (default)
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts" }]` and no `extract` field.
  - **Expected:** Full file content returned with line numbers. Should see `greet`, `add`, `VERSION`, `UserService`, `unusedHelper`.

### 1.2 outline mode
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts", extract: "outline" }]`.
  - **Expected:** Function/class signatures without bodies. Should list `greet`, `add`, `UserService`, `unusedHelper` — no implementation lines.

### 1.3 symbols mode
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts", extract: "symbols" }]`.
  - **Expected:** Only exported symbol names. Should list: `greet`, `add`, `VERSION`, `UserService`, `unusedHelper`.

### 1.4 lines mode with range
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts", extract: "lines", range: { start: 1, end: 5 } }]`.
  - **Expected:** Only lines 1–5 returned. Should show the `greet` function definition only.

### 1.5 ast mode
- [ ] Call `read` with `files: [{ path: "full-suite/src/auth.ts", extract: "ast" }]`.
  - **Expected:** Structural AST outline. May show imports, declarations, and constants.

### 1.6 batch read — multiple files
- [ ] Call `read` with `files` containing three entries:
  ```json
  [
    { "path": "full-suite/src/index.ts", "extract": "symbols" },
    { "path": "full-suite/src/utils.ts", "extract": "outline" },
    { "path": "full-suite/src/auth.ts", "extract": "content" }
  ]
  ```
  - **Expected:** All three files returned in one response. Each uses its own extract mode.

### 1.7 output format: count_only
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts" }]` and `output: { format: "count_only" }`.
  - **Expected:** Only file count and total line count — no file content.

### 1.8 output format: minimal
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts" }]` and `output: { format: "minimal" }`.
  - **Expected:** File path and line count only — no content.

### 1.9 output format: verbose
- [ ] Call `read` with `files: [{ path: "full-suite/package.json" }]` and `output: { format: "verbose" }`.
  - **Expected:** Full content plus metadata (encoding, size, etc.).

### 1.10 max_per_item truncation
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts" }]` and `output: { max_per_item: 5 }`.
  - **Expected:** At most 5 lines returned for the file.

### 1.11 token_budget pagination
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts" }, { path: "full-suite/src/auth.ts" }]`, `token_budget: 100`, `page: 1`.
  - **Expected:** First page of results fitting within the token budget. Note the total page count.
- [ ] If total pages > 1, repeat with `page: 2`.
  - **Expected:** Second page with remaining files.

### 1.12 force — bypass cache
- [ ] Call `read` with `files: [{ path: "full-suite/src/index.ts", force: true }]`.
  - **Expected:** File re-read from disk regardless of cache state.

### 1.13 global extract override with per-file override
- [ ] Call `read` with global `extract: "symbols"` and `files: [{ path: "full-suite/src/index.ts" }, { path: "full-suite/src/auth.ts", extract: "outline" }]`.
  - **Expected:** `index.ts` uses `symbols` (global), `auth.ts` uses `outline` (per-file override).

---

## 2. `write` — File Writing

Tool schema: `src/tools/write/schema.ts`. Fields: `files[]` (required), `verbosity`, `dry_run`.

### 2.1 create a new file
- [ ] Call `write` with:
  ```json
  {
    "files": [{ "path": "full-suite/write-test/new-file.txt", "content": "Hello from write test" }]
  }
  ```
  - **Expected:** File created successfully. Verify by calling `read` on `full-suite/write-test/new-file.txt`.

### 2.2 fail_if_exists (default) — should fail
- [ ] Call `write` again on the same file `full-suite/write-test/new-file.txt` with `mode: "fail_if_exists"` (or omit mode).
  - **Expected:** Error returned because file already exists.

### 2.3 overwrite mode
- [ ] Call `write` with `mode: "overwrite"` on `full-suite/write-test/new-file.txt` with new content `"Overwritten content"`.
  - **Expected:** File successfully overwritten. Verify via `read`.

### 2.4 backup mode
- [ ] Call `write` with `mode: "backup"` on `full-suite/write-test/new-file.txt` with content `"Backup version"`.
  - **Expected:** Original file backed up to `.goodvibes/.backups/`, new content written. Check `.goodvibes/.backups/` for the backup file.

### 2.5 dry_run
- [ ] Call `write` with `dry_run: true` and `files: [{ path: "full-suite/write-test/dry-run-file.txt", content: "Should not exist" }]`.
  - **Expected:** Response shows what would be written but no file created. Confirm by trying to `read` the file — it should not exist.

### 2.6 verbosity: count_only
- [ ] Call `write` with a new file and `verbosity: "count_only"`.
  - **Expected:** Only a count of files written — no paths or content.

### 2.7 verbosity: minimal
- [ ] Call `write` with a new file and `verbosity: "minimal"`.
  - **Expected:** File paths and basic status — no full content echo.

### 2.8 verbosity: verbose
- [ ] Call `write` with a new file and `verbosity: "verbose"`.
  - **Expected:** Full details including paths, byte counts, and modes.

### 2.9 content_base64
- [ ] Call `write` with `content_base64` containing the base64 encoding of `"Base64 content test"`.
  - Encode: `echo -n "Base64 content test" | base64` → `QmFzZTY0IGNvbnRlbnQgdGVzdA==`
  - **Expected:** File created with decoded content. Verify via `read`.

### 2.10 batch write — multiple files
- [ ] Call `write` with `files` array containing 3 new files at once in `full-suite/write-test/`.
  - **Expected:** All 3 files created in one call.

---

## 3. `edit` — File Editing

Tool schema: `src/tools/edit/schema.ts`. Fields: `edits[]` (required), `match`, `transaction`, `output`, `dry_run`.

**Setup:** Use `full-suite/src/index.ts` for edits. Read it first to confirm current content.

### 3.1 exact match (default)
- [ ] Call `edit` with:
  ```json
  {
    "edits": [{
      "path": "full-suite/src/index.ts",
      "find": "return `Hello, ${name}!`;",
      "replace": "return `Hello, ${name}! (edited)`;"
    }]
  }
  ```
  - **Expected:** Exact string replaced. Verify via `read`.
- [ ] Revert: edit it back to `return \`Hello, ${name}!\`;`

### 3.2 fuzzy match mode
- [ ] Call `edit` with `match: { mode: "fuzzy" }` and a `find` string with slightly different whitespace than the actual file content.
  - **Example:** `find: "return  `Hello,  ${name}!`;"` (extra spaces)
  - **Expected:** Match succeeds despite whitespace differences.

### 3.3 regex match mode
- [ ] Call `edit` with `match: { mode: "regex" }` and `find: "export const VERSION = '.*';"`.
  - Replace with `"export const VERSION = '2.0.0';"`
  - **Expected:** Regex matches and replaces the VERSION constant.
- [ ] Revert to `'1.0.0'`.

### 3.4 occurrence: first
- [ ] Add a second occurrence of the word `users` by reading and editing `full-suite/src/index.ts`. Then call `edit` with `occurrence: "first"` to replace only the first occurrence.
  - **Expected:** Only the first match replaced.

### 3.5 occurrence: last
- [ ] Call `edit` with `occurrence: "last"` to replace only the last occurrence of a repeated string.
  - **Expected:** Only the last match replaced.

### 3.6 occurrence: all
- [ ] Call `edit` with `occurrence: "all"` targeting a pattern that appears multiple times.
  - **Expected:** All occurrences replaced.

### 3.7 occurrence: N (specific number)
- [ ] Call `edit` with `occurrence: 2` to replace the 2nd occurrence of a repeated string.
  - **Expected:** Only the 2nd occurrence replaced.

### 3.8 hints: near_line
- [ ] Call `edit` with a `hints: { near_line: 10 }` to prefer the match closest to line 10.
  - **Expected:** The match closest to line 10 is replaced.

### 3.9 hints: in_function
- [ ] Call `edit` with `hints: { in_function: "greet" }` to restrict match to within the `greet` function.
  - **Expected:** Only matches inside `greet` are replaced.

### 3.10 hints: in_class
- [ ] Call `edit` with `hints: { in_class: "UserService" }` to restrict match to within the `UserService` class.
  - **Expected:** Only matches inside `UserService` are replaced.

### 3.11 transaction: atomic (default)
- [ ] Call `edit` with two edits where the second one uses an invalid `find` string.
  - **Expected:** Both edits rolled back — no partial changes applied.

### 3.12 transaction: partial
- [ ] Call `edit` with `transaction: { mode: "partial" }` and two edits where one is invalid.
  - **Expected:** The valid edit is applied; the invalid one is skipped and reported as failed.

### 3.13 transaction: none
- [ ] Call `edit` with `transaction: { mode: "none" }` and two edits where one is invalid.
  - **Expected:** Each edit applied independently; failed edit does not affect others.

### 3.14 dry_run
- [ ] Call `edit` with `dry_run: true` and a valid edit.
  - **Expected:** Diff shown but no file changes. Verify via `read` that file is unchanged.

### 3.15 output: with_diff
- [ ] Call `edit` with `output: { format: "with_diff" }` and a real change.
  - **Expected:** Response includes a unified diff showing before/after.

### 3.16 output: verbose
- [ ] Call `edit` with `output: { format: "verbose" }` and a real change.
  - **Expected:** Full detail including pre/post content for each edit.

### 3.17 id field for tracking
- [ ] Call `edit` with `edits: [{ id: "my-edit-1", path: "...", find: "...", replace: "..." }]`.
  - **Expected:** Result includes `id: "my-edit-1"` keying the result entry.

### 3.18 base64 find/replace
- [ ] Call `edit` with `find_base64` and `replace_base64` fields instead of `find`/`replace`.
  - **Expected:** Edit succeeds using base64-decoded strings.

---

## 4. `find` — Codebase Search

Tool schema: `src/tools/find/schema.ts`. Fields: `queries[]` (required), `output`, `parallel`.

### 4.1 mode: files — glob pattern
- [ ] Call `find` with:
  ```json
  {
    "queries": [{ "id": "ts-files", "mode": "files", "patterns": ["full-suite/src/**/*.ts"] }]
  }
  ```
  - **Expected:** Lists `index.ts`, `utils.ts`, `auth.ts` and `test/index.test.ts`.

### 4.2 mode: files — with exclude
- [ ] Call `find` with `patterns: ["full-suite/src/**/*"]` and `exclude: ["full-suite/src/components/**"]`.
  - **Expected:** Returns TypeScript files but excludes the `components/` directory.

### 4.3 mode: content — basic grep
- [ ] Call `find` with:
  ```json
  {
    "queries": [{ "id": "exports", "mode": "content", "pattern": "export function", "glob": "full-suite/src/**/*.ts" }]
  }
  ```
  - **Expected:** All files containing `export function` — should match `index.ts`, `utils.ts`, `auth.ts`.

### 4.4 mode: content — case_sensitive: false
- [ ] Call `find` with `pattern: "EXPORT FUNCTION"` and `case_sensitive: false`.
  - **Expected:** Same results as case-sensitive search on `"export function"`.

### 4.5 mode: content — whole_word
- [ ] Call `find` with `pattern: "add"` and `whole_word: true` in `full-suite/src/`.
  - **Expected:** Matches `add` as a whole word, not `addUser`.

### 4.6 mode: content — multiline
- [ ] Call `find` with `multiline: true` and a pattern spanning two lines, e.g. `"export class UserService\\s*\\{"` in `full-suite/src/index.ts`.
  - **Expected:** Matches the class declaration across line boundaries.

### 4.7 mode: content — negate
- [ ] Call `find` with `pattern: "import"` and `negate: true` in `full-suite/src/**/*.ts`.
  - **Expected:** Returns files that do NOT contain `import` — should include `index.ts` (no imports at top level).

### 4.8 mode: symbols — all symbols
- [ ] Call `find` with:
  ```json
  {
    "queries": [{ "id": "all-syms", "mode": "symbols", "path": "full-suite/src/" }]
  }
  ```
  - **Expected:** All symbols across all TS files in `src/`.

### 4.9 mode: symbols — by name query
- [ ] Call `find` with `query: "User"` in symbols mode.
  - **Expected:** Returns `UserService`, `getUser`, `addUser`, `listUsers`, `formatUserName`.

### 4.10 mode: symbols — by kinds
- [ ] Call `find` with `kinds: ["class"]` in symbols mode over `full-suite/src/`.
  - **Expected:** Only class declarations — `UserService`.

### 4.11 mode: symbols — exported_only
- [ ] Call `find` with `exported_only: true` in symbols mode.
  - **Expected:** Only exported symbols. Private fields of `UserService` (`users`) should be excluded.

### 4.12 output: count_only
- [ ] Call `find` with `output: { format: "count_only" }` on a content query.
  - **Expected:** Only match counts — no file paths or line content.

### 4.13 output: files_only
- [ ] Call `find` with `output: { format: "files_only" }` on a content query.
  - **Expected:** Only file paths — no line numbers or matched text.

### 4.14 output: locations
- [ ] Call `find` with `output: { format: "locations" }` on a content query.
  - **Expected:** File paths with line numbers for each match.

### 4.15 output: matches
- [ ] Call `find` with `output: { format: "matches" }` on a content query.
  - **Expected:** File paths, line numbers, and the matched line text.

### 4.16 output: context
- [ ] Call `find` with `output: { format: "context" }`, `context_before: 2`, `context_after: 2`.
  - **Expected:** Each match shown with 2 lines before and after.

### 4.17 max_results limit
- [ ] Call `find` with `output: { max_results: 1 }` on a query with multiple expected matches.
  - **Expected:** At most 1 result returned.

### 4.18 max_per_item limit
- [ ] Call `find` with `output: { max_per_item: 1 }` on a multi-match query.
  - **Expected:** At most 1 match per file.

### 4.19 batch queries — multiple in parallel
- [ ] Call `find` with two queries in the `queries` array and `parallel: true`.
  - **Expected:** Both queries execute and both results returned in one response.

### 4.20 path scoping
- [ ] Call `find` with `path: "full-suite/src/components/"` for a content query.
  - **Expected:** Search scoped to the `components/` subdirectory.

---

## 5. `exec` — Command Execution

Tool schema: `src/tools/exec/schema.ts`. Fields: `commands[]` (required), `parallel`, `working_dir`, `timeout_ms`, `verbosity`, `file_ops`.

### 5.1 basic command
- [ ] Call `exec` with `commands: [{ cmd: "echo hello" }]`.
  - **Expected:** stdout contains `hello`, exit code 0.

### 5.2 working_dir
- [ ] Call `exec` with `working_dir: "/home/buzzkill/Projects/goodvibes-tui/full-suite"` and `cmd: "pwd"`.
  - **Expected:** stdout is the full-suite directory path.

### 5.3 per-command cwd override
- [ ] Call `exec` with `commands: [{ cmd: "pwd", cwd: "/tmp" }]`.
  - **Expected:** stdout is `/tmp`.

### 5.4 env vars
- [ ] Call `exec` with `commands: [{ cmd: "echo $MY_VAR", env: { "MY_VAR": "test-value" } }]`.
  - **Expected:** stdout contains `test-value`.

### 5.5 expect: exit_code
- [ ] Call `exec` with `expect: { exit_code: 0 }` on a successful command.
  - **Expected:** No expectation error.
- [ ] Call `exec` with `expect: { exit_code: 0 }` on a failing command (e.g. `cmd: "exit 1"`).
  - **Expected:** Expectation error reported in the result.

### 5.6 expect: stdout_contains
- [ ] Call `exec` with `expect: { stdout_contains: "passed" }` and `cmd: "npm test"` in `full-suite/`.
  - **Expected:** No expectation error because `npm test` echoes `all tests passed`.

### 5.7 expect: stderr_contains
- [ ] Call `exec` with a command that writes to stderr, e.g. `cmd: ">&2 echo 'warn'"`, and `expect: { stderr_contains: "warn" }`.
  - **Expected:** No expectation error.

### 5.8 timeout_ms
- [ ] Call `exec` with `commands: [{ cmd: "sleep 5", timeout_ms: 100 }]`.
  - **Expected:** Command times out, `timed_out: true` in result.

### 5.9 background execution
- [ ] Call `exec` with `commands: [{ cmd: "sleep 2", background: true }]`.
  - **Expected:** Returns immediately with a `process_id`. Note the `process_id`.

### 5.10 retry
- [ ] Call `exec` with `commands: [{ cmd: "exit 1", retry: { max: 2, delay_ms: 100, backoff: "fixed" } }]`.
  - **Expected:** Command retried 2 times before failing. Result includes `retries: 2`.

### 5.11 retry with exponential backoff
- [ ] Call `exec` with `retry: { max: 2, delay_ms: 50, backoff: "exponential" }` on a failing command.
  - **Expected:** Retried with increasing delays.

### 5.12 until — pattern-based early termination
- [ ] Call `exec` with `until: { pattern: "passed", timeout_ms: 5000 }` and `cmd: "npm test"` in `full-suite/`.
  - **Expected:** Command terminates early when `passed` appears in output.

### 5.13 until — kill_after: true
- [ ] Call `exec` with `until: { pattern: "complete", kill_after: true }` and a long-running command.
  - **Expected:** Process killed after pattern match.

### 5.14 parallel execution
- [ ] Call `exec` with `parallel: true` and two commands: `echo A` and `echo B`.
  - **Expected:** Both run concurrently, both results returned.

### 5.15 batch sequential commands
- [ ] Call `exec` with three sequential commands: `echo step1`, `echo step2`, `echo step3`.
  - **Expected:** All three run in order, all results returned.

### 5.16 verbosity: count_only
- [ ] Call `exec` with `verbosity: "count_only"` on a command.
  - **Expected:** Only exit code(s) — no stdout/stderr content.

### 5.17 verbosity: minimal
- [ ] Call `exec` with `verbosity: "minimal"`.
  - **Expected:** Exit codes plus first line of stdout/stderr.

### 5.18 verbosity: verbose
- [ ] Call `exec` with `verbosity: "verbose"`.
  - **Expected:** Full output plus timing, cwd, and env details.

### 5.19 file_ops: copy before command
- [ ] Call `exec` with:
  ```json
  {
    "file_ops": [{ "op": "copy", "source": "full-suite/data/sample.json", "destination": "full-suite/write-test/sample-copy.json" }],
    "commands": [{ "cmd": "echo copied" }]
  }
  ```
  - **Expected:** File is copied before the command runs. Verify the copy exists.

### 5.20 file_ops: delete
- [ ] Call `exec` with `file_ops: [{ "op": "delete", "source": "full-suite/write-test/sample-copy.json" }]` and a command.
  - **Expected:** File deleted before command runs.

### 5.21 file_ops: move
- [ ] Call `exec` with `file_ops: [{ "op": "move", "source": "full-suite/write-test/new-file.txt", "destination": "full-suite/write-test/moved-file.txt" }]`.
  - **Expected:** File moved; original no longer exists, destination created.

### 5.22 npm scripts from full-suite
- [ ] Call `exec` with `cmd: "npm run build"` in `full-suite/`.
  - **Expected:** stdout contains `build complete`.
- [ ] Call `exec` with `cmd: "npm run lint"` in `full-suite/`.
  - **Expected:** stdout contains `no lint errors`.

---

## 6. `fetch` — HTTP Requests

Tool schema: `src/tools/fetch/schema.ts`. Fields: `urls[]` (required), `extract`, `parallel`, `verbosity`.

### 6.1 GET request — raw extract
- [ ] Call `fetch` with:
  ```json
  {
    "urls": [{ "url": "https://httpbin.org/get", "extract": "raw" }]
  }
  ```
  - **Expected:** Raw HTTP response body (JSON from httpbin).

### 6.2 GET request — text extract
- [ ] Call `fetch` with `extract: "text"` on `https://example.com`.
  - **Expected:** Plain text with HTML tags stripped.

### 6.3 GET request — json extract
- [ ] Call `fetch` with `extract: "json"` on `https://httpbin.org/get`.
  - **Expected:** Parsed and formatted JSON response.

### 6.4 GET request — markdown extract
- [ ] Call `fetch` with `extract: "markdown"` on `https://example.com`.
  - **Expected:** HTML converted to markdown format.

### 6.5 GET request — readable extract
- [ ] Call `fetch` with `extract: "readable"` on a page with nav/footer (e.g. `https://example.com`).
  - **Expected:** Main article content extracted, nav/sidebar/footer stripped.

### 6.6 GET request — links extract
- [ ] Call `fetch` with `extract: "links"` on `https://example.com`.
  - **Expected:** List of all URLs found on the page.

### 6.7 GET request — metadata extract
- [ ] Call `fetch` with `extract: "metadata"` on `https://example.com`.
  - **Expected:** Title, og-tags, and other head metadata.

### 6.8 POST request with JSON body
- [ ] Call `fetch` with:
  ```json
  {
    "urls": [{
      "url": "https://httpbin.org/post",
      "method": "POST",
      "body": "{\"key\": \"value\"}",
      "body_type": "json",
      "extract": "json"
    }]
  }
  ```
  - **Expected:** httpbin echoes the posted JSON back; verify `key: value` in response.

### 6.9 POST request with form body
- [ ] Call `fetch` with `method: "POST"`, `body: "field=hello"`, `body_type: "form"` on `https://httpbin.org/post`.
  - **Expected:** Form data echoed in httpbin response.

### 6.10 custom headers
- [ ] Call `fetch` with `headers: { "X-Custom-Header": "test-value" }` on `https://httpbin.org/headers`.
  - **Expected:** Response includes `X-Custom-Header: test-value`.

### 6.11 per-URL timeout
- [ ] Call `fetch` with `timeout_ms: 100` on a slow endpoint.
  - **Expected:** Request times out with a timeout error.

### 6.12 parallel fetch
- [ ] Call `fetch` with two URLs and `parallel: true`.
  - **Expected:** Both fetched concurrently, both results in one response.

### 6.13 verbosity: count_only
- [ ] Call `fetch` with `verbosity: "count_only"`.
  - **Expected:** Only total URL count and status codes.

### 6.14 verbosity: minimal
- [ ] Call `fetch` with `verbosity: "minimal"`.
  - **Expected:** URL, status code, and byte size — no content.

### 6.15 verbosity: verbose
- [ ] Call `fetch` with `verbosity: "verbose"`.
  - **Expected:** All metadata including headers, timing, redirects.

### 6.16 global extract with per-URL override
- [ ] Call `fetch` with global `extract: "text"` and one URL overriding to `extract: "json"`.
  - **Expected:** First URL uses `text`, overriding URL uses `json`.

---

## 7. `analyze` — Code Analysis

Tool schema: `src/tools/analyze/schema.ts`. Fields: `mode` (required), `files`, `projectRoot`, `changes`, `submode`, `securityScope`, `before`, `after`, `find`, `replace`, `include`, `output`.

**Note:** Use `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"` or `files: ["full-suite/src/"]` for all tests.

### 7.1 mode: dependencies — analyze
- [ ] Call `analyze` with `mode: "dependencies"`, `submode: "analyze"`, `files: ["full-suite/src/"]`.
  - **Expected:** Dependency graph showing imports between `index.ts`, `utils.ts`, `auth.ts`, and `components/`.

### 7.2 mode: dependencies — circular
- [ ] Call `analyze` with `mode: "dependencies"`, `submode: "circular"`, `files: ["full-suite/src/"]`.
  - **Expected:** Circular dependency detected between `utils.ts` and `auth.ts`.

### 7.3 mode: dead_code
- [ ] Call `analyze` with `mode: "dead_code"`, `files: ["full-suite/src/"]`.
  - **Expected:** `unusedHelper` in `index.ts` flagged as unreferenced export.

### 7.4 mode: security — all
- [ ] Call `analyze` with `mode: "security"`, `securityScope: "all"`, `files: ["full-suite/src/"]`.
  - **Expected:** Hardcoded secrets detected in `auth.ts`: `SECRET_TOKEN` (`sk-secret-...`) and `API_KEY` (`AKIA...`).

### 7.5 mode: security — secrets only
- [ ] Call `analyze` with `mode: "security"`, `securityScope: "secrets"`, `files: ["full-suite/src/auth.ts"]`.
  - **Expected:** Reports the two hardcoded secret strings in `auth.ts`.

### 7.6 mode: security — env
- [ ] Call `analyze` with `mode: "security"`, `securityScope: "env"`, `files: ["full-suite/"]`.
  - **Expected:** Detects `.env.example` with placeholder secrets; reports env usage patterns.

### 7.7 mode: surface
- [ ] Call `analyze` with `mode: "surface"`, `files: ["full-suite/src/"]`.
  - **Expected:** Summary of all public exports: functions, classes, constants.

### 7.8 mode: surface — with include sections
- [ ] Call `analyze` with `mode: "surface"`, `include: ["deps", "security", "api"]`.
  - **Expected:** Surface output includes dependency, security, and API sections.

### 7.9 mode: preview
- [ ] Call `analyze` with `mode: "preview"`, `files: ["full-suite/src/index.ts"]`, `find: "VERSION = '1.0.0'"`, `replace: "VERSION = '2.0.0'"`.
  - **Expected:** Diff shown without writing. File unchanged after call.

### 7.10 mode: diff — git ref
- [ ] Call `analyze` with `mode: "diff"`, `before: "HEAD~1"`, `after: "HEAD"`, `files: ["full-suite/"]`.
  - **Expected:** Git diff between the two refs for files in `full-suite/`. (May show no changes if no recent commits touch this dir.)

### 7.11 mode: impact
- [ ] Call `analyze` with `mode: "impact"`, `files: ["full-suite/src/utils.ts"]`, `changes: "Rename formatVersion to formatSemVer"`.
  - **Expected:** Impact report showing which files import `formatVersion` and would be affected.

### 7.12 output: summary format
- [ ] Call `analyze` with `output: { format: "summary" }` on any mode.
  - **Expected:** Condensed overview output.

### 7.13 output: detailed format
- [ ] Call `analyze` with `output: { format: "detailed" }` on any mode.
  - **Expected:** Full analysis detail.

### 7.14 output: json format
- [ ] Call `analyze` with `output: { format: "json" }` on any mode.
  - **Expected:** Raw JSON structure returned.

---

## 8. `inspect` — Project Inspection

Tool schema: `src/tools/inspect/schema.ts`. Fields: `mode` (required), `projectRoot`, `file`, `framework`, `schemaPath`, `moduleName`, `dryRun`, `output`.

### 8.1 mode: project
- [ ] Call `inspect` with `mode: "project"`, `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"`.
  - **Expected:** Project info: type `nodejs`, name `full-suite-test`, version `1.0.0`, TypeScript enabled, scripts listed.

### 8.2 mode: api — auto-detect framework
- [ ] Call `inspect` with `mode: "api"`, `framework: "auto"`, `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"`.
  - **Expected:** Framework detected (likely `nodejs`/unknown), any route definitions scanned.

### 8.3 mode: database — default prisma path
- [ ] Call `inspect` with `mode: "database"`, `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"`.
  - **Expected:** Parses `prisma/schema.prisma`. Returns models: `User` (fields: id, email, name, posts, createdAt) and `Post` (fields: id, title, content, author, authorId, published).

### 8.4 mode: database — explicit schemaPath
- [ ] Call `inspect` with `mode: "database"`, `schemaPath: "/home/buzzkill/Projects/goodvibes-tui/full-suite/prisma/schema.prisma"`.
  - **Expected:** Same result as 8.3.

### 8.5 mode: components
- [ ] Call `inspect` with `mode: "components"`, `file: "/home/buzzkill/Projects/goodvibes-tui/full-suite/src/components/Button.tsx"`.
  - **Expected:** Component info: name `Button`, props `label`, `onClick`, `variant`, hooks `useState`, `useCallback`.

### 8.6 mode: components — Card component
- [ ] Call `inspect` with `mode: "components"`, `file: "/home/buzzkill/Projects/goodvibes-tui/full-suite/src/components/Card.tsx"`.
  - **Expected:** Component info: name `Card`, props `title`, `children`, children includes `Button`.

### 8.7 mode: layout
- [ ] Call `inspect` with `mode: "layout"`, `file: "/home/buzzkill/Projects/goodvibes-tui/full-suite/styles/main.css"`.
  - **Expected:** Layout info: display `flex`, flex props `flex-direction: column`, sizing `max-width: 1200px`, overflow `overflow-y: auto`.

### 8.8 mode: accessibility
- [ ] Call `inspect` with `mode: "accessibility"`, `file: "/home/buzzkill/Projects/goodvibes-tui/full-suite/src/components/Button.tsx"`.
  - **Expected:** A11y issues found: (1) `<div>` with `onClick` is not keyboard accessible (WCAG 2.1.1), (2) `<img>` missing `alt` attribute (WCAG 1.1.1).

### 8.9 mode: scaffold — dry run
- [ ] Call `inspect` with `mode: "scaffold"`, `moduleName: "payment"`, `dryRun: true`, `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"`.
  - **Expected:** Returns file plan (paths and content templates) for a `payment` module without writing anything.

### 8.10 mode: scaffold — write files
- [ ] Call `inspect` with `mode: "scaffold"`, `moduleName: "payment"`, `dryRun: false`, `projectRoot: "/home/buzzkill/Projects/goodvibes-tui/full-suite"`.
  - **Expected:** Scaffold files actually written. Verify with `find` or `read`.

### 8.11 output: summary
- [ ] Call `inspect` with `output: { format: "summary" }` on any mode.
  - **Expected:** Condensed output.

### 8.12 output: json
- [ ] Call `inspect` with `output: { format: "json" }` on any mode.
  - **Expected:** Raw JSON structure.

---

## 9. `agent` — Subagent Management

Tool schema: `src/tools/agent/schema.ts`. Fields: `mode` (required), `task`, `template`, `model`, `provider`, `tools`, `context`, `agentId`.

### 9.1 mode: templates
- [ ] Call `agent` with `mode: "templates"`.
  - **Expected:** Lists available templates: `engineer`, `reviewer`, `tester`, `researcher`, `general`. Each with its default tool set.

### 9.2 mode: list — empty
- [ ] Call `agent` with `mode: "list"` before spawning anything.
  - **Expected:** Empty list or message indicating no agents running.

### 9.3 mode: spawn — general template
- [ ] Call `agent` with:
  ```json
  {
    "mode": "spawn",
    "task": "List all TypeScript files in full-suite/src/ and return their names.",
    "template": "general"
  }
  ```
  - **Expected:** Returns an `agentId`. Note it for subsequent calls.

### 9.4 mode: status
- [ ] Call `agent` with `mode: "status"`, `agentId: "<id from 9.3>"`.
  - **Expected:** Status returned: one of `running`, `completed`, `failed`. If completed, output included.

### 9.5 mode: list — active agents
- [ ] Call `agent` with `mode: "list"` after spawning.
  - **Expected:** Lists the spawned agent with its ID and current status.

### 9.6 mode: spawn — researcher template
- [ ] Call `agent` with `mode: "spawn"`, `template: "researcher"`, `task: "What exports does full-suite/src/index.ts have?"`.
  - **Expected:** Returns agentId for a researcher-template agent.

### 9.7 mode: spawn — engineer template with tools override
- [ ] Call `agent` with `mode: "spawn"`, `template: "engineer"`, `tools: ["read", "write"]`, `task: "Read full-suite/README.md and summarize it."`.
  - **Expected:** Agent spawned with only `read` and `write` tools.

### 9.8 mode: spawn — with context
- [ ] Call `agent` with `mode: "spawn"`, `context: "The project uses TypeScript and React."`, `task: "Describe the component structure in full-suite/src/components/."` 
  - **Expected:** Agent receives the additional context in its prompt.

### 9.9 mode: spawn — with model override
- [ ] Call `agent` with `mode: "spawn"`, `model: "haiku"` (or any valid model name), `task: "Echo: test complete.".
  - **Expected:** Agent spawned using the specified model.

### 9.10 mode: cancel
- [ ] Spawn a long-running agent task (`task: "Wait 30 seconds then say done."`), note the agentId.
- [ ] Immediately call `agent` with `mode: "cancel"`, `agentId: "<id>"`.
  - **Expected:** Agent cancelled. Subsequent `status` call shows `cancelled` or `failed`.

---

## 10. `state` — Session State & Memory

Tool schema: `src/tools/state/schema.ts`. Fields: `mode` (required), `keys`, `values`, `prefix`, `clearKeys`, `memoryAction`, `memoryKey`, `memoryValue`.

### 10.1 mode: set
- [ ] Call `state` with:
  ```json
  {
    "mode": "set",
    "values": { "test_key": "hello", "test_count": 42, "test_flag": true }
  }
  ```
  - **Expected:** Values stored. Success confirmation returned.

### 10.2 mode: get
- [ ] Call `state` with `mode: "get"`, `keys: ["test_key", "test_count"]`.
  - **Expected:** Returns `{ test_key: "hello", test_count: 42 }`.

### 10.3 mode: get — missing key
- [ ] Call `state` with `mode: "get"`, `keys: ["nonexistent_key"]`.
  - **Expected:** Key is missing or null — no error thrown.

### 10.4 mode: list
- [ ] Call `state` with `mode: "list"`.
  - **Expected:** Lists all keys currently in session state — should include `test_key`, `test_count`, `test_flag`.

### 10.5 mode: list — with prefix filter
- [ ] Call `state` with `mode: "list"`, `prefix: "test_"`.
  - **Expected:** Only keys starting with `test_` returned.

### 10.6 mode: clear — specific keys
- [ ] Call `state` with `mode: "clear"`, `clearKeys: ["test_flag"]`.
  - **Expected:** `test_flag` removed. Verify with `mode: "get"`.

### 10.7 mode: clear — all keys
- [ ] Call `state` with `mode: "clear"` and no `clearKeys` (or empty array).
  - **Expected:** All session state cleared (or all test keys removed per implementation).

### 10.8 mode: budget
- [ ] Call `state` with `mode: "budget"`.
  - **Expected:** Returns current token usage stats for the session: tokens used, remaining budget, cost estimate.

### 10.9 mode: context
- [ ] Call `state` with `mode: "context"`.
  - **Expected:** Returns conversation metadata: session ID, turn count, model, provider.

### 10.10 mode: memory — list
- [ ] Call `state` with `mode: "memory"`, `memoryAction: "list"`.
  - **Expected:** Lists all `.goodvibes/memory/` keys available.

### 10.11 mode: memory — set
- [ ] Call `state` with `mode: "memory"`, `memoryAction: "set"`, `memoryKey: "test-memory"`, `memoryValue: "{\"note\": \"test memory entry\"}"` .
  - **Expected:** Memory file `test-memory.json` (or similar) written to `.goodvibes/memory/`.

### 10.12 mode: memory — get
- [ ] Call `state` with `mode: "memory"`, `memoryAction: "get"`, `memoryKey: "test-memory"`.
  - **Expected:** Returns the value written in 10.11.

### 10.13 mode: telemetry
- [ ] Call `state` with `mode: "telemetry"`.
  - **Expected:** Returns session telemetry: tool call counts, success/failure rates, token usage per tool.

---

## 11. `workflow` — Workflow State Machines

Tool schema: `src/tools/workflow/schema.ts`. Fields: `mode` (required), `definition`, `task`, `workflowId`, `targetState`, `triggerAction`, `triggerId`, `triggerDefinition`, `scheduleAction`, `scheduleName`, `scheduleInterval`, `scheduleCommand`.

### 11.1 mode: list — empty
- [ ] Call `workflow` with `mode: "list"` before starting any workflows.
  - **Expected:** Empty list or no active workflows message.

### 11.2 mode: start — wrfc workflow
- [ ] Call `workflow` with:
  ```json
  {
    "mode": "start",
    "definition": "wrfc",
    "task": "Add a formatDate utility function to full-suite/src/utils.ts"
  }
  ```
  - **Expected:** Workflow created with a `workflowId`. Note it.

### 11.3 mode: status
- [ ] Call `workflow` with `mode: "status"`, `workflowId: "<id from 11.2>"`.
  - **Expected:** Current state of the workflow (e.g. `waiting`, `running`, `review`).

### 11.4 mode: list — active workflows
- [ ] Call `workflow` with `mode: "list"` after starting one.
  - **Expected:** Lists the active workflow with its ID, definition, and state.

### 11.5 mode: transition
- [ ] Call `workflow` with `mode: "transition"`, `workflowId: "<id>"`, `targetState: "review"` (or whatever valid next state exists).
  - **Expected:** Workflow transitions to the target state.

### 11.6 mode: start — fix_loop workflow
- [ ] Call `workflow` with `mode: "start"`, `definition: "fix_loop"`, `task: "Fix TypeScript errors in full-suite/src/"`.
  - **Expected:** New workflow started. Returns new `workflowId`.

### 11.7 mode: start — review_only workflow
- [ ] Call `workflow` with `mode: "start"`, `definition: "review_only"`, `task: "Review full-suite/src/auth.ts for security issues"`.
  - **Expected:** New workflow started.

### 11.8 mode: cancel
- [ ] Call `workflow` with `mode: "cancel"`, `workflowId: "<id from 11.6>"`.
  - **Expected:** Workflow cancelled. Subsequent `status` shows `cancelled`.

### 11.9 mode: triggers — list
- [ ] Call `workflow` with `mode: "triggers"`, `triggerAction: "list"`.
  - **Expected:** Lists all registered automation triggers (may be empty).

### 11.10 mode: triggers — add
- [ ] Call `workflow` with:
  ```json
  {
    "mode": "triggers",
    "triggerAction": "add",
    "triggerDefinition": {
      "event": "Post:file:write",
      "condition": "payload.path.endsWith('.ts')",
      "action": "echo TypeScript file written"
    }
  }
  ```
  - **Expected:** Trigger registered. Returns a `triggerId`.

### 11.11 mode: triggers — enable/disable
- [ ] Call `workflow` with `mode: "triggers"`, `triggerAction: "disable"`, `triggerId: "<id from 11.10>"`.
  - **Expected:** Trigger disabled.
- [ ] Re-enable with `triggerAction: "enable"`.
  - **Expected:** Trigger re-enabled.

### 11.12 mode: triggers — remove
- [ ] Call `workflow` with `mode: "triggers"`, `triggerAction: "remove"`, `triggerId: "<id from 11.10>"`.
  - **Expected:** Trigger removed. No longer in list.

### 11.13 mode: schedule — list
- [ ] Call `workflow` with `mode: "schedule"`, `scheduleAction: "list"`.
  - **Expected:** Lists all scheduled tasks (may be empty).

### 11.14 mode: schedule — add
- [ ] Call `workflow` with:
  ```json
  {
    "mode": "schedule",
    "scheduleAction": "add",
    "scheduleName": "heartbeat",
    "scheduleInterval": "5m",
    "scheduleCommand": "echo heartbeat tick"
  }
  ```
  - **Expected:** Schedule entry `heartbeat` created.

### 11.15 mode: schedule — remove
- [ ] Call `workflow` with `mode: "schedule"`, `scheduleAction: "remove"`, `scheduleName: "heartbeat"`.
  - **Expected:** Schedule entry removed.

---

## 12. `registry` — Skill & Agent Registry

Tool schema: `src/tools/registry-tool/schema.ts`. Fields: `mode` (required), `query`, `type`, `task`, `scope`, `skillName`, `path`.

**Note:** For content tests, use the fixture files in `full-suite/.goodvibes/` as local registry items. The registry also reads from the global `.goodvibes/` directory.

### 12.1 mode: search — skills
- [ ] Call `registry` with `mode: "search"`, `query: "code"`, `type: "skills"`.
  - **Expected:** Returns skills matching `code` — should include the fixture `code-review` skill.

### 12.2 mode: search — agents
- [ ] Call `registry` with `mode: "search"`, `query: "researcher"`, `type: "agents"`.
  - **Expected:** Returns the `researcher` agent from the fixture.

### 12.3 mode: search — all types
- [ ] Call `registry` with `mode: "search"`, `query: "review"`, `type: "all"`.
  - **Expected:** Returns matching skills, agents, and tools.

### 12.4 mode: search — tools
- [ ] Call `registry` with `mode: "search"`, `query: "read"`, `type: "tools"`.
  - **Expected:** Returns native tools related to reading.

### 12.5 mode: recommend — skills
- [ ] Call `registry` with `mode: "recommend"`, `task: "Review code for security vulnerabilities"`, `scope: "skills"`.
  - **Expected:** Sorted list of skills relevant to security review — `code-review` should rank highly.

### 12.6 mode: recommend — tools
- [ ] Call `registry` with `mode: "recommend"`, `task: "Search for files matching a pattern"`, `scope: "tools"`.
  - **Expected:** `find` tool should rank near the top.

### 12.7 mode: dependencies — skill with depends_on
- [ ] Call `registry` with `mode: "dependencies"`, `skillName: "code-review"`.
  - **Expected:** Returns `depends_on: ["testing-strategy"]` as defined in the fixture skill.

### 12.8 mode: dependencies — skill without depends_on
- [ ] Call `registry` with `mode: "dependencies"`, `skillName: "researcher"` (the agent from the fixture).
  - **Expected:** Empty dependencies or appropriate message.

### 12.9 mode: content — local skill file
- [ ] Call `registry` with `mode: "content"`, `path: "/home/buzzkill/Projects/goodvibes-tui/full-suite/.goodvibes/skills/code-review.md"`.
  - **Expected:** Full markdown content of the skill file returned, plus parsed metadata (name, description, triggers, depends_on).

### 12.10 mode: content — local agent file
- [ ] Call `registry` with `mode: "content"`, `path: "/home/buzzkill/Projects/goodvibes-tui/full-suite/.goodvibes/agents/researcher.md"`.
  - **Expected:** Full markdown content plus parsed metadata (name, archetype, description).

### 12.11 mode: search — no results
- [ ] Call `registry` with `mode: "search"`, `query: "xyznonexistent"`, `type: "all"`.
  - **Expected:** Empty results with no error.

---

## Summary Checklist

After completing all sections, verify:

- [ ] All 12 tools exercised
- [ ] `read`: 5 extract modes + batch + output formats + pagination + force tested
- [ ] `write`: create + overwrite + backup + dry_run + base64 + verbosity tested
- [ ] `edit`: exact/fuzzy/regex + occurrence + hints + transaction modes + dry_run tested
- [ ] `find`: files/content/symbols modes + all 5 output formats + negate + batch tested
- [ ] `exec`: basic + working_dir + env + expect + timeout + background + retry + until + parallel + file_ops + verbosity tested
- [ ] `fetch`: GET + POST + all extract modes + headers + timeout + parallel + verbosity tested
- [ ] `analyze`: all 9 modes (dependencies/circular/dead_code/security/surface/preview/diff/impact/coverage) + output formats tested
- [ ] `inspect`: all 7 modes (project/api/database/components/layout/accessibility/scaffold) + dry_run tested
- [ ] `agent`: spawn + status + list + cancel + templates + context + model override + tools override tested
- [ ] `state`: get/set/list/clear + budget + context + memory (get/set/list) + telemetry tested
- [ ] `workflow`: start (all definitions) + status + transition + cancel + list + triggers (add/enable/disable/remove) + schedule (add/remove/list) tested
- [ ] `registry`: search (all types) + recommend (skills/tools) + dependencies + content tested

**Total test items: ~140**
