#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: {
  source: { type: "string" }, package: { type: "string" },
  "pi-bin": { type: "string" }, "pi-version": { type: "string", default: "0.99.1,0.99.2" },
  "temp-dir": { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("Usage: node tests/run-e2e.mjs [--pi-version 0.99.1,0.99.2] [--temp-dir DIR]\nReuse isolated builds: --source DIR --package DIR --pi-bin FILE --pi-version VERSION\nCreates a private HOME, agent directory, npm config and temp root. Never installs globally or stops production services.");
  process.exit(0);
}
assert.equal(Boolean(values.source), Boolean(values.package), "--source and --package must be supplied together");
assert.ok(!values["pi-bin"] || values.package, "--pi-bin requires --source and --package");
const versions = values["pi-version"].split(",");
assert.ok(versions.every(version => /^\d+\.\d+\.\d+$/.test(version)), "invalid Pi version");
assert.ok(!values["pi-bin"] || versions.length === 1, "one Pi version per --pi-bin");
const root = await mkdtemp(join(resolve(values["temp-dir"] ?? tmpdir()), "td-e2e-"));
const home = join(root, "home");
await mkdir(home);
const npmrc = join(root, "npmrc");
await writeFile(npmrc, "");
const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi/agent"),
  TMPDIR: root, npm_config_userconfig: npmrc, npm_config_min_release_age: "0" };
for (const name of Object.keys(env)) if (name.startsWith("TEST_") || name.startsWith("CHAPPIE_") || name === "TUNNELDOCK_PI_NONCE" || name === "npm_config_prefix") delete env[name];
let active;
async function run(command, args, cwd = root, runEnv = env, visible = false) {
  active = spawn(command, args, { cwd, env: runEnv, stdio: visible ? "inherit" : "ignore" });
  const child = active;
  try {
    const [code, signal] = await once(child, "exit");
    assert.equal(code, 0, `${command} failed (exit=${code}, signal=${signal})`);
  } finally { active = undefined; }
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => active?.kill(signal));
try {
  let source = values.source ? resolve(values.source) : join(root, "source");
  let archive;
  if (!values.source) {
    console.log("Building Chappie in the isolated E2E root...");
    await run("git", ["clone", "--quiet", "--depth", "1", "--branch", "v1.1.0", "https://github.com/zetaloop/chappie.git", source]);
    await run("git", ["apply", "--check", join(repo, "patches/chappie-1.1.0-chat-scoped-sessions.patch")], source);
    await run("git", ["apply", join(repo, "patches/chappie-1.1.0-chat-scoped-sessions.patch")], source);
    const tools = join(root, "tools");
    await run("npm", ["install", "--prefix", tools, "--ignore-scripts", "--no-audit", "--no-fund", "pnpm@12.4.1"]);
    await run(join(tools, "node_modules/.bin/pnpm"), ["install", "--frozen-lockfile", "--ignore-scripts", "--config.minimum-release-age=0"], source);
    await run(join(source, "node_modules/.bin/tsc"), ["--noEmit"], source);
    const cli = await readFile(join(repo, "bin/tunneldock"), "utf8");
    const revision = cli.match(/^PATCH_REVISION=(\d+)$/m)?.[1];
    assert.ok(revision, "missing Chappie patch revision");
    const packagePath = join(source, "package.json");
    const pkg = JSON.parse(await readFile(packagePath, "utf8"));
    pkg.version = `1.1.0-tunneldock.${revision}`;
    pkg.tunneldock = JSON.parse(cli.match(/^pkg\.tunneldock = (.*);$/m)[1].replace(/(\w+):/g, '"$1":'));
    await writeFile(packagePath, JSON.stringify(pkg, null, 2) + "\n");
    await run(process.execPath, ["scripts/build.ts"], source);
    await run("npm", ["pack", "--ignore-scripts", "--pack-destination", root], source);
    archive = join(root, `zetaloop-chappie-${pkg.version}.tgz`);
  }
  for (const version of versions) {
    console.log(`Testing real Pi ${version} with isolated MCP/broker processes...`);
    const prefix = join(root, `pi-${version}`);
    let pi = values["pi-bin"] ? resolve(values["pi-bin"]) : join(prefix, "node_modules/.bin/pi");
    if (!values["pi-bin"]) await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${version}`]);
    let pkg = values.package ? resolve(values.package) : join(prefix, "node_modules/@zetaloop/chappie");
    if (archive) await run("npm", ["install", "--prefix", prefix, "--ignore-scripts", "--omit=peer", "--no-audit", "--no-fund", archive]);
    const testEnv = { ...env, CHAPPIE_SOURCE_DIR: source, CHAPPIE_PACKAGE_DIR: pkg,
      CHAPPIE_PI_BIN: pi, CHAPPIE_PI_VERSION: version, CHAPPIE_CLI_BIN: join(pkg, "dist/cli.js") };
    await run(process.execPath, ["--test", "tests/chappie.test.mjs", "tests/chappie-ipc.test.mjs", "tests/mcp-client.test.mjs"], repo, testEnv, true);
  }
  console.log("E2E passed; production services and session files were not modified.");
} finally {
  if (active) { active.kill("SIGTERM"); await once(active, "exit").catch(() => {}); }
  await rm(root, { recursive: true, force: true });
}
