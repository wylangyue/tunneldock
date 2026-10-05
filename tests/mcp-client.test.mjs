import assert from "node:assert/strict";
import { test } from "node:test";
import { McpClient, stdioClient } from "./mcp-client.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

function fixture(handler, timeout = 1000) {
  const sent = [];
  const client = new McpClient(message => {
    sent.push(message);
    const result = handler(message);
    if (result !== undefined) queueMicrotask(() => client.receive({ jsonrpc: "2.0", id: message.id, result }));
  }, async () => {}, timeout);
  return { client, sent };
}

test("a failed MCP subprocess start rejects and cleans up its transport", async t => {
  const root = await mkdtemp(join(tmpdir(), "td-client-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(stdioClient({ command: join(root, "missing"), cwd: root, env: process.env }), error => error.code === "ENOENT");
});

test("missing direct proxy uses call with the same native arguments, target and conversation", async () => {
  const f = fixture(message => message.method === "tools/list" ? { tools: [{ name: "call" }] } : { content: [], isError: false });
  await f.client.initialize();
  await f.client.native("write", { path: "marker", content: "one", sessionId: "target" }, "chat-a");
  const calls = f.sent.filter(message => message.method === "tools/call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.name, "call");
  assert.deepEqual(calls[0].params.arguments, { calls: [{ name: "write", arguments: { path: "marker", content: "one" } }], sessionId: "target" });
  assert.equal(calls[0].params._meta["openai/session"], "chat-a");
  await f.client.close();
});

test("an explicit pre-execution missing proxy permits one fallback", async () => {
  const f = fixture(message => {
    if (message.method === "tools/list") return { tools: [{ name: "write" }, { name: "call" }] };
    if (message.params?.name === "write") return { isError: true, structuredContent: { error: { code: "mcp_tool_not_found", execution: "not_started" } } };
    return { content: [], isError: false };
  });
  await f.client.initialize();
  await f.client.native("write", { path: "marker", content: "one" });
  assert.deepEqual(f.sent.filter(message => message.method === "tools/call").map(message => message.params.name), ["write", "call"]);
  await f.client.close();
});

test("unknown execution outcomes and timeouts never replay a native mutation", async () => {
  const f = fixture(message => message.method === "tools/list" ? { tools: [{ name: "write" }] } : message.method === "tools/call" ? { isError: true, structuredContent: { error: { code: "ipc_disconnected", execution: "unknown", retryable: false } } } : {});
  await f.client.initialize();
  assert.equal((await f.client.native("write", { path: "marker", content: "one" })).isError, true);
  assert.equal(f.sent.filter(message => message.method === "tools/call").length, 1);
  await f.client.close();
  const timeout = fixture(() => undefined, 20);
  timeout.client.tools = new Set(["bash"]);
  await assert.rejects(timeout.client.native("bash", { command: "a mutation" }), error => error.execution === "unknown");
  assert.equal(timeout.sent.filter(message => message.method === "tools/call").length, 1);
  assert.equal(timeout.sent.filter(message => message.method === "notifications/cancelled").length, 1);
  await timeout.client.close();
});

test("SDK missing-tool rejection permits fallback but other InvalidParams failures do not", async () => {
  for (const missing of [true, false]) {
    let client;
    const sent = [];
    client = new McpClient(message => {
      sent.push(message);
      if (message.params?.name === "write") queueMicrotask(() => client.receive({ id: message.id, error: {
        code: -32602, message: missing ? "Tool write not found" : "Invalid arguments for write",
      } }));
      else queueMicrotask(() => client.receive({ id: message.id, result: { content: [], isError: false } }));
    }, async () => {});
    client.tools = new Set(["write", "call"]);
    const operation = client.native("write", { path: "marker", content: "one" });
    if (missing) assert.equal((await operation).isError, false);
    else await assert.rejects(operation, /Invalid arguments/);
    assert.equal(sent.filter(message => message.params?.name === "call").length, missing ? 1 : 0);
    await client.close();
  }
});
