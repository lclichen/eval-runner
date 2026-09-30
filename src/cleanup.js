/**
 * Client-driven container reclamation — the flip side of the default
 * stop-retain policy: task containers survive task end (overlay kept for
 * artifact recovery; the platform has NO auto-GC for stopped containers and
 * its quota counts live rows), so destruction is an explicit client call.
 *
 *   deepswe cleanup --run-id smoke12            # destroy dswe-<runId>-* rows
 *   deepswe cleanup --older-than 7d             # age-based (regular policy)
 *   deepswe cleanup --all                       # every dswe-* row (confirm)
 */
import { PlatformDriver } from "./platform.js";

const DAY_MS = 24 * 3600 * 1000;

function parseAge(spec) {
  const m = /^(\d+)([d|h])$/.exec(String(spec ?? "").trim());
  if (!m) throw new Error(`--older-than expects like 7d / 48h, got "${spec}"`);
  return Number(m[1]) * (m[2] === "d" ? DAY_MS : 3600_000);
}

export async function cleanupCommand(args, { log = console } = {}) {
  const url = args.platformUrl ?? process.env.PLATFORM_URL;
  const key = args.platformKey ?? process.env.PLATFORM_KEY;
  if (!url || !key) throw new Error("need --platform-url/--platform-key (or PLATFORM_URL/PLATFORM_KEY)");
  if (!args.runId && !args.olderThan && !args.all) {
    throw new Error("specify --run-id <id>, --older-than 7d, or --all");
  }
  const driver = new PlatformDriver({ url, key });
  const cutoff = args.olderThan ? Date.now() - parseAge(args.olderThan) : 0;
  const prefix = args.runId ? `dswe-${args.runId}-` : "dswe-";

  const list = await driver.request("GET", "/api/v1/containers?filter=all");
  const rows = (list.containers ?? []).filter((c) => c.name.startsWith(prefix));
  const victims = args.olderThan || args.all
    ? rows.filter((c) => {
        if (!args.olderThan) return true;
        const ts = Date.parse(c.created_at ?? "") || 0;
        return ts > 0 && ts < cutoff;
      })
    : rows;

  if (victims.length === 0) {
    log.info?.(`no containers matching ${args.runId ? `run ${args.runId}` : args.olderThan ? `older than ${args.olderThan}` : "dswe-*"}`);
    return;
  }
  for (const c of victims) {
    if (c.status === "running") await driver.stopContainer({ id: c.id, name: c.name }).catch(() => {});
    const r = await driver.request("DELETE", `/api/v1/containers/${c.id}`).catch((e) => ({ err: e.message }));
    log.info?.(c.name, c.status, "→", r.err ? `FAIL ${r.err}` : "destroyed");
  }
  log.info?.(`cleanup: ${victims.length} container(s) destroyed`);
}
