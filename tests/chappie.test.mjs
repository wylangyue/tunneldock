// Run against a patched upstream checkout. All processes and files are temporary.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createConnection } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const runFile = promisify(execFile);
const source = process.env.CHAPPIE_SOURCE_DIR;
assert.ok(source, "set CHAPPIE_SOURCE_DIR to a patched Chappie 1.1.0 checkout");
const { Broker } = await import(pathToFileURL(join(resolve(source), "src/broker.ts")));
const { extensionBuild, runtimeCapabilities } = await import(pathToFileURL(join(resolve(source), "src/runtime.ts")));
const { queryDiagnostics } = await import(pathToFileURL(join(resolve(source), "src/diagnostics.ts")));
const signal = () => AbortSignal.timeout(15_000);

async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (await predicate()) return;
    await delay(25);
  }
  throw new Error("condition did not become true");
}

async function fixture(t, { real = false, idleMinutes = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), "td-test-"));
  const directory = join(root, ".chappie");
  await mkdir(directory);
  const original = { ...process.env };
  // Child agents must see the fixture's configuration rather than the user's.
  process.env.HOME = root;
  process.env.PI_CODING_AGENT_DIR = join(root, ".pi/agent");
  if (real) {
    assert.ok(process.env.CHAPPIE_PI_BIN, "set CHAPPIE_PI_BIN for real Pi integration");
    process.env.PATH = join(resolve(process.env.CHAPPIE_PI_BIN), "..") + ":" + original.PATH;
    execFileSync(process.env.CHAPPIE_PI_BIN, ["install", process.env.CHAPPIE_PACKAGE_DIR], {
      cwd: root, env: process.env, stdio: "pipe",
    });
  } else {
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pi"), `#!${process.execPath}
import { createConnection } from "node:net";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const sid = process.argv[process.argv.indexOf("--session-id") + 1];
appendFileSync(process.env.HOME + "/starts", sid + "\\n");
if (process.env.TEST_FAIL_START === "1") {
 process.stderr.write("Error loading extension: MODULE_NOT_FOUND synthetic-secret-not-for-output\\n");
 process.exit(2);
}
const socket = createConnection(process.env.HOME + "/.chappie/broker.sock");
const runtime = { revision: 1, nonce: process.env.TUNNELDOCK_PI_NONCE,
 extensionBuild: ${JSON.stringify(extensionBuild)}, piVersion: "0.99.1", nodeVersion: process.versions.node,
 capabilities: ${JSON.stringify(runtimeCapabilities)}, tools: ["read"] };
const session = { id: sid, cwd: process.cwd(), agent: "pi", model: "chappie/chatgpt", runtime,
 device: "fixture", status: process.env.TEST_STATUS ?? "ready" };
switch (process.env.TEST_HANDSHAKE) {
 case "missing": delete session.runtime; break;
 case "nonce": runtime.nonce = "00000000-0000-0000-0000-000000000000"; break;
 case "unicode_nonce": runtime.nonce = "界".repeat(36); break;
 case "revision": runtime.revision = 99; break;
 case "build": runtime.extensionBuild = "0.0.0"; break;
 case "cwd": session.cwd = "/wrong-project"; break;
 case "provider": session.model = "other/model"; break;
 case "tools": runtime.tools = []; break;
 case "capabilities": runtime.capabilities = []; break;
}
const inspection = { session, tools: [{ name: "read", description: "Read files", parameters: {} }], skills: [] };
if (process.env.TEST_HANDSHAKE === "inspect") inspection.tools = [];
const send = message => socket.write(JSON.stringify(message) + "\\n");
socket.on("connect", () => setTimeout(() => {
 send({ type: "sync", id: 1, session });
 if (process.env.TEST_DISCONNECT === "1") setTimeout(() => socket.destroy(), 100);
}, Number(process.env.TEST_START_DELAY ?? 0)));
createInterface({ input: socket }).on("line", line => {
 const m = JSON.parse(line);
 if (m.type === "inspect") setTimeout(() => send({ type: "result", id: m.id, inspection, inputs: [] }), Number(process.env.TEST_INSPECT_DELAY ?? 0));
 if (m.type === "inputs") send({ type: "result", id: m.id, inputs: [] });
 if (m.type === "history" && process.env.TEST_HANG_HISTORY !== "1") send({ type: "result", id: m.id, cwd: process.cwd(), history: { count: 0, hasMore: false, content: [] } });
});
process.stdin.resume();
process.stdin.on("end", () => { socket.destroy(); process.exit(0); });
socket.on("close", () => process.exit(0));
`, { mode: 0o755 });
    process.env.PATH = bin + ":" + original.PATH;
  }
  await writeFile(join(directory, "config.json"), JSON.stringify({
    cooldown: 0, autoCreate: { cwd: root, namePrefix: "test", idleMinutes },
  }));
  const brokers = [];
  async function start() {
    const broker = new Broker(directory);
    brokers.push(broker);
    await broker.start();
    return broker;
  }
  t.after(async () => {
    for (const broker of brokers.reverse()) await broker.close();
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    await rm(root, { recursive: true, force: true });
  });
  return { root, directory, start, starts: async () => (await readFile(join(root, "starts"), "utf8")).trim().split("\n") };
}

test("separate chats, concurrent first calls, explicit sharing, and restart recovery", async t => {
  const f = await fixture(t);
  let broker = await f.start();
  const [a, repeated, b] = await Promise.all([
    broker.initialize("a", undefined, 1, signal()),
    broker.initialize("a", undefined, 2, signal()),
    broker.initialize("b", undefined, 3, signal()),
  ]);
  assert.equal(a.session.id, repeated.session.id);
  assert.notEqual(a.session.id, b.session.id);
  assert.equal((await f.starts()).length, 2);
  const shared = await broker.initialize("shared", a.session.id, 4, signal());
  assert.equal(shared.session.id, a.session.id);
  await broker.close();
  broker = await f.start();
  const resumed = await broker.initialize("a", undefined, 5, signal());
  assert.equal(resumed.session.id, a.session.id);
  const state = JSON.parse(await readFile(join(f.directory, "state.json")));
  assert.equal(Object.keys(state.managedSessions).length, 2);
});

test("idle reaping restarts the same ID when reading history", async t => {
  const f = await fixture(t, { idleMinutes: 0.001 });
  const broker = await f.start();
  const a = await broker.initialize("a", undefined, 1, signal());
  await until(() => broker.listSessions().length === 0);
  const history = await broker.history("a", undefined, { limit: 20 }, 2, signal());
  assert.equal(history.sessionId, a.session.id);
  assert.equal((await f.starts()).length, 2);
});

test("generating sessions survive idle timeout", async t => {
  const f = await fixture(t, { idleMinutes: 0.001 });
  process.env.TEST_STATUS = "generating";
  const broker = await f.start();
  await broker.initialize("a", undefined, 1, signal());
  await delay(250);
  assert.equal(broker.listSessions().length, 1);
  assert.equal((await f.starts()).length, 1);
});

test("startup failure can retry the persisted binding", async t => {
  const f = await fixture(t);
  process.env.TEST_FAIL_START = "1";
  const broker = await f.start();
  await assert.rejects(broker.initialize("a", undefined, 1, signal()), /startup_failed/);
  const failed = broker.runtimeDiagnostics().sessions.find(item => item.sessionId === broker.binding("a"));
  assert.equal(failed.code, "startup_failed");
  assert.equal(failed.stderrCode, "module_not_found");
  const id = broker.binding("a");
  delete process.env.TEST_FAIL_START;
  const a = await broker.initialize("a", undefined, 2, signal());
  assert.equal(a.session.id, id);
});

test("caller cancellation returns promptly while shared startup completes", async t => {
  const f = await fixture(t);
  process.env.TEST_START_DELAY = "300";
  const broker = await f.start();
  const controller = new AbortController();
  const pending = broker.initialize("a", undefined, 1, controller.signal);
  await until(async () => { try { return (await f.starts()).length === 1; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
  controller.abort(new Error("test cancellation"));
  await assert.rejects(Promise.race([pending, delay(150).then(() => { throw new Error("slow cancellation"); })]), /test cancellation/);
  const resumed = await broker.initialize("a", undefined, 2, signal());
  assert.equal(resumed.session.id, broker.binding("a"));
  assert.equal((await f.starts()).length, 1);
});

test("incompatible managed runtimes fail promptly and can retry the same binding", async t => {
  const f = await fixture(t);
  const broker = await f.start();
  for (const mismatch of ["missing", "nonce", "unicode_nonce", "revision", "build", "cwd", "provider", "tools", "capabilities", "inspect"]) {
    process.env.TEST_HANDSHAKE = mismatch;
    const controller = new AbortController();
    await assert.rejects(broker.initialize(mismatch, undefined, 1, controller.signal), /handshake_mismatch|inspection_mismatch/);
    const id = broker.binding(mismatch);
    assert.equal(broker.listSessions(id).length, 0);
    assert.equal(broker.runtimeDiagnostics().sessions.find(item => item.sessionId === id).status, "failed");
    delete process.env.TEST_HANDSHAKE;
    const restored = await broker.initialize(mismatch, undefined, 2, signal());
    assert.equal(restored.session.id, id);
    assert.equal(restored.session.runtime, undefined, "startup nonce must remain internal");
  }
});

test("concurrent callers wait for inspection rather than using an early registration", async t => {
  const f = await fixture(t);
  process.env.TEST_INSPECT_DELAY = "200";
  const broker = await f.start();
  let completed = false;
  const first = broker.initialize("a", undefined, 1, signal()).then(value => { completed = true; return value; });
  await until(() => broker.listSessions().length === 1);
  const second = broker.initialize("a", undefined, 2, signal());
  await delay(50);
  assert.equal(completed, false);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.session.id, b.session.id);
  assert.equal((await f.starts()).length, 1);
});

test("live and persisted diagnostics classify failures without disclosing stderr or nonce", async t => {
  const f = await fixture(t);
  const broker = await f.start();
  process.env.TEST_FAIL_START = "1";
  await assert.rejects(broker.initialize("a", undefined, 1, signal()), error => {
    assert.match(error.message, /module_not_found/);
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return true;
  });
  const live = await queryDiagnostics(f.directory);
  assert.equal(live.status, "running");
  assert.equal(live.sessions[0].stderrCode, "module_not_found");
  assert.equal(live.sessions[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(live), /synthetic-secret|nonce/);
  delete process.env.TEST_FAIL_START;
  await broker.initialize("a", undefined, 2, signal());
  assert.equal((await queryDiagnostics(f.directory)).sessions[0].status, "online");
  await broker.close();
  const path = join(f.directory, "runtime.json");
  const persisted = await readFile(path, "utf8");
  assert.equal(JSON.parse(persisted).status, "stopped");
  assert.doesNotMatch(persisted, /synthetic-secret|nonce/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await assert.rejects(queryDiagnostics(f.directory), /diagnostics unavailable/);
});

test("managed startup has a bounded deadline and preserves a retryable binding", { timeout: 40_000 }, async t => {
  const f = await fixture(t);
  process.env.TEST_START_DELAY = "60000";
  const broker = await f.start();
  const started = Date.now();
  await assert.rejects(broker.initialize("a", undefined, 1, new AbortController().signal), /startup_timeout/);
  assert.ok(Date.now() - started < 35_000, "failed process cleanup remains bounded");
  const id = broker.binding("a");
  assert.equal((await queryDiagnostics(f.directory)).sessions[0].code, "startup_timeout");
  delete process.env.TEST_START_DELAY;
  const restored = await broker.initialize("a", undefined, 2, signal());
  assert.equal(restored.session.id, id);
});

test("an IPC disconnect cannot remain diagnosed as an online managed runtime", async t => {
  const f = await fixture(t);
  process.env.TEST_DISCONNECT = "1";
  const broker = await f.start();
  const a = await broker.initialize("a", undefined, 1, signal());
  await until(() => broker.listSessions().length === 0);
  assert.equal((await queryDiagnostics(f.directory)).sessions[0].status, "failed");
  assert.equal(broker.runtimeDiagnostics().sessions[0].code, "ipc_disconnected");
  delete process.env.TEST_DISCONNECT;
  const restored = await broker.initialize("a", undefined, 2, signal());
  assert.equal(restored.session.id, a.session.id);
  assert.equal((await queryDiagnostics(f.directory)).sessions[0].status, "online");
});

test("per-peer pending budget rejects excess requests and cancellation releases capacity", async t => {
  const f = await fixture(t);
  process.env.TEST_HANG_HISTORY = "1";
  const broker = await f.start();
  const a = await broker.initialize("a", undefined, 1, signal());
  const controllers = Array.from({ length: 64 }, () => new AbortController());
  const requests = controllers.map(controller => broker.request({ type: "history", sessionId: a.session.id,
    range: { limit: 20 }, clientId: "test", label: "test" }, controller.signal));
  const settled = Promise.allSettled(requests);
  await assert.rejects(broker.request({ type: "history", sessionId: a.session.id,
    range: { limit: 20 }, clientId: "test", label: "test" }, signal()), /capacity exceeded/);
  controllers.forEach(controller => controller.abort(new Error("cancel pending test")));
  assert.ok((await settled).every(result => result.status === "rejected"));
  const runtime = await queryDiagnostics(f.directory);
  assert.equal(runtime.sessions[0].status, "online");
});

test("duplicate relay IDs close the source peer and leave the target runtime usable", async t => {
  const f = await fixture(t);
  process.env.TEST_HANG_HISTORY = "1";
  const broker = await f.start();
  const a = await broker.initialize("a", undefined, 1, signal());
  const socket = createConnection(join(f.directory, "broker.sock"));
  t.after(() => socket.destroy());
  await once(socket, "connect");
  const request = JSON.stringify({ type: "request", id: 123, clientId: "source",
    request: { type: "history", sessionId: a.session.id, range: { limit: 20 }, clientId: "source", label: "test" } }) + "\n";
  socket.write(request);
  await delay(30);
  const closed = once(socket, "close");
  socket.write(request);
  await closed;
  assert.equal((await queryDiagnostics(f.directory)).sessions[0].status, "online");
  assert.equal(broker.listSessions().length, 1);
});

test("packaged diagnostics CLI queries the live broker and exposes check failures", {
  skip: !process.env.CHAPPIE_CLI_BIN,
}, async t => {
  const f = await fixture(t);
  const broker = await f.start();
  const a = await broker.initialize("a", undefined, 1, signal());
  const result = await runFile(process.env.CHAPPIE_CLI_BIN, ["diagnostics", "--json"], { env: process.env });
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.pid, process.pid);
  assert.equal(snapshot.sessions[0].sessionId, a.session.id);
  assert.equal(snapshot.sessions[0].status, "online");
  assert.doesNotMatch(result.stdout, /nonce|synthetic-secret/);
  await runFile(process.env.CHAPPIE_CLI_BIN, ["diagnostics", "--check"], { env: process.env });
  process.env.TEST_FAIL_START = "1";
  await assert.rejects(broker.initialize("failed", undefined, 2, signal()));
  await assert.rejects(runFile(process.env.CHAPPIE_CLI_BIN, ["diagnostics", "--check"], { env: process.env }), error => {
    assert.equal(error.code, 1);
    assert.match(error.stdout, /module_not_found/);
    assert.doesNotMatch(error.stdout + error.stderr, /synthetic-secret/);
    return true;
  });
});

test("real Pi 0.99.1 persists transcript and restores it across broker restarts", {
  skip: !process.env.CHAPPIE_PI_BIN,
}, async t => {
  const f = await fixture(t, { real: true, idleMinutes: 0.01 });
  let broker = await f.start();
  const a = await broker.initialize("real-a", undefined, 1, signal());
  assert.equal(a.session.agent, "pi");
  assert.ok(a.tools.some(tool => tool.name === "read"));
  const message = "TunnelDock transcript persistence integration marker";
  await broker.chat("real-a", undefined, message, 2, signal());
  const b = await broker.initialize("real-b", undefined, 3, signal());
  assert.notEqual(a.session.id, b.session.id);
  const before = await broker.history("real-a", undefined, { limit: 50 }, 4, signal());
  assert.ok(JSON.stringify(before).includes(message));
  await until(() => broker.listSessions().length === 0);
  const afterIdle = await broker.history("real-a", undefined, { limit: 50 }, 5, signal());
  assert.equal(afterIdle.sessionId, a.session.id);
  assert.ok(JSON.stringify(afterIdle).includes(message));
  await broker.close();
  broker = await f.start();
  const restored = await broker.initialize("real-a", undefined, 5, signal());
  assert.equal(restored.session.id, a.session.id);
  const after = await broker.history("real-a", undefined, { limit: 50 }, 6, signal());
  assert.ok(JSON.stringify(after).includes(message));
});
