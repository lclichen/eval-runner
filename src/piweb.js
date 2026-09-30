/**
 * pi-web batch API client (v1.3) — the agent backend for eval runs.
 * Docs: pi-web/docs/batch-api.md.
 */

export class PiWebClient {
  constructor(opts) {
    this.url = opts.url.replace(/\/+$/, "");
    this.key = opts.key;
  }

  async request(method, path, body) {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Platform-API-Key": this.key },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch { /* ignore */ }
      throw new Error(`pi-web ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Submit one eval task. sandbox mode + explicit containerId (the runner
   * owns container lifecycle); toolNames defaults to pi-web's PRESET_FULL —
   * exactly the built-in container-local tools (bash/read/edit/write/grep/
   * find/ls), no host-side web tools (deep-swe assumes an air-gapped agent).
   */
  createTask({ containerId, prompt, model, timeoutMs, toolNames, thinkingLevel, inputTimeoutMs }) {
    return this.request("POST", "/api/batch/tasks", {
      mode: "sandbox",
      containerId,
      prompt,
      ...(model ? { model } : {}),
      timeoutMs,
      ...(inputTimeoutMs ? { inputTimeoutMs } : {}),
      toolNames: toolNames ?? ["bash", "read", "edit", "write", "grep", "find", "ls"],
      ...(thinkingLevel ? { thinkingLevel } : {}),
      stream: false,
    });
  }

  getTask(taskId) {
    return this.request("GET", `/api/batch/tasks/${taskId}`);
  }

  getResult(taskId) {
    return this.request("GET", `/api/batch/tasks/${taskId}/result`);
  }

  cancelTask(taskId) {
    return this.request("POST", `/api/batch/tasks/${taskId}/cancel`);
  }

  resumeTask(taskId, prompt) {
    return this.request("POST", `/api/batch/tasks/${taskId}/resume`, prompt ? { prompt } : {});
  }

  /**
   * Poll until a terminal state (completed/failed/cancelled) or the extra
   * deadline passes. `interrupted` triggers onInterrupted once — the runner
   * decides whether to resume (crashed pi-web) or give up.
   */
  async waitForTerminal(taskId, { pollMs = 10_000, deadlineMs, onStatus, onInterrupted }) {
    const start = Date.now();
    let interruptedSeen = false;
    for (;;) {
      const t = await this.getTask(taskId);
      onStatus?.(t);
      if (t.state === "interrupted" && !interruptedSeen) {
        interruptedSeen = true;
        onInterrupted?.(t);
      }
      if (t.state === "completed" || t.state === "failed" || t.state === "cancelled") return t;
      if (deadlineMs && Date.now() - start > deadlineMs) {
        throw new Error(`poll deadline exceeded for task ${taskId} (state=${t.state})`);
      }
      await sleep(pollMs);
    }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
