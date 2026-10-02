import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mapClaudeToolUse } from "../src/claude-hook.ts";
import { createServer, resolveProjectRoot } from "../src/mcp.ts";
import { TOOL_DESCRIPTIONS } from "../src/handlers.ts";

test("mapClaudeToolUse maps file tools to file.changed with project-relative paths", () => {
  const mapped = mapClaudeToolUse({ tool_name: "Edit", session_id: "s1", tool_input: { file_path: "/repo/app/a.rb" } }, "/repo");
  assert.equal(mapped?.type, "file.changed");
  assert.equal(mapped?.payload.file, "app/a.rb");
  assert.equal(mapped?.source, "claude:PostToolUse:Edit");
});

test("mapClaudeToolUse maps Bash to command.completed with a capped output tail", () => {
  const mapped = mapClaudeToolUse(
    { tool_name: "Bash", tool_input: { command: "bundle exec rspec" }, tool_response: { stdout: "x".repeat(2000), interrupted: false } },
    "/repo",
  );
  assert.equal(mapped?.type, "command.completed");
  assert.equal(mapped?.payload.command, "bundle exec rspec");
  assert.ok(String(mapped?.payload.outputTail).length <= 500);
});

test("mapClaudeToolUse ignores inputs without a tool name or file path", () => {
  assert.equal(mapClaudeToolUse({}, "/repo"), null);
  assert.equal(mapClaudeToolUse({ tool_name: "Write", tool_input: {} }, "/repo"), null);
});

test("resolveProjectRoot prefers AGENT_REVIEW_PROJECT_ROOT, then CLAUDE_PROJECT_DIR, then cwd", () => {
  assert.equal(resolveProjectRoot({ AGENT_REVIEW_PROJECT_ROOT: "/a", CLAUDE_PROJECT_DIR: "/b" }, "/c"), "/a");
  assert.equal(resolveProjectRoot({ CLAUDE_PROJECT_DIR: "/b" }, "/c"), "/b");
  assert.equal(resolveProjectRoot({}, "/c"), "/c");
});

test("MCP server lists every agent_review tool and answers status", async () => {
  const server = createServer("/nonexistent-agent-review-root");
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), Object.keys(TOOL_DESCRIPTIONS).sort());

  const result = await client.callTool({ name: "agent_review_rollback", arguments: { checkpointId: "x" } });
  const payload = JSON.parse((result.content as Array<{ text: string }>)[0]!.text);
  assert.equal(payload.status, "confirmation-required");
  await client.close();
});
