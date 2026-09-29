/**
 * Docker container driver — shells out to the docker CLI. Used for basic
 * functional testing on a dev VM before the platform (SIF) path is exercised;
 * NOT the production eval path (that is PlatformDriver). Same interface as
 * PlatformDriver so the orchestrator is driver-agnostic.
 */
import { execFile } from "node:child_process";
import { normalizeTextContent } from "./platform.js";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function docker(args, opts = {}) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout: opts.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code: err?.code ?? 0 });
    });
  });
}

export class DockerDriver {
  constructor(opts = {}) {
    this.name = "docker";
    this.networkMode = opts.networkMode ?? "none"; // air-gap default (deep-swe fidelity)
  }

  async ensureImage(dockerImage) {
    const pulled = await docker(["pull", dockerImage]);
    if (pulled.err) throw new Error(`docker pull ${dockerImage} failed: ${pulled.stderr.slice(0, 300)}`);
    return { imageId: dockerImage, image: { name: dockerImage } };
  }

  async createContainer({ imageId, name, cpu = 2, memoryMb = 8192 }) {
    const args = [
      "create", "--name", name,
      "--cpus", String(cpu),
      "--memory", `${memoryMb}m`,
      "--network", this.networkMode,
      imageId, "sleep", "infinity",
    ];
    const created = await docker(args);
    if (created.err) throw new Error(`docker create failed: ${created.stderr.slice(0, 300)}`);
    const id = created.stdout.trim();
    return { id, name };
  }

  async startContainer(handle) {
    const r = await docker(["start", handle.name]);
    if (r.err) throw new Error(`docker start failed: ${r.stderr.slice(0, 300)}`);
  }

  async stopContainer(handle) {
    await docker(["stop", handle.name]);
  }

  async removeContainer(handle) {
    await docker(["rm", "-f", handle.name]);
  }

  async exec(handle, command, opts = {}) {
    const r = await docker([
      "exec",
      ...(opts.cwd ? ["-w", opts.cwd] : []),
      handle.name,
      "sh", "-lc", command,
    ], { timeoutMs: (opts.timeoutSec ?? 300) * 1000 + 15_000 });
    return {
      stdout: r.stdout,
      stderr: r.stderr,
      exitCode: r.err ? (typeof r.err.code === "number" ? r.err.code : 1) : 0,
      timedOut: r.err?.killed === true,
    };
  }

  async readFile(handle, path) {
    const tmp = mkdtempSync(join(tmpdir(), "dswe-read-"));
    try {
      const r = await docker(["cp", `${handle.name}:${path}`, tmp]);
      if (r.err) throw new Error(`docker cp out failed: ${r.stderr.slice(0, 200)}`);
      return readFileSync(join(tmp, path.split("/").pop()));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  async writeFile(handle, path, content) {
    const tmp = join(mkdtempSync(join(tmpdir(), "dswe-write-")), path.split("/").pop());
    writeFileSync(tmp, content);
    const r = await docker(["cp", tmp, `${handle.name}:${path}`]);
    rmSync(tmp, { recursive: true, force: true });
    if (r.err) throw new Error(`docker cp in failed: ${r.stderr.slice(0, 200)}`);
  }

  async uploadDir(handle, localDir, remoteDir, { skip = ["Dockerfile"] } = {}) {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    await this.exec(handle, `mkdir -p ${remoteDir}`);
    const walk = async (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        if (statSync(full).isDirectory()) await walk(full, relPath);
        else {
          if (skip.includes(name) && rel === "") continue;
          await this.writeFile(handle, `${remoteDir}/${relPath}`, normalizeTextContent(readFileSync(full), name));
        }
      }
    };
    await walk(localDir, "");
  }
}
