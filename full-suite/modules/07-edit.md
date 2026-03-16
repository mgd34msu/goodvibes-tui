# Module 7: Edit Tests

> Run this module independently. It tests the `edit` tool.
> CRITICAL: Each test uses its own dedicated file copy. NEVER share files across edit tests.
> NEVER edit `src/index.ts` directly.

## Setup

1. Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

2. Create directory `full-suite/edit-tests/` and copy `full-suite/src/index.ts` to each of the following:
   - `full-suite/edit-tests/test-1.ts`
   - `full-suite/edit-tests/test-2.ts`
   - `full-suite/edit-tests/test-3.ts`
   - `full-suite/edit-tests/test-4.ts`
   - `full-suite/edit-tests/test-5.ts`
   - `full-suite/edit-tests/test-6.ts`

   Use exec commands to copy:
   ```
   mkdir -p full-suite/edit-tests
   cp full-suite/src/index.ts full-suite/edit-tests/test-1.ts
   cp full-suite/src/index.ts full-suite/edit-tests/test-2.ts
   cp full-suite/src/index.ts full-suite/edit-tests/test-3.ts
   cp full-suite/src/index.ts full-suite/edit-tests/test-4.ts
   cp full-suite/src/index.ts full-suite/edit-tests/test-5.ts
   cp full-suite/src/index.ts full-suite/edit-tests/test-6.ts
   ```

---

## Test 7.1: exact match replacement
File: `full-suite/edit-tests/test-1.ts`
**Call:** `edit` with:
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
**Capture:** The replacement count or diff showing `greet` -> `hello`.
**Record:** Append to TEST-RESULTS.md:
```
| 7.1 | edit exact match | replacements=<N> or diff=<line> | PASS |
```

---

## Test 7.2: regex replacement
File: `full-suite/edit-tests/test-2.ts`
**Call:** `edit` with:
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
**Record:** Append to TEST-RESULTS.md:
```
| 7.2 | edit regex match | replacement_count=<N> | PASS |
```

---

## Test 7.3: occurrence=first (only first match)
File: `full-suite/edit-tests/test-3.ts`
**Call:** `edit` with:
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
Verify with a `read` of `full-suite/edit-tests/test-3.ts` — remaining `return` keywords should still exist.
**Record:** Append to TEST-RESULTS.md:
```
| 7.3 | edit occurrence first | replacements=1, others_unchanged=<true/false> | PASS |
```

---

## Test 7.4: fuzzy match (whitespace insensitive)
File: `full-suite/edit-tests/test-4.ts`
**Call:** `edit` with:
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
(The double space in the find string tests whitespace-insensitive matching)
**Capture:** Success indicator or replacement count.
**Record:** Append to TEST-RESULTS.md:
```
| 7.4 | edit fuzzy match | success=<true/false> or replacements=<N> | PASS |
```

---

## Test 7.5: dry_run — verify file unchanged
File: `full-suite/edit-tests/test-5.ts`
**Call:** `edit` with:
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
**Record:** Append to TEST-RESULTS.md:
```
| 7.5 | edit dry_run | diff_shown=<true/false>, file_unchanged=<true/false> | PASS |
```

---

## Test 7.6: atomic failure — one good + one bad edit
File: `full-suite/edit-tests/test-6.ts`
**Call:** `edit` with:
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
**Record:** Append to TEST-RESULTS.md:
```
| 7.6 | edit atomic failure | error=<text>, file_unchanged=<true/false> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 7: edit — X/6 passed
```
