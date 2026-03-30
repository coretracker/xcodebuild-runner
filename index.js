import http from "http";
import { spawn } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const DEFAULT_PORT = 48173;
const parsedPort = Number.parseInt(process.env.PORT ?? "", 10);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : DEFAULT_PORT;
const IMPORTANT_FAILURE_MARKERS = [
  "BUILD FAILED",
  "TEST FAILED",
  "The following build commands failed",
  "Testing failed",
  "failed with a nonzero exit code",
  "Build operation failed without specifying any errors.",
  "Individual build tasks may have failed for unknown reasons."
];

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
  if (req.method !== "POST" || req.url !== "/xcodebuild") {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });

  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
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
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`repoPath` is required" }));
      return;
    }

    if (!path.isAbsolute(repoPath)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`repoPath` must be an absolute path" }));
      return;
    }

    if (!branch || typeof branch !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`branch` is required" }));
      return;
    }

    if (!Array.isArray(args)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`args` must be an array" }));
      return;
    }

    if (!args.every((arg) => typeof arg === "string")) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`args` must be an array of strings" }));
      return;
    }

    if (typeof subdir !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "`subdir` must be a string" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    });

    let combined = "";
    let worktreePath = "";
    let buildCwd = "";
    const streamed = new Set();
    let finished = false;
    const startedAt = Date.now();

    const streamLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || streamed.has(trimmed)) return;
      streamed.add(trimmed);
      res.write(trimmed + "\n");
    };

    const stdoutStreamer = createLineStreamer(streamLine);
    const stderrStreamer = createLineStreamer(streamLine);

    const finalize = async (summary, statusLine) => {
      if (finished) return;
      finished = true;

      stdoutStreamer.flush();
      stderrStreamer.flush();

      if (statusLine && !streamed.has(statusLine)) {
        res.write(`${statusLine}\n`);
      }

      if (worktreePath) {
        await removeWorktree(repoPath, worktreePath);
      }

      res.write("\n__RESULT__\n");
      res.write(
        JSON.stringify({
          ...summary,
          buildCwd,
          durationMs: Date.now() - startedAt,
          cleanedUp: true
        }) + "\n"
      );
      res.end();
    };

    try {
      const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "xcodebuild-worktree-"));
      worktreePath = path.join(tmpBase, "repo");

      res.write(`PREPARING_WORKTREE:${branch}\n`);

      await run("git", ["fetch", "--all", "--prune"], {
        cwd: repoPath,
        env: process.env,
      });

      await run("git", ["worktree", "add", "--force", worktreePath, branch], {
        cwd: repoPath,
        env: process.env,
      });

      buildCwd = subdir ? path.resolve(worktreePath, subdir) : worktreePath;
      const resolvedWorktreePath = path.resolve(worktreePath);
      if (buildCwd !== resolvedWorktreePath && !buildCwd.startsWith(`${resolvedWorktreePath}${path.sep}`)) {
        throw new Error("`subdir` must stay inside the checked-out worktree");
      }

      res.write(`WORKTREE_PATH:${worktreePath}\n`);
      res.write(`BUILD_CWD:${buildCwd}\n`);

      const child = spawn("xcodebuild", args, {
        cwd: buildCwd,
        env: {
          ...process.env,
          NSUnbufferedIO: "YES"
        },
      });

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        combined += text;
        stdoutStreamer.push(text);
      });

      child.stderr.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        combined += text;
        stderrStreamer.push(text);
      });

      child.on("error", async (err) => {
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
          !ok && extractedErrors.length === 0
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

server.listen(PORT, () => {
  console.log(`xcodebuild-runner listening on ${PORT}`);
});
