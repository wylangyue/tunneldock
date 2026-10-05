import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// This client lives outside Pi and the MCP server. Missing direct proxies may
// use call; failures after dispatch never cause automatic replay.
export class McpClient {
  constructor(send, close, timeoutMs = 15_000) {
    this.send = send;
    this.closeTransport = close;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 1;
    this.tools = undefined;
  }
  receive(message) {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(Object.assign(new Error(message.error.message), { rpcCode: message.error.code }));
    else pending.resolve(message.result);
  }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  async request(method, params) {
    const id = this.nextId++;
    const completion = Promise.withResolvers();
    const timer = setTimeout(() => {
      this.pending.delete(id);
      void Promise.resolve(this.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "E2E deadline" } })).catch(() => {});
      completion.reject(Object.assign(new Error("MCP request timed out; execution outcome is unknown"), { execution: "unknown" }));
    }, this.timeoutMs);
    this.pending.set(id, { ...completion, timer });
    try { await this.send({ jsonrpc: "2.0", id, method, params }); }
    catch (error) { this.pending.delete(id); clearTimeout(timer); completion.reject(error); }
    return completion.promise;
  }
  async initialize() {
    await this.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "tunneldock-e2e", version: "0.4.0" } });
    await this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.tools = new Set((await this.request("tools/list", {})).tools.map(tool => tool.name));
  }
  call(name, args = {}, chatId = "e2e-chat") {
    return this.request("tools/call", { name, arguments: args, _meta: { "openai/session": chatId, "otunnel/requestId": this.nextId } });
  }
  async native(name, args, chatId = "e2e-chat") {
    const { sessionId, ...arguments_ } = args;
    const fallback = () => this.call("call", { calls: [{ name, arguments: arguments_ }], ...(sessionId ? { sessionId } : {}) }, chatId);
    if (!this.tools?.has(name)) return fallback();
    let result;
    try { result = await this.call(name, args, chatId); }
    catch (error) {
      // The SDK rejects an unregistered tool before invoking its handler.
      // Other InvalidParams errors (including argument validation) do not qualify.
      if (error.rpcCode === -32602 && error.message === `Tool ${name} not found`) return fallback();
      throw error;
    }
    const error = result.structuredContent?.error;
    if (error?.code === "mcp_tool_not_found" && error.execution === "not_started") return fallback();
    return result;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(Object.assign(new Error("MCP client closed; execution outcome is unknown"), { execution: "unknown" }));
    await this.closeTransport();
  }
}

export async function stdioClient({ command, cwd, env }) {
  const child = spawn(command, [], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const closed = new Promise(resolve => child.once("close", resolve));
  const lines = createInterface({ input: child.stdout });
  const client = new McpClient(message => new Promise((resolve, reject) => {
    child.stdin.write(JSON.stringify(message) + "\n", error => error ? reject(error) : resolve());
  }), async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGTERM"), 2000);
    await closed;
    clearTimeout(timer); lines.close();
  });
  lines.on("line", line => {
    try { client.receive(JSON.parse(line)); }
    catch { client.fail(new Error("Invalid MCP JSON response")); }
  });
  child.once("error", error => client.fail(error));
  child.stdin.on("error", error => client.fail(error));
  child.once("exit", () => client.fail(Object.assign(new Error("MCP transport disconnected; execution outcome is unknown"), { execution: "unknown" })));
  try { await client.initialize(); }
  catch (error) { await client.close(); throw error; }
  return client;
}
