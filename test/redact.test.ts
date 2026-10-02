import assert from "node:assert/strict";
import { test } from "node:test";
import { redactString, redactValue, truncateUtf8, redactAndTruncate } from "../src/redact.ts";

test("redacts Bearer tokens", () => {
  const out = redactString("Authorization: Bearer abc123def456ghi");
  assert.ok(!out.includes("abc123def456ghi"));
  assert.ok(out.includes("[REDACTED]"));
});

test("redacts key/value secret assignments", () => {
  const cases = [
    "api_key=sk-abcdef123456",
    '"password": "hunter2000"',
    "SECRET: topsecretvalue",
    "token: ghp_16charactersXXXXXXXXXXX",
  ];
  for (const input of cases) {
    const out = redactString(input);
    assert.ok(!out.toLowerCase().includes(input.split(/[:=]\s*/)[1]!.toLowerCase()), `not redacted: ${input}`);
  }
});

test("redacts private keys", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIabc\ndef\n-----END RSA PRIVATE KEY-----";
  const out = redactString(`preamble ${pem} epilogue`);
  assert.ok(!out.includes("MIIabc"));
});

test("redacts connection strings but keeps the scheme", () => {
  const out = redactString("postgres://admin:s3cret@db.example.com:5432/prod");
  assert.ok(out.startsWith("postgres://"));
  assert.ok(!out.includes("s3cret"));
  assert.ok(!out.includes("admin:s3cret"));
});

test("redactValue walks nested structures", () => {
  const input = { a: { b: ["Bearer abcdef123456", 42, null] } };
  const out = redactValue(input) as { a: { b: [string, number, null] } };
  assert.ok(!out.a.b[0]!.includes("abcdef123456"));
  assert.equal(out.a.b[1], 42);
});

test("truncateUtf8 is UTF-8-safe", () => {
  const { text, truncated } = truncateUtf8("你好".repeat(100), 10);
  assert.ok(truncated);
  assert.ok(Buffer.from(text, "utf8").length <= 10 + "[truncated]".length + 10);
  assert.ok(!text.includes("\uFFFD"));
});

test("redactAndTruncate combines both", () => {
  const { text } = redactAndTruncate("token=abcdef123456 " + "x".repeat(5000), 100);
  assert.ok(text.includes("[REDACTED]"));
  assert.ok(text.includes("[truncated]"));
});
