/** Report rendering — shared by the orchestrator and the standalone command. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function renderReport(jobDir, state, meta = {}) {
  const rows = Object.entries(state)
    .map(([id, st]) => ({
      id,
      stage: st.stage ?? "pending",
      reward: st.reward?.reward,
      f2p: st.reward ? `${st.reward.f2p_passed ?? 0}/${st.reward.f2p_total ?? 0}` : "",
      p2p: st.reward ? `${st.reward.p2p_passed ?? 0}/${st.reward.p2p_total ?? 0}` : "",
      stopReason: st.agent?.stopReason ?? "",
      tokens: st.agent?.usage?.totalTokens ?? "",
      error: st.error ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const solved = rows.filter((r) => r.reward === 1).length;
  const graded = rows.filter((r) => typeof r.reward === "number").length;
  return [
    `# deep-swe run ${jobDir.split(/[\\/]/).pop()}`,
    ``,
    `- driver: ${meta.driver ?? "?"}, model: ${meta.model ? `${meta.model.provider}/${meta.model.modelId}` : "(pi-web default)"}`,
    `- graded: ${graded}/${rows.length}, solved (reward=1): **${solved}**${graded ? ` (${((solved / graded) * 100).toFixed(1)}%)` : ""}`,
    ``,
    `| task | stage | reward | f2p | p2p | stop | tokens | error |`,
    `|---|---|---|---|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.stage} | ${r.reward ?? ""} | ${r.f2p} | ${r.p2p} | ${r.stopReason} | ${r.tokens} | ${r.error.slice(0, 60)} |`),
    ``,
  ].join("\n");
}

export function writeReportFromState(jobDir) {
  const statePath = join(jobDir, "state.json");
  if (!existsSync(statePath)) throw new Error(`no state.json in ${jobDir}`);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  writeFileSync(join(jobDir, "report.md"), renderReport(jobDir, state));
}
