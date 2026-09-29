/** Shared CLI plumbing: arg parsing + help text. */

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("-")) { out._.push(a); continue; }
    const key = a.replace(/^--?/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("-")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  // comma lists
  for (const k of ["only", "toolNames", "imageMap"]) {
    if (typeof out[k] === "string") out[k] = out[k].split(",").map((s) => s.trim()).filter(Boolean);
  }
  // imageMap entries look like dockerRef=platformName
  if (Array.isArray(out.imageMap)) {
    out.imageMap = Object.fromEntries(
      out.imageMap.map((e) => {
        const idx = e.indexOf("=");
        return idx > 0 ? [e.slice(0, idx), e.slice(idx + 1)] : [e, e];
      }),
    );
  }
  out.nTasks = out.nTasks ? Number(out.nTasks) : undefined;
  out.sampleSeed = out.sampleSeed ? Number(out.sampleSeed) : undefined;
  out.concurrency = out.concurrency ? Number(out.concurrency) : 1;
  return out;
}

export function printHelp(code = 0) {
  console.log(`deep-swe eval runner — drives pi-web batch API over Harbor-format tasks

Usage:
  deepswe run        --tasks <dir> [--driver platform|docker] [options]
  deepswe list       --tasks <dir> [--n-tasks N --sample-seed S]
  deepswe convert-sif --tasks <dir> --out-dir <dir> [--only id,id]
  deepswe report     --job <dir>

Options:
  --tasks <dir>          deep-swe tasks/ root (or any dir of Harbor task dirs)
  --driver <name>        platform (default; sandbox platform REST + SIF) | docker (dev VM)
  --platform-url/--platform-key    platform endpoint + admin API key (env PLATFORM_URL/KEY)
  --piweb-url/--piweb-key          pi-web endpoint + admin API key (env PIWEB_URL/KEY)
  --model provider/modelId         model override for the agent sessions
  --n-tasks N            run a subset (LCG-shuffled)
  --sample-seed S        seed for the subset (same n+seed = same subset)
  --only id,id           restrict to explicit task ids
  --concurrency N        parallel tasks (default 1)
  --run-id <name>        job dir name under jobs/ (default: timestamp)
  --jobs-dir <dir>       output root (default ./jobs)
  --tool-names a,b,c     agent tool allowlist (default: bash,read,write,edit,glob,grep)
  --keep-containers      do not stop/remove task containers (debugging)
  --no-auto-resume       do not resume interrupted pi-web tasks
`);
  process.exit(code);
}
