# Module 6: Write Tests

> Run this module independently. It tests the `write` tool.
> All writes go to `full-suite/output/`. NEVER write to `src/`.

## Setup

1. Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

2. Create directory `full-suite/output/` if it does not already exist.
   (You can do this by writing a placeholder file and the directory will be created automatically,
   or use exec: `mkdir -p full-suite/output`)

---

## Test 6.1: create new file
**Call:** `write` with:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "hello from write test", "mode": "fail_if_exists" }] }
```
**Capture:** The `bytes_written` value from the response.
**Record:** Append to TEST-RESULTS.md:
```
| 6.1 | write create new file | bytes_written=<N> | PASS |
```

---

## Test 6.2: fail_if_exists on existing file
**Call:** `write` with:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "should fail", "mode": "fail_if_exists" }] }
```
**Capture:** The exact error message text returned.
**Record:** Append to TEST-RESULTS.md:
```
| 6.2 | write fail_if_exists | error=<exact text> | PASS |
```

---

## Test 6.3: overwrite with different content
**Call:** `write` with:
```json
{ "files": [{ "path": "full-suite/output/hello.txt", "content": "overwritten content -- different length!!", "mode": "overwrite" }] }
```
**Capture:** The new `bytes_written` value. It MUST differ from Test 6.1's value.
**Record:** Append to TEST-RESULTS.md:
```
| 6.3 | write overwrite | new_bytes_written=<N> (differs from 6.1=<N>) | PASS |
```

---

## Test 6.4: base64 write
**Call:** `write` with:
```json
{ "files": [{ "path": "full-suite/output/b64.txt", "content_base64": "aGVsbG8gYmFzZTY0", "mode": "fail_if_exists" }] }
```
(Note: `aGVsbG8gYmFzZTY0` decodes to `hello base64`)
**Capture:** The `bytes_written` value.
**Record:** Append to TEST-RESULTS.md:
```
| 6.4 | write base64 | bytes_written=<N> | PASS |
```

---

## Test 6.5: dry_run — verify no file created
**Call:** `write` with:
```json
{ "files": [{ "path": "full-suite/output/dry.txt", "content": "this should not exist" }], "dry_run": true }
```
**Capture:** Verify `dry_run: true` in the response.
Then immediately call `read` on `full-suite/output/dry.txt` — it must return a file-not-found error.
**Record:** Append to TEST-RESULTS.md:
```
| 6.5 | write dry_run | dry_run=true, file_exists=false | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 6: write — X/5 passed
```
