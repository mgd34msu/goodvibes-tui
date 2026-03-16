# Module 4: Inspect Tests

> Run this module independently. It tests the `inspect` tool.
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

## Test 4.1: project mode
**Call:** `inspect` with:
```json
{ "type": "project", "path": "full-suite/" }
```
**Capture:** The detected `type` (e.g. `"node"`) and `package_manager` (e.g. `"npm"`).
**Record:** Append to TEST-RESULTS.md:
```
| 4.1 | inspect project | type=<value>, pm=<value> | PASS |
```

---

## Test 4.2: database mode
**Call:** `inspect` with:
```json
{ "type": "database", "path": "full-suite/" }
```
**Capture:** Model names found (should include `User` and `Post`).
**Record:** Append to TEST-RESULTS.md:
```
| 4.2 | inspect database | models=<list> | PASS |
```

---

## Test 4.3: components mode
**Call:** `inspect` with:
```json
{ "type": "components", "path": "full-suite/src/Button.tsx" }
```
**Capture:** The component name and its prop names.
**Record:** Append to TEST-RESULTS.md:
```
| 4.3 | inspect components | component=<name>, props=<list> | PASS |
```

---

## Test 4.4: accessibility on Button.tsx
**Call:** `inspect` with:
```json
{ "type": "accessibility", "path": "full-suite/src/Button.tsx" }
```
**Capture:** The specific issue text (should mention `img` without `alt` or similar).
**Record:** Append to TEST-RESULTS.md:
```
| 4.4 | inspect accessibility | issue=<exact text> | PASS |
```

---

## Test 4.5: scaffold dry_run
**Call:** `inspect` with:
```json
{ "type": "scaffold", "template": "component", "name": "DryWidget", "dry_run": true }
```
**Capture:** The list of files that would be created (dry run only — no files should actually exist).
**Record:** Append to TEST-RESULTS.md:
```
| 4.5 | inspect scaffold dry_run | would_create=<list> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 4: inspect — X/5 passed
```
