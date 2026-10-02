import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeEvent, appendEvent, readEvents, readEventsOfType, countEvents } from "../src/events.ts";

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "agent-review-events-"));
}

test("appendEvent writes valid JSONL and readEvents parses it", async () => {
  const root = await tempRoot();
  const first = await appendEvent(root, makeEvent("session.started", "test", { task: "t" }));
  const second = await appendEvent(root, makeEvent("file.changed", "test", { file: "a.ts" }, first.id));

  const events = await readEvents(root);
  assert.equal(events.length, 2);
  assert.equal(events[0]!.type, "session.started");
  assert.equal(events[1]!.sessionId, first.id);

  const raw = await fs.readFile(path.join(root, ".agent-review", "events.jsonl"), "utf8");
  assert.ok(raw.endsWith("\n"));
  assert.equal(raw.trim().split("\n").length, 2);
});

test("events are append-only: order is preserved", async () => {
  const root = await tempRoot();
  for (let index = 0; index < 5; index++) {
    await appendEvent(root, makeEvent("checkpoint.created", "test", { index }));
  }
  const events = await readEvents(root);
  assert.deepEqual(events.map((event) => event.payload.index), [0, 1, 2, 3, 4]);
});

test("readEvents skips torn lines without failing", async () => {
  const root = await tempRoot();
  const file = path.join(root, ".agent-review", "events.jsonl");
  await fs.mkdir(path.dirname(file), { recursive: true });
  const good = JSON.stringify(makeEvent("session.started", "test", {}));
  await fs.writeFile(file, `${good}\n{"id": "torn"\n`);
  const events = await readEvents(root);
  assert.equal(events.length, 1);
});

test("readEventsOfType and countEvents filter by type", async () => {
  const root = await tempRoot();
  await appendEvent(root, makeEvent("session.started", "t"));
  await appendEvent(root, makeEvent("file.changed", "t"));
  await appendEvent(root, makeEvent("file.changed", "t"));
  assert.equal((await readEventsOfType(root, "file.changed")).length, 2);
  assert.equal(await countEvents(root), 3);
});
