# Module 12: Fetch Tests

> Run this module independently. It tests the `fetch` tool.
> These tests make real HTTP requests. Requires live network access to httpbin.org.
> If httpbin.org is unreachable, mark tests as SKIP not FAIL.

## Setup

Create `full-suite/TEST-RESULTS.md` if it does not already exist:
```
# Test Results

| ID | Name | Captured Value | Result |
|----|------|----------------|--------|
```

Verify network access before proceeding. You can run:
```
exec: curl -s --max-time 5 https://httpbin.org/get
```
If that fails, skip all tests in this module with SKIP status.

---

## Test 12.1: GET request
**Call:** `fetch` with:
```json
{ "urls": [{ "url": "https://httpbin.org/get" }] }
```
**Capture:** The `url` field from the response JSON (should echo back `https://httpbin.org/get`).
**Record:** Append to TEST-RESULTS.md:
```
| 12.1 | fetch GET | url_field=<value> | PASS |
```

---

## Test 12.2: POST request with body
**Call:** `fetch` with:
```json
{
  "urls": [{
    "url": "https://httpbin.org/post",
    "method": "POST",
    "body": { "test_key": "test_value_probe" }
  }]
}
```
**Capture:** The echoed `json.test_key` value from the response (should be `"test_value_probe"`).
**Record:** Append to TEST-RESULTS.md:
```
| 12.2 | fetch POST body | json.test_key=<value> | PASS |
```

---

## Test 12.3: extract json mode
**Call:** `fetch` with:
```json
{ "urls": [{ "url": "https://httpbin.org/json", "extract": "json" }] }
```
**Capture:** Any top-level key name from the parsed JSON response.
**Record:** Append to TEST-RESULTS.md:
```
| 12.3 | fetch extract json | key=<name> | PASS |
```

---

## Test 12.4: batch fetch two URLs
**Call:** `fetch` with:
```json
{
  "urls": [
    { "url": "https://httpbin.org/get" },
    { "url": "https://httpbin.org/uuid" }
  ]
}
```
**Capture:** The count of results returned (must be 2).
**Record:** Append to TEST-RESULTS.md:
```
| 12.4 | fetch batch 2 URLs | result_count=<N> | PASS |
```

---

## Module Summary
Append to TEST-RESULTS.md:
```
### Module 12: fetch — X/4 passed
```

---

## Known Issues
- **Network dependency**: fetch tests require live network access to httpbin.org. If unreachable, mark as SKIP not FAIL.
