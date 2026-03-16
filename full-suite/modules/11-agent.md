# Module 11: Agent Tests

> Run this module independently. It tests the `agent` tool.
> Uses in-memory agent state. No files are modified (other than TEST-RESULTS.md).
> No network required.
> NOTE: Tests 11.2 and 11.4 depend on the agent ID captured in 11.1.
> Capture the agent-XXXX ID from Test 11.1 and substitute it in those calls.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

---

## Test 11.1: spawn a researcher agent
**Call:** `agent` with:
```json
{ "action": "spawn", "template": "researcher", "task": "find all exported functions in full-suite/src/" }
```
**Capture:** The agent ID (format: `agent-XXXX`). Save this ID for use in tests 11.2 and 11.4.
**Record:** Append to TEST-RESULTS.md:
```
| 11.1 | agent spawn | agent_id=<agent-XXXX> | PASS |
```

---

## Test 11.2: get agent status
**Call:** `agent` with:
```json
{ "action": "status", "id": "<agent-XXXX from 11.1>" }
```
**Capture:** The `status` field value (e.g. `"running"`, `"pending"`, `"complete"`).
**Record:** Append to TEST-RESULTS.md:
```
| 11.2 | agent status | status=<value> | PASS |
```

---

## Test 11.3: list templates
**Call:** `agent` with:
```json
{ "action": "templates" }
```
**Capture:** The count of available templates (expected: 5).
**Record:** Append to TEST-RESULTS.md:
```
| 11.3 | agent templates | template_count=<N> | PASS |
```

---

## Test 11.4: cancel the agent
**Call:** `agent` with:
```json
{ "action": "cancel", "id": "<agent-XXXX from 11.1>" }
```
Then call `agent` with `{ "action": "status", "id": "<agent-XXXX>" }` and capture the new status.
**Capture:** The status after cancel (should be `"cancelled"` or `"terminated"`).
**Record:** Append to TEST-RESULTS.md:
```
| 11.4 | agent cancel | status_after=<value> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 11: agent — X/4 passed
```
