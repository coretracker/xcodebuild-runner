import http from "http";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createWriteStream, mkdirSync } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";

const DEFAULT_PORT = 48173;
const DEFAULT_LOG_DIR = path.resolve(process.cwd(), "logs");
const DEFAULT_HEARTBEAT_IDLE_MS = 10_000;
const DEFAULT_HEARTBEAT_TICK_MS = 2_000;
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;
const LOG_DIR = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : DEFAULT_LOG_DIR;
const SERVER_LOG_PATH = path.join(LOG_DIR, "xcodebuild-runner.log");
const HEARTBEAT_IDLE_MS = parsePositiveIntegerEnv(process.env.HEARTBEAT_IDLE_MS, DEFAULT_HEARTBEAT_IDLE_MS);
const HEARTBEAT_TICK_MS = parsePositiveIntegerEnv(process.env.HEARTBEAT_TICK_MS, DEFAULT_HEARTBEAT_TICK_MS);
const IMPORTANT_FAILURE_MARKERS = [
  "BUILD FAILED",
  "TEST FAILED",
  "The following build commands failed",
  "Testing failed",
  "failed with a nonzero exit code",
  "Build operation failed without specifying any errors.",
  "Individual build tasks may have failed for unknown reasons."
];

mkdirSync(LOG_DIR, { recursive: true });

const serverLogStream = createWriteStream(SERVER_LOG_PATH, { flags: "a" });
serverLogStream.on("error", (err) => {
  process.stderr.write(`${new Date().toISOString()} ERROR server_log_stream_failed error=${JSON.stringify(err.message)} path=${JSON.stringify(SERVER_LOG_PATH)}\n`);
});

function serializeMetaValue(value) {
  if (value instanceof Error) return JSON.stringify(value.message);
  if (typeof value === "string") return JSON.stringify(value);
  return JSON.stringify(value);
}

function parsePositiveIntegerEnv(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function formatMeta(meta = {}) {
  return Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${serializeMetaValue(value)}`)
    .join(" ");
}

function writeLogLine(target, line) {
  try {
    target.write(line);
  } catch (err) {
    process.stderr.write(`${new Date().toISOString()} ERROR log_write_failed target=${target === serverLogStream ? "\"server\"" : "\"stdio\""} error=${JSON.stringify(err.message)}\n`);
  }
}

function log(level, message, meta = {}) {
  const normalizedLevel = level.toUpperCase();
  const metaText = formatMeta(meta);
  const line = `${new Date().toISOString()} ${normalizedLevel} ${message}${metaText ? ` ${metaText}` : ""}\n`;
  writeLogLine(normalizedLevel === "ERROR" ? process.stderr : process.stdout, line);
  writeLogLine(serverLogStream, line);
}

function sanitizeForFilename(value) {
  return value
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "build";
}

function createBuildLogStream(requestId, branch, startedAt) {
  const safeBranch = sanitizeForFilename(branch);
  const safeTimestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const logPath = path.join(LOG_DIR, `build-${safeTimestamp}-${safeBranch}-${requestId}.log`);
  const stream = createWriteStream(logPath, { flags: "a" });
  stream.on("error", (err) => {
    log("ERROR", "build_log_stream_failed", { requestId, buildLogPath: logPath, error: err.message });
  });
  return { logPath, stream };
}

function writeRequestLog(stream, text) {
  if (!stream || !text) return;
  try {
    stream.write(text);
  } catch {}
}

function closeRequestLog(stream) {
  if (!stream) return;
  try {
    stream.end();
  } catch {}
}

function buildRequestId() {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, options);
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => {
      stdout += d.toString("utf8");
    });

    child.stderr?.on("data", (d) => {
      stderr += d.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr, code });
      } else {
        const err = new Error(`${cmd} exited with code ${code}`);
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
  });
}

function isImportantOutputLine(trimmed) {
  if (!trimmed) return false;

  if (
    trimmed.includes(" error: ") ||
    trimmed.startsWith("error:") ||
    trimmed.includes(": error:") ||
    trimmed.includes(" fatal error: ") ||
    trimmed.startsWith("fatal error:") ||
    trimmed.includes(": fatal error:")
  ) {
    return true;
  }

  if (trimmed.includes("BUILD SUCCEEDED") || trimmed.includes("BUILD FAILED")) {
    return true;
  }

  return IMPORTANT_FAILURE_MARKERS.some((marker) => trimmed.includes(marker));
}

function extractErrors(text) {
  const lines = text.split(/\r?\n/);
  const errors = [];
  let captureIndentedFailureBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (line.startsWith("\t") || line.startsWith("    ")) {
      if (captureIndentedFailureBlock) {
        errors.push(trimmed);
      }
      continue;
    }

    captureIndentedFailureBlock = false;

    if (trimmed.startsWith("The following build commands failed")) {
      errors.push(trimmed);
      captureIndentedFailureBlock = true;
      continue;
    }

    if (isImportantOutputLine(trimmed)) {
      errors.push(trimmed);
    }
  }

  return [...new Set(errors)];
}

function tailLines(text, maxLines = 80) {
  return text.split(/\r?\n/).filter(Boolean).slice(-maxLines);
}

function hasFailureMarkers(text) {
  return IMPORTANT_FAILURE_MARKERS.some((marker) => text.includes(marker));
}

function createLineStreamer(onLine) {
  let pending = "";

  return {
    push(text) {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (isImportantOutputLine(trimmed)) {
          onLine(trimmed);
        }
      }
    },
    flush() {
      const trimmed = pending.trim();
      if (isImportantOutputLine(trimmed)) {
        onLine(trimmed);
      }
      pending = "";
    }
  };
}

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function removeWorktree(repoPath, worktreePath) {
  try {
    await run("git", ["worktree", "remove", "--force", worktreePath], {
      cwd: repoPath,
      env: process.env,
    });
  } catch {}

  try {
    if (await pathExists(worktreePath)) {
      await fs.rm(worktreePath, { recursive: true, force: true });
    }
  } catch {}
}

const server = http.createServer((req, res) => {
  const requestId = buildRequestId();
  const remoteAddress = req.socket.remoteAddress ?? null;

  if (req.method !== "POST" || req.url !== "/xcodebuild") {
    log("WARN", "http_not_found", {
      requestId,
      method: req.method,
      url: req.url,
      remoteAddress,
    });
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    log("INFO", "http_request_received", {
      requestId,
      method: req.method,
      url: req.url,
      remoteAddress,
      bodyBytes: Buffer.byteLength(body),
    });

    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      log("WARN", "invalid_json", { requestId, remoteAddress });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Invalid JSON" }));
      return;
    }

    const {
      repoPath,
      branch,
      args = [],
      subdir = "",
    } = payload;

    if (!repoPath || typeof repoPath !== "string") {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`repoPath` is required" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`repoPath` is required" }));
      return;
    }

    if (!path.isAbsolute(repoPath)) {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`repoPath` must be an absolute path" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`repoPath` must be an absolute path" }));
      return;
    }

    if (!branch || typeof branch !== "string") {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`branch` is required" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`branch` is required" }));
      return;
    }

    if (!Array.isArray(args)) {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`args` must be an array" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`args` must be an array" }));
      return;
    }

    if (!args.every((arg) => typeof arg === "string")) {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`args` must be an array of strings" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`args` must be an array of strings" }));
      return;
    }

    if (typeof subdir !== "string") {
      log("WARN", "request_rejected", { requestId, remoteAddress, reason: "`subdir` must be a string" });
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`subdir` must be a string" }));
      return;
    }

    const startedAt = Date.now();
    const { logPath: buildLogPath, stream: requestLogStream } = createBuildLogStream(requestId, branch, startedAt);

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });
    res.flushHeaders?.();

    let combined = "";
    let worktreePath = "";
    let buildCwd = "";
    const streamed = new Set();
    let finished = false;
    let currentPhase = "preparing_worktree";
    let lastClientOutputAt = startedAt;
    let lastHeartbeatAt = 0;
    let heartbeatTimer = null;

    writeRequestLog(
      requestLogStream,
      `# requestId=${requestId} startedAt=${new Date(startedAt).toISOString()} repoPath=${JSON.stringify(repoPath)} branch=${JSON.stringify(branch)} subdir=${JSON.stringify(subdir)} args=${JSON.stringify(args)} remoteAddress=${JSON.stringify(remoteAddress)}\n`
    );

    log("INFO", "build_request_started", {
      requestId,
      repoPath,
      branch,
      subdir,
      args,
      buildLogPath,
    });

    const emitResponseLine = (line, logMessage, meta = {}, level = "INFO", includeInRequestLog = true) => {
      const text = `${line}\n`;
      res.write(text);
      lastClientOutputAt = Date.now();
      if (includeInRequestLog) {
        writeRequestLog(requestLogStream, text);
      }
      if (logMessage) {
        log(level, logMessage, { requestId, ...meta, line });
      }
    };

    const streamLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || streamed.has(trimmed)) return;
      streamed.add(trimmed);
      emitResponseLine(trimmed, "build_output", {}, "INFO", false);
    };

    const stdoutStreamer = createLineStreamer(streamLine);
    const stderrStreamer = createLineStreamer(streamLine);

    heartbeatTimer = setInterval(() => {
      if (finished) return;
      const now = Date.now();
      const idleMs = now - lastClientOutputAt;
      if (idleMs < HEARTBEAT_IDLE_MS) {
        return;
      }
      if (now - lastHeartbeatAt < HEARTBEAT_IDLE_MS) {
        return;
      }
      lastHeartbeatAt = now;
      emitResponseLine(
        `BUILD_HEARTBEAT:elapsedMs=${now - startedAt},idleMs=${idleMs},phase=${currentPhase}`,
        "build_heartbeat",
        {
          elapsedMs: now - startedAt,
          idleMs,
          phase: currentPhase,
        }
      );
    }, HEARTBEAT_TICK_MS);

    const finalize = async (summary, statusLine) => {
      if (finished) return;
      finished = true;

      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }

      stdoutStreamer.flush();
      stderrStreamer.flush();

      if (statusLine && !streamed.has(statusLine)) {
        emitResponseLine(statusLine, "build_status");
      }

      if (worktreePath) {
        currentPhase = "cleaning_up";
        log("INFO", "worktree_cleanup_started", { requestId, repoPath, worktreePath });
        await removeWorktree(repoPath, worktreePath);
        log("INFO", "worktree_cleanup_finished", { requestId, repoPath, worktreePath });
      }

      const finalSummary = {
        ...summary,
        requestId,
        buildLogPath,
        buildCwd,
        durationMs: Date.now() - startedAt,
        cleanedUp: true
      };

      const resultText = JSON.stringify(finalSummary) + "\n";
      res.write("\n__RESULT__\n");
      writeRequestLog(requestLogStream, "\n__RESULT__\n");
      res.write(resultText);
      writeRequestLog(requestLogStream, resultText);
      res.end();

      log(finalSummary.ok ? "INFO" : "ERROR", "build_request_finished", {
        requestId,
        repoPath,
        branch,
        ok: finalSummary.ok,
        exitCode: finalSummary.exitCode,
        signal: finalSummary.signal,
        durationMs: finalSummary.durationMs,
        buildLogPath,
      });

      closeRequestLog(requestLogStream);
    };

    try {
      const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "xcodebuild-worktree-"));
      worktreePath = path.join(tmpBase, "repo");

      emitResponseLine(`PREPARING_WORKTREE:${branch}`, "preparing_worktree", { branch });
      currentPhase = "fetching_refs";
      emitResponseLine("FETCHING_REFS", "fetching_refs");

      await run("git", ["fetch", "--all", "--prune"], {
        cwd: repoPath,
        env: process.env,
      });

      currentPhase = "creating_worktree";
      emitResponseLine(`CREATING_WORKTREE:${branch}`, "creating_worktree", { branch });

      await run("git", ["worktree", "add", "--force", worktreePath, branch], {
        cwd: repoPath,
        env: process.env,
      });

      buildCwd = subdir ? path.resolve(worktreePath, subdir) : worktreePath;
      const resolvedWorktreePath = path.resolve(worktreePath);
      if (buildCwd !== resolvedWorktreePath && !buildCwd.startsWith(`${resolvedWorktreePath}${path.sep}`)) {
        throw new Error("`subdir` must stay inside the checked-out worktree");
      }

      emitResponseLine(`WORKTREE_PATH:${worktreePath}`, "worktree_created", { worktreePath });
      emitResponseLine(`BUILD_CWD:${buildCwd}`, "build_cwd_ready", { buildCwd });

      const child = spawn("xcodebuild", args, {
        cwd: buildCwd,
        env: {
          ...process.env,
          NSUnbufferedIO: "YES"
        },
      });

      currentPhase = "running_build";
      emitResponseLine("BUILD_STARTED", "build_spawned", { buildCwd, args });
      if (child.pid) {
        emitResponseLine(`XCODEBUILD_PID:${child.pid}`, "xcodebuild_pid", { pid: child.pid });
      }

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        combined += text;
        writeRequestLog(requestLogStream, text);
        stdoutStreamer.push(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        combined += text;
        writeRequestLog(requestLogStream, text);
        stderrStreamer.push(text);
      });

      child.on("error", async (err) => {
        log("ERROR", "xcodebuild_spawn_failed", { requestId, error: err.message, buildCwd, args });
        await finalize({
          ok: false,
          exitCode: null,
          signal: null,
          repoPath,
          branch,
          worktreePath,
          args,
          errors: [`Failed to start xcodebuild: ${err.message}`],
          logTail: tailLines(combined, 40),
        }, "BUILD FAILED");
      });

      child.on("close", async (code, signal) => {
        const extractedErrors = extractErrors(combined);
        const ok = code === 0 && !hasFailureMarkers(combined);
        const errors =
          ok
            ? []
            : extractedErrors.length === 0
              ? tailLines(combined, 40)
              : extractedErrors;

        await finalize({
          ok,
          exitCode: code,
          signal: signal ?? null,
          repoPath,
          branch,
          worktreePath,
          args,
          errors,
          logTail: ok ? [] : tailLines(combined, 80),
        }, ok ? "BUILD SUCCEEDED" : "BUILD FAILED");
      });
    } catch (err) {
      log("ERROR", "build_request_failed_before_spawn", {
        requestId,
        repoPath,
        branch,
        error: err.message,
      });
      await finalize({
        ok: false,
        exitCode: null,
        signal: null,
        repoPath,
        branch,
        worktreePath,
        args,
        errors: [err.message],
        gitStdout: err.stdout || "",
        gitStderr: err.stderr || "",
      }, "BUILD FAILED");
    }
  });
});

server.requestTimeout = 0;
server.timeout = 0;
server.on("error", (err) => {
  log("ERROR", "server_error", {
    port: PORT,
    code: err.code,
    syscall: err.syscall,
    address: err.address,
    error: err.message,
  });
  if (!server.listening) {
    serverLogStream.end(() => {
      process.exit(1);
    });
  }
});

server.listen(PORT, () => {
  log("INFO", "server_listening", {
    port: PORT,
    logDir: LOG_DIR,
    serverLogPath: SERVER_LOG_PATH,
  });
});
