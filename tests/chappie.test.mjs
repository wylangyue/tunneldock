// Run against a patched upstream checkout. All processes and files are temporary.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const source = process.env.CHAPPIE_SOURCE_DIR;
assert.ok(source, "set CHAPPIE_SOURCE_DIR to a patched Chappie 1.1.0 checkout");
const { Broker } = await import(pathToFileURL(join(resolve(source), "src/broker.ts")));
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
if (process.env.TEST_FAIL_START === "1") process.exit(2);
const socket = createConnection(process.env.HOME + "/.chappie/broker.sock");
const session = { id: sid, cwd: process.cwd(), agent: "pi", device: "fixture", status: process.env.TEST_STATUS ?? "ready" };
const send = message => socket.write(JSON.stringify(message) + "\\n");
socket.on("connect", () => setTimeout(() => send({ type: "sync", id: 1, session }), Number(process.env.TEST_START_DELAY ?? 0)));
createInterface({ input: socket }).on("line", line => {
 const m = JSON.parse(line);
 if (m.type === "inspect") send({ type: "result", id: m.id, inspection: { session, tools: [], skills: [] }, inputs: [] });
 if (m.type === "inputs") send({ type: "result", id: m.id, inputs: [] });
 if (m.type === "history") send({ type: "result", id: m.id, cwd: process.cwd(), history: { count: 0, hasMore: false, content: [] } });
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
  await assert.rejects(broker.initialize("a", undefined, 1, signal()), /exited/);
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
