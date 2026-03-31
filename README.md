# xcodebuild-runner

Small HTTP runner for executing `xcodebuild` on a macOS host from an agent or container.

This is useful when the agent itself runs in Linux or Docker, but the actual iOS build must happen on the host with Xcode installed.

## What it does

- Accepts a `POST /xcodebuild` request.
- Runs `git fetch --all --prune` in the target repository.
- Creates a temporary git worktree for the requested branch.
- Runs `xcodebuild` in that worktree.
- Streams important lines back to the client:
  - `PREPARING_WORKTREE:...`
  - `WORKTREE_PATH:...`
  - `BUILD_CWD:...`
  - `BUILD_STARTED`
  - `XCODEBUILD_PID:...`
  - `BUILD_HEARTBEAT:elapsedMs=...` during long silent compile phases
  - compiler / build errors
  - `BUILD SUCCEEDED` or `BUILD FAILED`
- Ends with a machine-readable JSON block after `__RESULT__`.
- Removes the temporary worktree on completion.
- Keeps the HTTP request open for long-running builds instead of timing out.
- Returns a final failure summary even when `xcodebuild` fails without clean compiler-style `error:` lines.

## Requirements

- macOS host
- Xcode and `xcodebuild` installed
- git installed
- the target repository already cloned on disk
- the requested branch available locally or fetchable from the repo remote
- default port `48173` unless overridden with `PORT`
- logs are written to `./logs` by default unless overridden with `LOG_DIR`

## API

### Request

`POST /xcodebuild`

Content type: `application/json`

Body:

```json
{
  "repoPath": "/absolute/path/to/repo",
  "branch": "feature/some-branch",
  "subdir": "",
  "args": [
    "-scheme", "MyApp",
    "-project", "MyApp.xcodeproj",
    "-destination", "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.0",
    "build"
  ]
}
```

Fields:

- `repoPath`: absolute path to the git repository on the macOS host
- `branch`: branch to check out in a temporary worktree
- `subdir`: optional relative subdirectory inside the repo where `xcodebuild` should run
- `args`: raw `xcodebuild` arguments as an array of strings

### Response

The response is streamed as plain text. The final section always looks like:

```text
__RESULT__
{"ok":true,"exitCode":0,...}
```

Useful summary fields:

- `ok`
- `exitCode`
- `signal`
- `errors`
- `logTail`
- `buildCwd`
- `durationMs`

For failures, the JSON contains extracted error lines and falls back to a useful log tail when explicit error lines are missing.

Useful streamed markers before `__RESULT__`:

- `PREPARING_WORKTREE:<branch>`
- `WORKTREE_PATH:<path>`
- `BUILD_CWD:<path>`
- `BUILD_STARTED`
- `XCODEBUILD_PID:<pid>`
- `BUILD_HEARTBEAT:elapsedMs=<ms>`

## Logging

The runner now logs locally in two places:

- Terminal/stdout: request lifecycle, worktree setup, build start, heartbeats, important build errors, and final status.
- Files under `logs/` by default:
  - `logs/xcodebuild-runner.log`: server-level log stream
  - `logs/build-<timestamp>-<branch>-<requestId>.log`: full output for a single build, including raw `xcodebuild` output

You can override the directory with `LOG_DIR=/absolute/path/to/logs`.

Useful watch commands:

```bash
tail -f logs/xcodebuild-runner.log
```

```bash
tail -f logs/build-*.log
```

When a build finishes, the final JSON summary now includes:

- `requestId`
- `buildLogPath`

## Example

From a container talking to the macOS host:

```bash
curl -N http://host.docker.internal:48173/xcodebuild \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "/Users/you/Repositories/MyApp-iOS",
    "branch": "feature/my-change",
    "subdir": "",
    "args": [
      "-scheme", "MyApp",
      "-workspace", "MyApp.xcworkspace",
      "-destination", "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.0",
      "build"
    ]
  }'
```

From the host itself:

```bash
curl -N http://localhost:48173/xcodebuild \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "repoPath": "/Users/you/Repositories/MyApp-iOS",
    "branch": "feature/my-change",
    "subdir": "",
    "args": [
      "-scheme", "MyApp",
      "-workspace", "MyApp.xcworkspace",
      "-destination", "platform=iOS Simulator,name=iPhone 17 Pro,OS=26.0",
      "build"
    ]
  }'
```

## Agent Prompt

Use this as a copy-paste prompt when sharing the tool with other agents:

```text
You can trigger iOS builds through a host-side xcodebuild runner.

Endpoint:
- POST http://host.docker.internal:48173/xcodebuild

Request JSON:
- repoPath: absolute macOS path to the repository
- branch: branch to build
- subdir: optional relative subdirectory inside the repo
- args: array of raw xcodebuild arguments

Behavior:
- The service fetches remotes, creates a temporary git worktree for the branch, runs xcodebuild there, streams notable build lines, and removes the worktree afterward.
- It emits `BUILD_STARTED` when the `xcodebuild` process has been spawned successfully.
- It emits `BUILD_HEARTBEAT` every ~30 seconds during silent compile phases so clients can distinguish “still running” from “hung”.
- The response is plain text and ends with:
  __RESULT__
  { ...json summary... }
- The final JSON is the source of truth for success or failure.

How you should use it:
1. Choose the exact branch to validate.
2. Pass xcodebuild arguments explicitly, including project/workspace, scheme, destination, and action.
3. Wait for the final __RESULT__ JSON.
4. Treat ok=false, BUILD FAILED, non-zero exitCode, a non-null signal, or extracted errors as a failed build.
5. Summarize the result for the user, including the important errors from the JSON summary and the log tail when needed.

Do not assume defaults for scheme, workspace, destination, or configuration unless the repository clearly defines them.
```

## Notes

- This service currently has no authentication layer. Keep it bound to trusted local networking.
- It is intentionally narrow: it only runs `xcodebuild` and reports a compact streamed summary.
- If you split this into its own repository, this README is enough for another agent or developer to understand the contract without reading the source first.
