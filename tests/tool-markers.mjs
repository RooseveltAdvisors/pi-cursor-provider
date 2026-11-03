#!/usr/bin/env node
/**
 * Regression: tool calls were rendered as raw JSON argument dumps (with
 * toolCallId/requestId bookkeeping and embedded newlines) and completed
 * events were dropped, so a turn showed call traces and no results.
 *
 * Node loads index.ts through its built-in type stripping, so the test skips
 * itself on Node builds that cannot strip types.
 */
const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  console.log("SKIP: tool-marker tests need Node >= 22 for type stripping");
  process.exit(0);
}

const { formatToolStart, formatToolResult, toolKeyOf } = await import(
  "../index.ts"
);

let failures = 0;
function check(name, condition, detail = "") {
  if (condition) {
    console.log(`PASS: ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL: ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// --- tool key detection: the vendor controls sibling key order -------------
check(
  "toolKeyOf prefers the *ToolCall suffix over position",
  toolKeyOf({ toolCallId: "call-1", shellToolCall: {}, startedAtMs: 1 }) ===
    "shellToolCall",
);
check(
  "toolKeyOf falls back to the first key when nothing matches",
  toolKeyOf({ somethingElse: {} }) === "somethingElse",
);
check(
  "toolKeyOf returns undefined on an empty object",
  toolKeyOf({}) === undefined,
);

// --- started markers -------------------------------------------------------
const shellStart = formatToolStart("Shell", {
  args: {
    command: "echo TRACE-PROBE",
    workingDirectory: "/tmp",
    timeout: 30000,
    toolCallId: "call-1cb74fbf\nfc_27176a8f",
    simpleCommands: ["echo"],
  },
});
check(
  "shell start shows the exact command",
  shellStart.includes("echo TRACE-PROBE"),
  shellStart,
);
check(
  "shell start hides bookkeeping fields",
  !shellStart.includes("toolCallId") &&
    !shellStart.includes("workingDirectory") &&
    !shellStart.includes("simpleCommands"),
  shellStart,
);
check("shell start is a single line", !shellStart.includes("\n"), shellStart);

const readStart = formatToolStart("Read", {
  args: { path: "/tmp/cursor-e2e/probe.txt" },
});
check(
  "read start shows the path",
  readStart.includes("/tmp/cursor-e2e/probe.txt"),
);

const descStart = formatToolStart("Todo", {
  args: { items: [{ text: "a" }] },
  description: "Update  the\ntodo list",
});
check(
  "description fallback collapses whitespace",
  descStart.includes("Update the todo list"),
  descStart,
);

const messy = formatToolStart("Shell", {
  args: { command: "echo one\necho two" },
});
check(
  "newlines in a command collapse",
  !messy.includes("\n"),
  JSON.stringify(messy),
);

const longStart = formatToolStart("Shell", {
  args: { command: "x".repeat(300) },
});
check(
  "long values truncate with an ellipsis",
  longStart.endsWith("…") && longStart.length < 140,
  longStart,
);

// --- completed markers -----------------------------------------------------
const shellOk = formatToolResult("Shell", {
  success: { exitCode: 0, stdout: "hello\n", executionTime: 358 },
});
check(
  "shell success shows verdict, exit code, and timing",
  shellOk.startsWith("✓ [Shell] exit 0 · 358ms"),
  shellOk,
);
check("shell success includes stdout", shellOk.includes("hello"), shellOk);

const readOk = formatToolResult("Read", {
  success: { content: "hello-e2e\n", path: "/tmp/probe.txt" },
});
check(
  "read success shows file content",
  readOk.startsWith("✓ [Read]") && readOk.includes("hello-e2e"),
  readOk,
);

const emptyOk = formatToolResult("Shell", {
  success: { exitCode: 0, stdout: "" },
});
check(
  "empty stdout stays a single verdict line",
  emptyOk === "✓ [Shell] exit 0" && !emptyOk.includes("\n"),
  emptyOk,
);

const blocked = formatToolResult("Shell", {
  rejected: { command: "uname -a", reason: "" },
});
check(
  "rejected without a reason reads blocked",
  blocked === "✗ [Shell] blocked",
  blocked,
);

const blockedReason = formatToolResult("Shell", {
  rejected: { command: "rm -rf /", reason: "denied by policy" },
});
check(
  "rejected surfaces the reason",
  blockedReason === "✗ [Shell] blocked: denied by policy",
  blockedReason,
);

const errored = formatToolResult("Read", {
  error: { message: "file vanished" },
});
check(
  "error surfaces the message",
  errored === "✗ [Read] file vanished",
  errored,
);

check(
  "missing result emits no marker",
  formatToolResult("Shell", undefined) === undefined,
);
check(
  "unknown result shape emits no marker",
  formatToolResult("Shell", {}) === undefined,
);

const ansi = formatToolResult("Shell", {
  success: { exitCode: 0, stdout: "\u001b[31mred\u001b[0m output" },
});
check("ANSI escapes are stripped", !ansi.includes("\u001b"), ansi);

if (failures > 0) {
  console.log(`\ntool-marker tests: ${failures} failure(s)`);
  process.exit(1);
}
console.log("\ntool-marker tests: all cases passed");
