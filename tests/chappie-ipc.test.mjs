// Run against the same patched checkout as chappie.test.mjs.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const source = process.env.CHAPPIE_SOURCE_DIR;
assert.ok(source, "set CHAPPIE_SOURCE_DIR to a patched Chappie 1.1.0 checkout");
const moduleAt = name => import(pathToFileURL(join(resolve(source), "src", name)));
const { JsonLinePeer, IpcServer } = await moduleAt("ipc.ts");
const { ipcLimits, StartupDiagnostics } = await moduleAt("runtime.ts");
const { Session } = await moduleAt("session.ts");

class SocketStub extends EventEmitter {
  destroyed = false;
  writes = [];
  setEncoding() {}
  write(line, callback) { this.writes.push({ line, callback }); }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit("close"); } }
}

const flush = () => delay(0);
function peerFixture(handler = () => {}) {
  const socket = new SocketStub();
  let closes = 0;
  const peer = new JsonLinePeer(socket, handler, () => { closes++; });
  return { socket, peer, closes: () => closes };
}

test("fragmented UTF-8 frames are counted in bytes and unterminated oversized frames close", async () => {
  const messages = [];
  const f = peerFixture(value => messages.push(value));
  f.socket.emit("data", '{"text":"');
  f.socket.emit("data", '中文"}\n{"text":"second"}\n');
  await flush();
  assert.deepEqual(messages, [{ text: "中文" }, { text: "second" }]);
  f.socket.emit("data", "界".repeat(Math.floor(ipcLimits.frameBytes / 3)));
  assert.equal(f.socket.destroyed, false);
  f.socket.emit("data", "界");
  assert.equal(f.socket.destroyed, true);
  assert.equal(f.closes(), 1);
});

test("a frame at the byte limit succeeds; an oversized outbound frame is rejected", async () => {
  let received;
  const f = peerFixture(value => { received = value; });
  const frame = '"' + "a".repeat(ipcLimits.frameBytes - 2) + '"';
  f.socket.emit("data", frame + "\n");
  await flush();
  assert.equal(received.length, ipcLimits.frameBytes - 2);
  const sent = f.peer.send("a".repeat(ipcLimits.frameBytes - 2));
  f.socket.writes[0].callback();
  await sent;
  await assert.rejects(f.peer.send("a".repeat(ipcLimits.frameBytes - 1)), /frame capacity/);
  f.peer.close();
});

test("outbound backpressure has a byte budget and completed writes release it", async () => {
  const f = peerFixture();
  const payload = "a".repeat(ipcLimits.frameBytes - 2);
  const first = f.peer.send(payload);
  await assert.rejects(f.peer.send(payload), /write capacity/);
  f.socket.writes[0].callback();
  await first;
  const retry = f.peer.send(payload);
  f.socket.writes[1].callback();
  await retry;
  f.peer.close();
});

test("handler saturation closes only that connection and clears queued callbacks", async () => {
  let delivered = 0;
  const overloaded = peerFixture(() => { delivered++; });
  const healthy = peerFixture(() => { delivered++; });
  overloaded.socket.emit("data", "{}\n".repeat(ipcLimits.handlers + 1));
  assert.equal(overloaded.socket.destroyed, true);
  healthy.socket.emit("data", "{}\n");
  await flush();
  assert.equal(delivered, 1);
  assert.equal(healthy.socket.destroyed, false);
  healthy.peer.close();
});

test("large in-flight frames have a combined byte budget below the handler count limit", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = peerFixture(() => pending);
  const frame = '"' + "a".repeat(ipcLimits.frameBytes - 2) + '"\n';
  f.socket.emit("data", frame);
  await flush();
  f.socket.emit("data", frame);
  await flush();
  assert.equal(f.socket.destroyed, false);
  f.socket.emit("data", "{}\n");
  assert.equal(f.socket.destroyed, true);
  release();
  await flush();
});

test("responses can pass an awaiting handler on the same connection", async () => {
  const order = [];
  let finish;
  const response = new Promise(resolve => { finish = resolve; });
  const f = peerFixture(async value => {
    if (value.kind === "request") { order.push("request"); await response; order.push("done"); }
    else { order.push("response"); finish(); }
  });
  f.socket.emit("data", '{"kind":"request"}\n');
  await flush();
  f.socket.emit("data", '{"kind":"response"}\n');
  await flush();
  assert.deepEqual(order, ["request", "response", "done"]);
  f.peer.close();
});

test("malformed JSON closes without passing parser text or secret-bearing data to the handler", async () => {
  let delivered = false;
  const f = peerFixture(() => { delivered = true; });
  f.socket.emit("data", '{"credential":"synthetic-secret", broken}\n');
  await flush();
  assert.equal(f.socket.destroyed, true);
  assert.equal(delivered, false);
});

test("stderr classification is bounded across chunks and never exposes arbitrary text", () => {
  const diagnostics = new StartupDiagnostics();
  diagnostics.append(Buffer.from("synthetic-secret ERR_MODULE_"));
  diagnostics.append(Buffer.from("NOT_FOUND\n"));
  assert.equal(diagnostics.code, "module_not_found");
  diagnostics.append(Buffer.alloc(128 * 1024, 65));
  assert.equal(diagnostics.truncated, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret/);
});

test("server refuses excess peers and closes an unterminated peer during shutdown", async t => {
  const root = await mkdtemp(join(tmpdir(), "td-ipc-"));
  const server = new IpcServer(root, () => {}, () => {});
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.destroy()); await server.close(); await rm(root, { recursive: true, force: true }); });
  await server.start();
  for (let i = 0; i < ipcLimits.peers; i++) {
    const socket = createConnection(join(root, "broker.sock"));
    sockets.push(socket);
    await once(socket, "connect");
  }
  const excess = createConnection(join(root, "broker.sock"));
  sockets.push(excess);
  const closed = once(excess, "close");
  await closed;
  sockets[0].write('{"unfinished":');
  await Promise.race([server.close(), delay(1000).then(() => { throw new Error("shutdown blocked by peer"); })]);
});

test("session queue overflow rejects that operation and still accepts cancellation", async t => {
  const root = await mkdtemp(join(tmpdir(), "td-session-"));
  const directory = join(root, ".chappie");
  await mkdir(directory);
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  let session;
  let owner;
  const results = [];
  const server = new IpcServer(directory, async (peer, message) => {
    if (message.type === "sync") {
      owner = peer;
      await peer.send({ type: "synced", id: message.id, sessionId: message.session.id });
    }
    if (message.type === "result") results.push(message);
  }, () => {});
  t.after(async () => {
    session?.close();
    await server.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    await rm(root, { recursive: true, force: true });
  });
  await server.start();
  session = new Session({
    describe: () => ({ id: "queue-test", agent: "pi", cwd: root, device: "fixture" }),
    active: () => true, isIdle: () => false, inspect: async () => ({ tools: [], skills: [] }),
    inputs: () => [], resetInputs: () => {}, wake: () => {}, abort: () => {},
    history: async () => ({ count: 0, hasMore: false, content: [] }),
  });
  session.update();
  for (let i = 0; !owner && i < 100; i++) await delay(10);
  assert.ok(owner, "session connected");
  const chat = id => ({ type: "chat", id, sessionId: "queue-test", clientId: "fixture", label: "fixture", text: "queued" });
  for (let id = 1; id <= ipcLimits.sessionQueue + 1; id++) {
    await owner.send(chat(id));
    await flush();
  }
  for (let i = 0; !results.length && i < 100; i++) await delay(10);
  assert.match(results[0].error, /queue capacity/);
  assert.equal(results[0].id, ipcLimits.sessionQueue + 1);
  await owner.send({ type: "cancel", id: 1, sessionId: "queue-test", reason: "cancel queued" });
  await flush();
  await owner.send(chat(1000));
  await delay(30);
  assert.equal(results.length, 1, "cancel released one queue slot");
  for (const id of [...Array.from({ length: 64 }, (_, i) => i + 1), 1000]) {
    await owner.send({ type: "cancel", id, sessionId: "queue-test", reason: "clear queued" });
    await flush();
  }
  await owner.send({ ...chat(2000), text: "a".repeat(ipcLimits.frameBytes - 1024) });
  await owner.send({ ...chat(2001), text: "a".repeat(2048) });
  for (let i = 0; results.length < 2 && i < 200; i++) await delay(10);
  assert.equal(results.length, 2);
  assert.equal(results[1].id, 2001, "byte budget applies before the count budget");
  assert.match(results[1].error, /queue capacity/);
  await owner.send({ type: "cancel", id: 2000, sessionId: "queue-test", reason: "release bytes" });
  await flush();
  await owner.send(chat(2002));
  await delay(30);
  assert.equal(results.length, 2, "cancel released the byte budget");
});
