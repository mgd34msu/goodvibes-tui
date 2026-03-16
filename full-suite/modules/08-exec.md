# Module 8: Exec Tests

> Run this module independently. It tests the `exec` tool.
> These run shell commands. Output goes to stdout/stderr only, not to files unless explicitly stated.
> No network required.

## Setup

1. Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

2. Create directory `full-suite/output/` if it does not already exist:
   Run exec: `mkdir -p full-suite/output`

---

## Test 8.1: echo command
**Call:** `exec` with:
```json
{ "commands": [{ "cmd": "echo 'hello from exec'" }] }
```
**Capture:** The exact stdout text.
**Record:** Append to TEST-RESULTS.md:
```
| 8.1 | exec echo | stdout=<exact text> | PASS |
```

---

## Test 8.2: cat package.json
**Call:** `exec` with:
```json
{ "commands": [{ "cmd": "cat full-suite/package.json" }] }
```
**Capture:** The `exit_code` (should be 0) and the first line of stdout.
**Record:** Append to TEST-RESULTS.md:
```
| 8.2 | exec cat package.json | exit_code=<N>, first_line=<text> | PASS |
```

---

## Test 8.3: echo with exit_code expectation
**Call:** `exec` with:
```json
{ "commands": [{ "cmd": "echo 'checking expectations'", "expect": { "exit_code": 0 } }] }
```
**Capture:** The `success: true` indicator from the expectation check.
**Record:** Append to TEST-RESULTS.md:
```
| 8.3 | exec with expectation | success=<true/false> | PASS |
```

---

## Test 8.4: file_ops — copy file
**Call:** `exec` with:
```json
{ "commands": [{ "cmd": "cp full-suite/src/index.ts full-suite/output/copied.ts" }] }
```
Then call `read` on `full-suite/output/copied.ts` to verify it exists and has content.
**Capture:** That the file exists and the first line matches the original.
**Record:** Append to TEST-RESULTS.md:
```
| 8.4 | exec copy file | file_exists=<true/false>, first_line=<text> | PASS |
```

---

## Test 8.5: ls src directory
**Call:** `exec` with:
```json
{ "commands": [{ "cmd": "ls full-suite/src/" }] }
```
**Capture:** The full file listing from stdout.
**Record:** Append to TEST-RESULTS.md:
```
| 8.5 | exec ls | file_list=<list> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 8: exec — X/5 passed
```
