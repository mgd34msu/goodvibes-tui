# Module 9: State Tests

> Run this module independently. It tests the `state` tool.
> Uses in-memory state. No files are modified (other than TEST-RESULTS.md).
> No network required.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

---

## Test 9.1: set a value
**Call:** `state` with:
```json
{ "action": "set", "key": "test_proof", "value": "working" }
```
**Capture:** The `keys_written` count (should be 1).
**Record:** Append to TEST-RESULTS.md:
```
| 9.1 | state set | keys_written=<N> | PASS |
```

---

## Test 9.2: get the value back
**Call:** `state` with:
```json
{ "action": "get", "key": "test_proof" }
```
**Capture:** The value returned. Must be exactly `"working"`.
**Record:** Append to TEST-RESULTS.md:
```
| 9.2 | state get | value=<exact> | PASS |
```

---

## Test 9.3: budget info
**Call:** `state` with:
```json
{ "action": "budget" }
```
**Capture:** Any numeric field from the response (e.g. `tokens_used`, `session_time_seconds`, etc.).
**Record:** Append to TEST-RESULTS.md:
```
| 9.3 | state budget | field=<name>, value=<N> | PASS |
```

---

## Test 9.4: list all keys
**Call:** `state` with:
```json
{ "action": "list" }
```
**Capture:** Verify `test_proof` appears in the key list.
**Record:** Append to TEST-RESULTS.md:
```
| 9.4 | state list | test_proof_present=<true/false> | PASS |
```

---

## Test 9.5: clear and verify gone
**Call:** `state` with:
```json
{ "action": "clear", "key": "test_proof" }
```
Then immediately call `state` with `{ "action": "get", "key": "test_proof" }` and verify it returns null or not-found.
**Capture:** The get-after-clear result (must be null/missing).
**Record:** Append to TEST-RESULTS.md:
```
| 9.5 | state clear | value_after_clear=<null or not-found> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 9: state — X/5 passed
```
