/**
 * deep-swe (Harbor format) task discovery and parsing.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseToml } from "./toml.js";

const DEFAULT_APP_DIR = "/app";

/**
 * Parse one task dir → {
 *   id, dir, dockerImage, agentTimeoutSec, verifierTimeoutSec,
 *   cpus, memoryMb, storageMb, collect: [{command, timeoutSec}],
 *   instruction, appDir
 * }
 */
export function loadTask(taskDir) {
  const tomlPath = join(taskDir, "task.toml");
  if (!existsSync(tomlPath)) throw new Error(`no task.toml in ${taskDir}`);
  const t = parseToml(readFileSync(tomlPath, "utf8"));

  const id = t?.metadata?.task_id;
  const dockerImage = t?.environment?.docker_image;
  if (!id) throw new Error(`${taskDir}: missing metadata.task_id`);
  if (!dockerImage) throw new Error(`${taskDir}: missing environment.docker_image`);

  const instructionPath = join(taskDir, "instruction.md");
  const instruction = existsSync(instructionPath)
    ? readFileSync(instructionPath, "utf8")
    : (() => { throw new Error(`${taskDir}: missing instruction.md`); })();

  const collect = (Array.isArray(t?.verifier?.collect) ? t.verifier.collect : []).map((c) => ({
    command: String(c.command ?? ""),
    timeoutSec: Number(c.timeout_sec ?? 300),
  }));
  if (collect.length === 0) throw new Error(`${taskDir}: no [[verifier.collect]] steps`);

  return {
    id,
    dir: taskDir,
    dockerImage,
    agentTimeoutSec: Number(t?.agent?.timeout_sec ?? 3600),
    verifierTimeoutSec: Number(t?.verifier?.timeout_sec ?? 1800),
    cpus: Number(t?.environment?.cpus ?? 2),
    memoryMb: Number(t?.environment?.memory_mb ?? 8192),
    storageMb: Number(t?.environment?.storage_mb ?? 20480),
    collect,
    instruction,
    appDir: DEFAULT_APP_DIR,
  };
}

/** Load every task directory under a deep-swe `tasks/` root. */
export function loadTasks(root) {
  const out = [];
  for (const name of readdirSync(root).sort()) {
    const dir = join(root, name);
    if (!statSync(dir).isDirectory()) continue;
    if (!existsSync(join(dir, "task.toml"))) continue;
    out.push(loadTask(dir));
  }
  return out;
}

/** Seeded subset selection — pier-compatible --n-tasks/--sample-seed semantics:
 * deterministic shuffle by seed, take n. Same (n, seed) pair always yields the
 * same subset, so partial runs are comparable across retries. */
export function sampleTasks(tasks, n, seed) {
  if (!n || n >= tasks.length) return tasks;
  const rand = lcg(seed >>> 0);
  const arr = [...tasks];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.slice(0, n);
}

function lcg(seed) {
  // Numerical Recipes constants — deterministic across Node versions.
  let s = seed || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}
