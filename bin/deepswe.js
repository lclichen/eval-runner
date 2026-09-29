#!/usr/bin/env node
/**
 * deep-swe eval runner CLI — pier-equivalent harness driving pi-web.
 *
 * Commands:
 *   run          full pipeline (container → agent → collect → verify → report)
 *   list         show tasks + the subset a --n-tasks/--sample-seed would select
 *   convert-sif  emit an apptainer script converting the task images to SIF
 *   report       re-render report.md/runs.jsonl from an existing job dir
 *
 * Env: PLATFORM_URL / PLATFORM_KEY / PIWEB_URL / PIWEB_KEY (flags win).
 */
import { parseArgs, printHelp } from "../src/cli.js";

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case "run": {
      const { runCommand } = await import("../src/cli-run.js");
      await runCommand(parseArgs(rest));
      break;
    }
    case "list": {
      const { listCommand } = await import("../src/cli-run.js");
      await listCommand(parseArgs(rest));
      break;
    }
    case "convert-sif": {
      const { sifCommand } = await import("../src/cli-run.js");
      await sifCommand(parseArgs(rest));
      break;
    }
    case "report": {
      const { reportCommand } = await import("../src/cli-run.js");
      await reportCommand(parseArgs(rest));
      break;
    }
    default:
      printHelp(cmd === "help" || cmd === "--help" || cmd === "-h" ? 0 : 1);
  }
} catch (e) {
  console.error(String(e?.stack ?? e));
  process.exit(1);
}
