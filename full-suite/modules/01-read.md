# Module 1: Read Tests

> Run this module independently. It tests the `read` tool.
> All work stays within the full-suite/ directory.
> No network required. No files are modified.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

---

## Test 1.1: content mode
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "standard" }
```
**Capture:** `summary.line_count` and the first line of file content.
**Record:** Append to TEST-RESULTS.md:
```
| 1.1 | read content mode | lineCount=<N>, firstLine=<exact text> | PASS |
```

---

## Test 1.2: outline mode
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "outline" }], "verbosity": "standard" }
```
**Capture:** The list of symbol names shown in the outline (function/class/const names).
**Record:** Append to TEST-RESULTS.md:
```
| 1.2 | read outline mode | symbols=<comma-separated names> | PASS |
```

---

## Test 1.3: symbols mode
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "symbols" }], "verbosity": "standard" }
```
**Capture:** Count of exported symbols returned.
**Record:** Append to TEST-RESULTS.md:
```
| 1.3 | read symbols mode | symbol_count=<N> | PASS |
```

---

## Test 1.4: lines mode (range 1-5)
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "lines", "range": { "start": 1, "end": 5 } }], "verbosity": "standard" }
```
**Capture:** The exact text of line 1.
**Record:** Append to TEST-RESULTS.md:
```
| 1.4 | read lines mode | line1=<exact text> | PASS |
```

---

## Test 1.5: batch read two files
**Call:** `read` with:
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
**Record:** Append to TEST-RESULTS.md:
```
| 1.5 | read batch two files | files_read=<N> | PASS |
```

---

## Test 1.6: count_only format
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "count_only" }
```
**Capture:** The `total_tokens` value from the summary.
**Record:** Append to TEST-RESULTS.md:
```
| 1.6 | read count_only | total_tokens=<N> | PASS |
```

---

## Test 1.7: cache test (read same file again)
**Call:** `read` with:
```json
{ "files": [{ "path": "full-suite/src/index.ts", "extract": "content" }], "verbosity": "standard" }
```
**Capture:** The `cache.status` field or equivalent cache indicator. Expected value: `"unchanged"` or `"cached"`.
**Record:** Append to TEST-RESULTS.md:
```
| 1.7 | read cache status | cache.status=<value> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 1: read — X/7 passed
```
