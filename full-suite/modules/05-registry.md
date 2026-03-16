# Module 5: Registry Tests

> Run this module independently. It tests the `registry` tool.
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

## Test 5.1: list all tools
**Call:** `registry` with:
```json
{ "action": "list" }
```
**Capture:** Total count of tools registered.
**Record:** Append to TEST-RESULTS.md:
```
| 5.1 | registry list | tool_count=<N> | PASS |
```

---

## Test 5.2: get schema for read tool
**Call:** `registry` with:
```json
{ "action": "schema", "tool": "read" }
```
**Capture:** One required parameter name from the schema.
**Record:** Append to TEST-RESULTS.md:
```
| 5.2 | registry schema read | required_param=<name> | PASS |
```

---

## Test 5.3: search for write tool
**Call:** `registry` with:
```json
{ "action": "search", "query": "write" }
```
**Capture:** Verify `write` tool appears in search results.
**Record:** Append to TEST-RESULTS.md:
```
| 5.3 | registry search write | write_found=<true/false> | PASS |
```

---

## Test 5.4: capabilities
**Call:** `registry` with:
```json
{ "action": "capabilities" }
```
**Capture:** One capability category name from the response.
**Record:** Append to TEST-RESULTS.md:
```
| 5.4 | registry capabilities | category=<name> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 5: registry — X/4 passed
```
