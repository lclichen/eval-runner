/**
 * Platform container driver — drives the sandbox platform REST API
 * (/api/v1/containers, /api/v1/images, /tools/*), the same surface the
 * pi-sandbox-extension uses. This is the production driver: SIF images,
 * multi-device-ready (the platform owns placement), zero docker dependency.
 */
import { Agent, fetch as undiciFetch } from "undici";

// undici's default headersTimeout (300s) is NOT reachable via fetch options
// and fires before any AbortSignal — long synchronous execs (verify test.sh
// builds 10+ min on 1 CPU) die client-side as UND_ERR_HEADERS_TIMEOUT. A
// dedicated dispatcher with both timeouts disabled is the only way through;
// per-call budgets come from the explicit AbortSignal in request(). The
// dispatcher MUST pair with undici's own fetch — passing an npm-undici Agent
// to Node's global fetch mismatches internal interfaces (UND_ERR_INVALID_ARG).
const longRunAgent = new Agent({ headersTimeout: 0, bodyTimeout: 0 });
const fetchWithAgent = (url, init) => undiciFetch(url, { ...init, dispatcher: longRunAgent });

/** Minimal POSIX single-word quoting for paths we embed in exec commands. */
function shellQuote(s) {
  return `'${String(s).replaceAll("'", `'\\''`)}'`;
}

/** Line-ending hygiene for uploaded task files: a Windows `git clone` with
 * autocrlf turns test.sh into CRLF, and bash reads `pipefail\r` as an invalid
 * option — the verifier dies before producing reward.json (hit live). Shell
 * scripts and patches must stay LF; only touch files that are clearly text. */
export function normalizeTextContent(buf, filename) {
  if (!/\.(sh|patch|py|json|txt|md|toml)$/i.test(filename)) return buf;
  const s = buf.toString("utf8");
  if (s.includes("\r\n")) return Buffer.from(s.replace(/\r\n/g, "\n"), "utf8");
  return buf;
}

export class PlatformDriver {
  /**
   * @param opts.url   platform base URL (PI_WEB_PLATFORM_URL style)
   * @param opts.key   platform admin API key (sk_...)
   * @param opts.imageMap  optional map dockerImageRef -> platform image name
   *                   (when SIF files are registered under different names)
   */
  constructor(opts) {
    this.url = opts.url.replace(/\/+$/, "");
    this.key = opts.key;
    this.imageMap = opts.imageMap ?? {};
    this.name = "platform";
    this._imageCache = null;
  }

  async request(method, path, body, opts = {}) {
    const doFetch = () => fetchWithAgent(`${this.url}${path}`, {
      method,
      // Connection: close — pooled keep-alive sockets die silently after
      // long idle windows behind the VPN/NAT hop to the VM (the agent phase
      // idles the platform connection for 20+ minutes; the first verify call
      // then hits stale pool sockets and even a 3s retry reuses another dead
      // one). Eval-scale traffic does not need reuse.
      headers: { "Content-Type": "application/json", "X-API-Key": this.key, Connection: "close" },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      // undici's default headersTimeout is 300s — long-running execs (verify
      // test.sh builds for 10+ min on 1 CPU) otherwise abort client-side with
      // UND_ERR_HEADERS_TIMEOUT before the platform ever responds.
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    });
    let res;
    try {
      res = await doFetch();
    } catch (e) {
      // Dev-machine ↔ VM links blip (VPN hop); one retry after a beat beats
      // failing a whole task at a random stage. Non-idempotent POSTs risk a
      // duplicate on the retry — the platform rejects duplicate container
      // names, so the surfaced error stays truthful.
      if (e?.name !== "TypeError" && e?.cause?.code !== "ECONNRESET" && String(e?.message) !== "fetch failed") throw e;
      await new Promise((r) => setTimeout(r, 3000));
      try {
        res = await doFetch();
      } catch (e2) {
        const cause = e2?.cause ? `${e2.cause.code ?? ""} ${e2.cause.message ?? ""}`.trim() : "";
        throw new Error(`platform ${method} ${path} fetch failed (after retry): ${e2?.message ?? e2} [cause: ${cause}]`);
      }
    }
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`platform ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
  }

  async listImages() {
    if (!this._imageCache) {
      const res = await this.request("GET", "/api/v1/images");
      this._imageCache = res.images ?? [];
    }
    return this._imageCache;
  }

  /** Resolve the task's docker image ref to a platform image id.
   *
   * The platform's image name schema rejects ":" (docker tag separator), so
   * the registration convention is the docker ref with ":" → "-"
   * (public.ecr.aws/...:tag-v1.1 → public.ecr.aws/...-tag-v1.1); an explicit
   * imageMap entry always wins over any convention.
   */
  async ensureImage(dockerImage) {
    const wanted = this.imageMap[dockerImage] ?? dockerImage;
    const normalized = wanted.replaceAll(":", "-");
    const images = await this.listImages();
    const hit = images.find((i) => i.name === wanted)
      ?? images.find((i) => i.name === normalized)
      ?? images.find((i) => i.name.endsWith(`/${wanted}`))
      ?? images.find((i) => i.name.endsWith(`/${normalized}`))
      ?? images.find((i) => wanted.endsWith(`/${i.name}`));
    if (!hit) {
      throw new Error(
        `platform image not found for "${dockerImage}" (tried "${wanted}" / "${normalized}"). ` +
        `Convert + register it first (scripts/register-sif.mjs), or pass --image-map.`,
      );
    }
    return { imageId: hit.id, image: hit };
  }

  /** Register a converted SIF as a platform image (admin). */
  async registerImage({ name, sifPath, displayName, description, cpu, memoryMb, diskGb }) {
    const safeName = name.replaceAll(":", "-");
    return this.request("POST", "/api/v1/admin/images", {
      name: safeName,
      display_name: displayName ?? safeName,
      sif_path: sifPath,
      ...(description ? { description } : {}),
      is_public: true,
      ...(cpu ? { default_resources: { cpu, memoryMb: memoryMb ?? 8192, diskGb: diskGb ?? 20 } } : {}),
    });
  }

  async createContainer({ imageId, name, cpu, memoryMb, diskGb }) {
    const res = await this.request("POST", "/api/v1/containers", {
      imageId,
      name,
      ...(cpu ? { cpu } : {}),
      ...(memoryMb ? { memoryMb } : {}),
      ...(diskGb ? { diskGb } : {}),
    });
    return { id: res.id, name };
  }

  async startContainer(handle) {
    await this.request("POST", `/api/v1/containers/${handle.id}/start`);
  }

  async stopContainer(handle) {
    await this.request("POST", `/api/v1/containers/${handle.id}/stop`);
  }

  /** Destroy the container row entirely — the platform quotas live rows, so
   * stopped-but-alive containers would exhaust the per-user limit across a
   * long eval run (hit live: QUOTA_EXCEEDED 10/10 on the test VM). */
  async removeContainer(handle) {
    await this.request("DELETE", `/api/v1/containers/${handle.id}`);
  }

  async exec(handle, command, opts = {}) {
    return this.request("POST", `/api/v1/containers/${handle.id}/tools/bash`, {
      command,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.timeoutSec ? { timeout: opts.timeoutSec } : {}),
    }, {
      // Client-side budget must exceed the platform-side exec timeout (the
      // platform runs the command synchronously; headers arrive only at the end).
      timeoutMs: (opts.timeoutSec ?? 300) * 1000 + 60_000,
    }); // → { stdout, stderr, exitCode, timedOut }
  }

  async readFile(handle, path) {
    const res = await this.request("POST", `/api/v1/containers/${handle.id}/tools/read`, { path });
    return Buffer.from(res.contentBase64, "base64");
  }

  /**
   * Write a file, retrying once after a short delay — fresh apptainer
   * instances occasionally drop the first exec/write with a generic 255
   * while the instance is still settling (observed on the 4G test VM).
   * Empty content goes through exec: the tools/write schema requires a
   * non-empty base64 string (an empty model.patch is a valid outcome).
   */
  async writeFile(handle, path, content) {
    const buf = Buffer.from(content);
    if (buf.length === 0) {
      const r = await this.exec(handle, `mkdir -p "$(dirname -- ${shellQuote(path)})" && : > ${shellQuote(path)}`);
      if (r.exitCode !== 0) throw new Error(`empty write failed (exit ${r.exitCode}): ${path}`);
      return;
    }
    const body = { path, content: buf.toString("base64") };
    try {
      await this.request("POST", `/api/v1/containers/${handle.id}/tools/write`, body);
    } catch (e) {
      await new Promise((r) => setTimeout(r, 3000));
      await this.request("POST", `/api/v1/containers/${handle.id}/tools/write`, body);
    }
  }

  /** Recursively upload a local directory (the task's tests/) into the container. */
  async uploadDir(handle, localDir, remoteDir, { skip = ["Dockerfile"] } = {}) {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = async (dir, rel) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const relPath = rel ? `${rel}/${name}` : name;
        if (statSync(full).isDirectory()) await walk(full, relPath);
        else {
          if (skip.includes(name) && rel === "") continue; // verifier Dockerfile — unused here
          await this.writeFile(handle, `${remoteDir}/${relPath}`, normalizeTextContent(readFileSync(full), name));
        }
      }
    };
    await this.exec(handle, `mkdir -p ${remoteDir}`);
    await walk(localDir, "");
  }
}
