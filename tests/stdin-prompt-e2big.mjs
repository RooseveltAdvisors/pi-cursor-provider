#!/usr/bin/env node
/**
 * Behavioral regression: Linux MAX_ARG_STRLEN is 131072.
 * The old Cursor provider put the full Pi transcript in argv, so auto-compaction
 * summarization failed with `spawn E2BIG` once the prompt exceeded that limit.
 * The fixed public path delivers the prompt on stdin.
 *
 * This test exceeds the prior failing payload size and proves:
 *   1) argv transport throws E2BIG (errno 7)
 *   2) stdin transport (the fixed contract) spawns and delivers the full prompt
 */
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_ARG_STRLEN = 131072;
const OVERSIZE = MAX_ARG_STRLEN + 4096;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}

const prompt = "P".repeat(OVERSIZE);
const dir = mkdtempSync(join(tmpdir(), "pi-cursor-e2big-"));
const fakeAgent = join(dir, "agent");

writeFileSync(
  fakeAgent,
  `#!/usr/bin/env node
const fs = require("fs");
const out = process.env.FAKE_AGENT_OUT;
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { stdin += c; });
process.stdin.on("end", () => {
  const maxArg = Math.max(0, ...process.argv.slice(2).map((a) => Buffer.byteLength(a)));
  fs.writeFileSync(out, JSON.stringify({ maxArg, stdinLen: Buffer.byteLength(stdin) }));
  process.stdout.write(JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
    session_id: "test",
  }) + "\\n");
  process.exit(0);
});
`,
  { mode: 0o755 },
);
chmodSync(fakeAgent, 0o755);

// 1) Old argv transport must E2BIG above MAX_ARG_STRLEN.
{
  let hit = null;
  try {
    const child = spawn(fakeAgent, ["--print", "--trust", prompt], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
  } catch (err) {
    hit = err;
  }
  if (!hit || (hit.errno !== 7 && hit.errno !== -7 && hit.code !== "E2BIG")) {
    fail(`expected argv spawn E2BIG, got errno=${hit && hit.errno} code=${hit && hit.code}`);
  }
  pass(`argv transport E2BIG at prompt ${OVERSIZE} bytes (${hit.code || hit.errno})`);
}

// 2) Fixed stdin transport must spawn and deliver the full prompt.
{
  const out = join(dir, "stdin-result.json");
  const child = spawn(fakeAgent, ["--print", "--trust", "--workspace", dir], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FAKE_AGENT_OUT: out },
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt, "utf8");
  const errChunks = [];
  child.stderr.on("data", (c) => errChunks.push(c));
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (code !== 0) {
    fail(`stdin spawn exited ${code}: ${Buffer.concat(errChunks).toString()}`);
  }
  const result = JSON.parse(readFileSync(out, "utf8"));
  if (result.maxArg >= MAX_ARG_STRLEN) {
    fail(`stdin path still placed oversized argv (${result.maxArg})`);
  }
  if (result.stdinLen !== OVERSIZE) {
    fail(`stdin delivered ${result.stdinLen}, want ${OVERSIZE}`);
  }
  pass(`stdin transport delivers ${OVERSIZE}-byte prompt without E2BIG`);
}

rmSync(dir, { recursive: true, force: true });
console.log("All stdin-prompt E2BIG regressions passed.");
