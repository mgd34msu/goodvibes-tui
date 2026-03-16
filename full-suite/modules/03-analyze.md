# Module 3: Analyze Tests

> Run this module independently. It tests the `analyze` tool.
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

## Test 3.1: dependencies
**Call:** `analyze` with:
```json
{ "type": "dependencies", "path": "full-suite/src/" }
```
**Capture:** One import path from the dependency graph (e.g. `"./auth"` or similar).
**Record:** Append to TEST-RESULTS.md:
```
| 3.1 | analyze dependencies | import_path=<value> | PASS |
```

---

## Test 3.2: circular dependencies
**Call:** `analyze` with:
```json
{ "type": "circular", "path": "full-suite/src/" }
```
**Capture:** The cycle chain string (e.g. `a.ts -> b.ts -> a.ts`).
**Record:** Append to TEST-RESULTS.md:
```
| 3.2 | analyze circular deps | cycle=<chain> | PASS |
```

---

## Test 3.3: dead code
**Call:** `analyze` with:
```json
{ "type": "dead_code", "path": "full-suite/src/" }
```
**Capture:** Verify `unusedHelper` appears as a dead export.
**Record:** Append to TEST-RESULTS.md:
```
| 3.3 | analyze dead code | unusedHelper_found=<true/false> | PASS |
```

---

## Test 3.4: security scan
**Call:** `analyze` with:
```json
{ "type": "security", "path": "full-suite/src/" }
```
**Capture:** The detected secret pattern (should match `AKIA...` or `sk-secret...`).
**Record:** Append to TEST-RESULTS.md:
```
| 3.4 | analyze security | secret_pattern=<value> | PASS |
```

---

## Test 3.5: surface on single file
**Call:** `analyze` with:
```json
{ "type": "surface", "path": "full-suite/src/index.ts" }
```
**Capture:** The exported symbol names from the public surface.
**Record:** Append to TEST-RESULTS.md:
```
| 3.5 | analyze surface | exports=<list> | PASS |
```

---

## Test 3.6: preview proposed change
**Call:** `analyze` with:
```json
{ "type": "preview", "path": "full-suite/src/index.ts", "find": "greet", "replace": "hello" }
```
**Capture:** A diff line showing the proposed change (e.g. `-greet` / `+hello`).
**Record:** Append to TEST-RESULTS.md:
```
| 3.6 | analyze preview diff | diff_line=<value> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 3: analyze — X/6 passed
```
