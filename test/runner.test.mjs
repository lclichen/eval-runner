import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseToml } from "../src/toml.js";
import { loadTask, loadTasks, sampleTasks } from "../src/tasks.js";
import { renderReport } from "../src/report.js";

const FIXTURE = new URL("./fixtures/abs-module-cache-flags", import.meta.url).pathname
  // Windows: URL pathname keeps a leading slash ("/D:/..."), strip it.
  .replace(/^\/([A-Za-z]:)/, "$1");

test("toml: parses the full fixture task.toml", () => {
  const text = readFileSync(new URL("./fixtures/abs-module-cache-flags/task.toml", import.meta.url), "utf8");
  const t = parseToml(text);
  assert.equal(t.schema_version, "1.3");
  assert.deepEqual(t.artifacts, ["/logs/artifacts/model.patch"]);
  assert.equal(t.metadata.task_id, "abs-module-cache-flags");
  assert.equal(t.metadata.language, "go");
  assert.equal(t.agent.timeout_sec, 10800);
  assert.equal(t.agent.network_mode, "no-network");
  assert.equal(t.environment.cpus, 2);
  assert.equal(t.environment.memory_mb, 8192);
  assert.ok(Array.isArray(t.verifier.collect) && t.verifier.collect.length === 1);
  assert.match(t.verifier.collect[0].command, /git diff --binary/);
  assert.equal(t.verifier.collect[0].timeout_sec, 300);
  assert.equal(t.verifier.environment_mode, "separate");
  assert.equal(t.verifier.timeout_sec, 1800);
});

test("toml: comments, escapes, arrays, booleans, floats, literal strings", () => {
  const t = parseToml([
    "# full comment line",
    'key = "va\\"lue" # trailing comment',
    "lit = 'no\\escape'",
    "arr = [ \"a\", 'b', 3, -4.5 ]",
    "flag = true",
    "off = false",
    "[sub]",
    "n = 42",
    "[[items]]",
    "x = 1",
    "[[items]]",
    "x = 2",
    "[sub2.nested]",
    "deep = 'd'",
  ].join("\n"));
  assert.equal(t.key, 'va"lue');
  assert.equal(t.lit, "no\\escape");
  assert.deepEqual(t.arr, ["a", "b", 3, -4.5]);
  assert.equal(t.flag, true);
  assert.equal(t.off, false);
  assert.equal(t.sub.n, 42);
  assert.deepEqual(t.items, [{ x: 1 }, { x: 2 }]);
  assert.equal(t.sub2.nested.deep, "d");
});

test("toml: fails loud on unsupported syntax", () => {
  assert.throws(() => parseToml("x = '''\nmulti\n'''"), /multi-line|malformed|unsupported/i);
  assert.throws(() => parseToml("bad ="), /line 1/);
});

test("tasks: loadTask extracts the eval-relevant fields", () => {
  const t = loadTask(FIXTURE);
  assert.equal(t.id, "abs-module-cache-flags");
  assert.equal(t.dockerImage, "public.ecr.aws/d3j8x8q7/swe-bench-202605:kh75679ajj3b8dtd7se3h7z0a1833y6r-v1.1");
  assert.equal(t.agentTimeoutSec, 10800);
  assert.equal(t.verifierTimeoutSec, 1800);
  assert.equal(t.appDir, "/app");
  assert.ok(t.instruction.includes("ABS module loading"));
  assert.ok(t.collect[0].command.includes("git diff"));
});

test("tasks: loadTasks over a tasks root + deterministic sampling", () => {
  const root = new URL("./fixtures", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const all = loadTasks(root);
  assert.equal(all.length, 1);
  // Sampling with fixed (n, seed) is stable across calls — comparable retries.
  const a = sampleTasks([1, 2, 3, 4, 5], 3, 42);
  const b = sampleTasks([1, 2, 3, 4, 5], 3, 42);
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  // n >= length returns everything
  assert.deepEqual(sampleTasks([1, 2], 10, 7), [1, 2]);
});

test("report: renders markdown with solve rate from state", () => {
  const state = {
    "t-a": { stage: "done", reward: { reward: 1, f2p_total: 3, f2p_passed: 3, p2p_total: 1, p2p_passed: 1 }, agent: { stopReason: "end_turn", usage: { totalTokens: 1000 } } },
    "t-b": { stage: "verify-done", reward: { reward: 0, f2p_total: 3, f2p_passed: 1 }, agent: { stopReason: "timeout", usage: { totalTokens: 2000 } } },
  };
  const md = renderReport("jobs/demo", state, { driver: "platform", model: { provider: "zai", modelId: "glm-4.7" } });
  assert.match(md, /solved \(reward=1\): \*\*1\*\* \(50\.0%\)/);
  assert.match(md, /\| t-a \| done \| 1 \| 3\/3 \| 1\/1 \| end_turn \| 1000 \|  \|/);
  assert.match(md, /\| t-b \| verify-done \| 0 \| 1\/3 \| 0\/0 \| timeout \| 2000 \|  \|/);
});
