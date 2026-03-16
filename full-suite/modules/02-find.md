# Module 2: Find Tests

> Run this module independently. It tests the `find` tool.
> All work stays within the full-suite/ directory.
> No network required. No files are modified.

> Known issue: `max_results` has a count/matches mismatch bug. Do NOT test `max_results` in this suite.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

---

## Test 2.1: files mode — *.ts in src/
**Call:** `find` with:
```json
{ "type": "files", "patterns": ["full-suite/src/*.ts"] }
```
**Capture:** Count of files returned.
**Record:** Append to TEST-RESULTS.md:
```
| 2.1 | find files *.ts | file_count=<N> | PASS |
```

---

## Test 2.2: files mode — *.tsx paths
**Call:** `find` with:
```json
{ "type": "files", "patterns": ["full-suite/src/*.tsx"] }
```
**Capture:** The exact file paths returned (e.g. `full-suite/src/Button.tsx`).
**Record:** Append to TEST-RESULTS.md:
```
| 2.2 | find files *.tsx | paths=<list> | PASS |
```

---

## Test 2.3: content mode — search "export function"
**Call:** `find` with:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/" }
```
**Capture:** The total match count across all files.
**Record:** Append to TEST-RESULTS.md:
```
| 2.3 | find content match count | match_count=<N> | PASS |
```

---

## Test 2.4: content mode — count_only output
**Call:** `find` with:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/", "output": { "format": "count_only" } }
```
**Capture:** The numeric count value.
**Record:** Append to TEST-RESULTS.md:
```
| 2.4 | find content count_only | count=<N> | PASS |
```

---

## Test 2.5: content mode — files_only output
**Call:** `find` with:
```json
{ "type": "content", "pattern": "export function", "path": "full-suite/src/", "output": { "format": "files_only" } }
```
**Capture:** The list of file paths returned (no line content, just paths).
**Record:** Append to TEST-RESULTS.md:
```
| 2.5 | find content files_only | files=<list> | PASS |
```

---

## Test 2.6: symbols mode — all symbols
**Call:** `find` with:
```json
{ "type": "symbols", "path": "full-suite/src/" }
```
**Capture:** Symbol names and total count.
**Record:** Append to TEST-RESULTS.md:
```
| 2.6 | find symbols all | symbol_count=<N>, names=<list> | PASS |
```

---

## Test 2.7: symbols mode — filter kind=class
**Call:** `find` with:
```json
{ "type": "symbols", "path": "full-suite/src/", "filter": { "kind": "class" } }
```
**Capture:** Verify `UserService` appears in the result.
**Record:** Append to TEST-RESULTS.md:
```
| 2.7 | find symbols class filter | contains_UserService=<true/false> | PASS |
```

---

## Test 2.8: batch query — two queries with IDs
**Call:** `find` with:
```json
{
  "queries": [
    { "id": "q1", "type": "files", "patterns": ["full-suite/src/*.ts"] },
    { "id": "q2", "type": "content", "pattern": "import", "path": "full-suite/src/" }
  ]
}
```
**Capture:** Both result IDs (`q1` and `q2`) present in the response.
**Record:** Append to TEST-RESULTS.md:
```
| 2.8 | find batch two queries | result_ids=q1,q2 present=<true/false> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 2: find — X/8 passed
```
