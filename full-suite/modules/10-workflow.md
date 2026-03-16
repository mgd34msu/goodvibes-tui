# Module 10: Workflow Tests

> Run this module independently. It tests the `workflow` tool.
> Uses in-memory workflow state. No files are modified (other than TEST-RESULTS.md).
> No network required.
> NOTE: Tests 10.2 through 10.5 depend on the workflow ID captured in 10.1.
> Capture the wf-XXXX ID from Test 10.1 and substitute it in all subsequent calls.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

---

## Test 10.1: start a WRFC workflow
**Call:** `workflow` with:
```json
{ "action": "start", "type": "wrfc" }
```
**Capture:** The workflow ID (format: `wf-XXXX`). Save this ID for use in tests 10.2 through 10.5.
**Record:** Append to TEST-RESULTS.md:
```
| 10.1 | workflow start | wf_id=<wf-XXXX> | PASS |
```

---

## Test 10.2: get workflow status
**Call:** `workflow` with:
```json
{ "action": "status", "id": "<wf-XXXX from 10.1>" }
```
**Capture:** The `currentState` field. Expected: `"gather"`.
**Record:** Append to TEST-RESULTS.md:
```
| 10.2 | workflow status | currentState=<value> | PASS |
```

---

## Test 10.3: transition to plan state
**Call:** `workflow` with:
```json
{ "action": "transition", "id": "<wf-XXXX from 10.1>", "to": "plan" }
```
**Capture:** The success indicator and the new state value.
**Record:** Append to TEST-RESULTS.md:
```
| 10.3 | workflow transition | success=<true/false>, new_state=<value> | PASS |
```

---

## Test 10.4: add a trigger
**Call:** `workflow` with:
```json
{ "action": "triggers", "subaction": "add", "id": "<wf-XXXX from 10.1>", "trigger": { "event": "file_change", "pattern": "*.ts" } }
```
**Capture:** The trigger ID (format: `trg-XXXX`).
**Record:** Append to TEST-RESULTS.md:
```
| 10.4 | workflow triggers add | trg_id=<trg-XXXX> | PASS |
```

---

## Test 10.5: cancel workflow
**Call:** `workflow` with:
```json
{ "action": "cancel", "id": "<wf-XXXX from 10.1>" }
```
Then call `workflow` with `{ "action": "status", "id": "<wf-XXXX>" }` and capture the new status.
**Capture:** The status after cancel (should be `"cancelled"` or `"terminated"`).
**Record:** Append to TEST-RESULTS.md:
```
| 10.5 | workflow cancel | status_after=<value> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 10: workflow — X/5 passed
```
