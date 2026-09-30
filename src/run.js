/**
 * Eval orchestrator — the per-task pipeline:
 *
 *   container → agent (pi-web batch API, sandbox mode) → collect (verifier.collect)
 *   → verify (fresh container, tests/test.sh) → report
 *
 * Every stage transition is journaled to jobs/<runId>/state.json, so a crashed
 * run resumes by skipping finished stages (and pi-web-side interruptions are
 * resumed through POST /tasks/{id}/resume).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadTasks, sampleTasks } from "./tasks.js";
import { renderReport } from "./report.js";

const STAGES = ["pending", "container", "agent", "collect", "verify", "done"];

// Live containers created by THIS process. SIGINT/SIGTERM must destroy them —
// a killed runner otherwise leaks verify/agent containers until the platform
// quota fills (observed: two orphans after timeout-killed runs). Idempotent
// stop→destroy; best-effort, never blocks exit for long.
const liveContainers = [];
function trackContainer(driver, handle) {
  liveContainers.push({ driver, handle });
}
function untrackContainer(handle) {
  const i = liveContainers.findIndex((e) => e.handle.id === handle.id);
  if (i >= 0) liveContainers.splice(i, 1);
}
let cleaningUp = false;
async function cleanupLiveContainers(reason) {
  if (cleaningUp) return;
  cleaningUp = true;
  if (liveContainers.length === 0) process.exit(0);
  console.error(`[${reason}] destroying ${liveContainers.length} live container(s)...`);
  const deadline = Date.now() + 15_000;
  await Promise.allSettled(liveContainers.map(async ({ driver, handle }) => {
    await driver.stopContainer(handle).catch(() => {});
    if (driver.removeContainer) await driver.removeContainer(handle).catch(() => {});
  }));
  if (Date.now() > deadline) console.error("[cleanup] slow container teardown; exiting anyway");
  process.exit(0);
}
process.on("SIGINT", () => void cleanupLiveContainers("SIGINT"));
process.on("SIGTERM", () => void cleanupLiveContainers("SIGTERM"));

export async function runEval(config) {
  const {
    tasksRoot, driver, piweb,
    runId, jobsDir,
    model, concurrency = 1,
    nTasks, sampleSeed,
    toolNames, inputTimeoutMs,
    agentSlackSec = 600,
    keepContainers = false,
    /** Oracle mode: grade the reference solution instead of an agent run —
     * validates the collect→verify→reward chain (expect reward=1). */
    oracle = false,
    autoResume = true,
    maxResumes = 3,
    onlyTasks = [],
    /** Host-fit overrides for the per-task resource envelope (small VMs). */
    cpuOverride,
    memoryOverride,
    log = console,
  } = config;

  const allTasks = loadTasks(tasksRoot);
  let tasks = sampleTasks(allTasks, nTasks, sampleSeed);
  if (onlyTasks.length) tasks = tasks.filter((t) => onlyTasks.includes(t.id));
  if (tasks.length === 0) throw new Error("no tasks selected");

  const runDir = join(jobsDir, runId);
  mkdirSync(runDir, { recursive: true });
  const statePath = join(runDir, "state.json");
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
  const saveState = () => writeFileSync(statePath, JSON.stringify(state, null, 2));

  log.info?.(`[run ${runId}] ${tasks.length} task(s), driver=${driver.name}, concurrency=${concurrency}`);

  let running = 0;
  let index = 0;
  const failures = [];
  return new Promise((resolveRun) => {
    const launchNext = () => {
      while (running < concurrency && index < tasks.length) {
        const task = tasks[index++];
        running++;
        runOne(task)
          .catch(async (e) => {
            failures.push({ id: task.id, error: String(e?.message ?? e) });
            state[task.id] = { ...(state[task.id] ?? {}), stage: "error", error: String(e?.message ?? e) };
            saveState();
            log.error?.(`[${task.id}] pipeline failed: ${e?.message ?? e}`);
          })
          .finally(() => {
            running--;
            if (index >= tasks.length && running === 0) resolveRun();
            else launchNext();
          });
      }
    };
    launchNext();
  }).then(() => {
    const meta = { model, driver: driver.name };
    writeFileSync(join(runDir, "report.md"), renderReport(runDir, state, meta));
    for (const [id, st] of Object.entries(state)) {
      appendFileSync(join(runDir, "runs.jsonl"), JSON.stringify({
        at: Date.now(), ...meta,
        id, stage: st.stage ?? "pending",
        reward: st.reward?.reward,
        stopReason: st.agent?.stopReason ?? "",
        tokens: st.agent?.usage?.totalTokens ?? undefined,
        error: st.error ?? undefined,
      }) + "\n");
    }
    return { runDir, failures };
  });

  // ---------------------------------------------------------------------

  async function runOne(task) {
    const st = (state[task.id] ??= { stage: "pending", attempts: 0 });
    const taskDir = join(runDir, task.id);
    mkdirSync(taskDir, { recursive: true });

    if (stageDone(st.stage, "container")) return; // fully finished in a previous run

    let agentReleased = false;
    const taskCpu = cpuOverride ?? task.cpus;
    const taskMemoryMb = memoryOverride ?? task.memoryMb;

    // ---- oracle mode: skip agent+collect, feed the REFERENCE solution patch
    // through verify → validates the grading chain deterministically (a
    // correct solution must yield reward=1; anything else is a pipeline bug).
    if (oracle && st.stage === "pending") {
      const { readdirSync: rd } = await import("node:fs");
      const solDir = join(task.dir, "solution");
      const patches = rd(solDir).filter((f) => f.endsWith(".patch"));
      if (!patches.length) throw new Error(`oracle: no *.patch in ${solDir}`);
      const patch = readFileSync(join(solDir, patches[0]));
      writeFileSync(join(taskDir, "model.patch"), patch);
      st.patchBytes = patch.length;
      st.agent = { state: "oracle", stopReason: "oracle" };
      st.stage = "collect-done";
      saveState();
      log.info?.(`[${task.id}] oracle: reference patch ${patch.length}B in place`);
    }

    // ---- stage: container (agent env) ----
    // A journaled container from a previous (crashed) run gets restarted and
    // reused; if it is gone entirely we create a fresh one under the same name.
    let agentContainer;
    if (!oracle) {
      if (st.agentContainerName) {
        agentContainer = { id: st.agentContainerId, name: st.agentContainerName };
        try {
          await driver.startContainer(agentContainer);
        } catch {
          agentContainer = null;
        }
      }
      if (!agentContainer) {
        const { imageId } = await driver.ensureImage(task.dockerImage);
        agentContainer = await driver.createContainer({
          imageId,
          name: `dswe-${runId}-${task.id}`.slice(0, 96),
          cpu: taskCpu,
          memoryMb: taskMemoryMb,
          diskGb: Math.ceil(task.storageMb / 1024),
        });
        await driver.startContainer(agentContainer);
        trackContainer(driver, agentContainer);
        st.agentContainerId = agentContainer.id;
        st.agentContainerName = agentContainer.name;
        saveState();
      }
      log.info?.(`[${task.id}] container ready (${agentContainer.name})`);
    }

    try {
      // ---- stage: agent ----
      // Oracle mode jumps straight past the agent stage (stage is already
      // "collect-done"); the resume path keeps its "agent-done" journal check.
      if (!oracle && st.stage !== "agent-done") {
        if (!st.piwebTaskId) {
          const created = await piweb.createTask({
            containerId: agentContainer.id,
            prompt: task.instruction,
            model,
            timeoutMs: (task.agentTimeoutSec + agentSlackSec) * 1000,
            toolNames,
            inputTimeoutMs,
          });
          st.piwebTaskId = created.taskId;
          st.stage = "agent";
          saveState();
        }
        let terminal = await piweb.waitForTerminal(st.piwebTaskId, {
          deadlineMs: (task.agentTimeoutSec + agentSlackSec + 3600) * 1000,
          onInterrupted: () => log.warn?.(`[${task.id}] pi-web restarted mid-task — will resume`),
        });
        for (let resumes = 0; terminal.state === "interrupted" && autoResume && resumes < maxResumes; resumes++) {
          await piweb.resumeTask(st.piwebTaskId);
          terminal = await piweb.waitForTerminal(st.piwebTaskId, {
            deadlineMs: (task.agentTimeoutSec + agentSlackSec + 3600) * 1000,
          });
        }
        if (terminal.state === "interrupted") throw new Error("agent task still interrupted after max resumes");
        const result = await piweb.getResult(st.piwebTaskId).catch(() => ({}));
        st.agent = {
          state: terminal.state,
          stopReason: terminal.stopReason,
          usage: result.usage ?? terminal.usage,
          durationMs: terminal.durationMs,
        };
        writeFileSync(join(taskDir, "agent-result.json"), JSON.stringify(result, null, 2));
        if (result.sessionFile) st.sessionFile = result.sessionFile;
        st.stage = "agent-done";
        saveState();
        log.info?.(`[${task.id}] agent ${terminal.state}/${terminal.stopReason}`);
        if (terminal.state !== "completed") {
          // A cancelled/failed agent still gets graded — an unfinished patch is
          // a legitimate (failing) eval outcome, not infra noise.
          log.warn?.(`[${task.id}] agent did not complete cleanly; grading anyway`);
        }
      }

      // ---- stage: collect (extract model.patch from the agent container) ----
      if (st.stage !== "collect-done") {
        for (const step of task.collect) {
          const r = await driver.exec(agentContainer, step.command, { timeoutSec: step.timeoutSec });
          if (r.exitCode !== 0) {
            throw new Error(`verifier.collect failed (exit ${r.exitCode}): ${(r.stderr || r.stdout).slice(0, 300)}`);
          }
        }
        const patch = await driver.readFile(agentContainer, "/logs/artifacts/model.patch");
        writeFileSync(join(taskDir, "model.patch"), patch);
        st.patchBytes = patch.length;
        st.stage = "collect-done";
        saveState();
        log.info?.(`[${task.id}] collected model.patch (${patch.length} bytes)`);
      }

      // Release the agent container BEFORE the verifier starts: verify runs in
      // a fresh container from the same image, and small hosts (the 4G test
      // VM) cannot keep two task-spec containers alive at once. (Oracle mode
      // never created one — agentContainer is undefined there.)
      if (agentContainer && !keepContainers) {
        await driver.stopContainer(agentContainer).catch(() => {});
        if (driver.removeContainer) await driver.removeContainer(agentContainer).catch(() => {});
        untrackContainer(agentContainer);
        agentReleased = true;
      }

      // ---- stage: verify (fresh container, pristine repo + tests) ----
      if (st.stage !== "verify-done") {
        const reward = await verifyTask(task, taskDir, driver, { keepContainers, cpu: taskCpu, memoryMb: taskMemoryMb });
        st.reward = reward;
        st.stage = "verify-done";
        saveState();
        log.info?.(`[${task.id}] reward=${reward.reward} (f2p ${reward.f2p_passed}/${reward.f2p_total}, p2p ${reward.p2p_passed ?? "?"}/${reward.p2p_total ?? "?"})`);
      }

      st.stage = "done";
      saveState();
    } finally {
      if (agentContainer && !keepContainers && !agentReleased) {
        await driver.stopContainer(agentContainer).catch(() => {});
        if (driver.removeContainer) await driver.removeContainer(agentContainer).catch(() => {});
        untrackContainer(agentContainer);
      }
    }
  }
}

function stageDone(current, target) {
  return STAGES.indexOf(current ?? "pending") >= STAGES.indexOf(target);
}

async function verifyTask(task, taskDir, driver, { keepContainers, cpu, memoryMb }) {
  const { imageId } = await driver.ensureImage(task.dockerImage);
  const handle = await driver.createContainer({
    imageId,
    name: `dswe-${task.id}-verify-${Date.now().toString(36)}`.slice(0, 96),
    cpu,
    memoryMb,
    diskGb: Math.ceil(task.storageMb / 1024),
  });
  try {
    await driver.startContainer(handle);
    // Pristine verifier environment: /tests from the task dir, the collected
    // patch at the artifacts path grader.py prepare expects, writable /logs.
    await driver.exec(handle, "mkdir -p /logs/artifacts /logs/verifier");
    await driver.uploadDir(handle, join(task.dir, "tests"), "/tests");
    const patch = readFileSync(join(taskDir, "model.patch"));
    await driver.writeFile(handle, "/logs/artifacts/model.patch", patch);

    // HOME must point at the image's baked root: the platform's apptainer exec
    // bind-mounts the HOST home over the container one, shadowing /root/go
    // (the image's `go mod download` cache) — without this restore, every go
    // build fails [setup failed] on missing modules and NO test ever runs
    // (found via oracle: reference patch graded 0). Harmless for non-Go tasks.
    const r = await driver.exec(handle, "export HOME=/root GOPATH=/root/go GOMODCACHE=/root/go/pkg/mod; bash /tests/test.sh", {
      cwd: "/app",
      timeoutSec: task.verifierTimeoutSec + 300,
    });
    writeFileSync(join(taskDir, "verify-stdout.txt"), `${r.stdout}\n${r.stderr}`);

    const reward = JSON.parse((await driver.readFile(handle, "/logs/verifier/reward.json")).toString("utf8"));
    writeFileSync(join(taskDir, "reward.json"), JSON.stringify(reward, null, 2));
    for (const extra of ["/logs/verifier/ctrf.json", "/logs/verifier/run.log"]) {
      const content = await driver.readFile(handle, extra).catch(() => null);
      if (content) writeFileSync(join(taskDir, extra.split("/").pop()), content);
    }
    return reward;
  } finally {
    if (!keepContainers) {
      await driver.stopContainer(handle).catch(() => {});
      if (driver.removeContainer) await driver.removeContainer(handle).catch(() => {});
    }
    untrackContainer(handle);
  }
}
