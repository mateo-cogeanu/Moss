import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "node:fs/promises";
const exec = promisify(execFile);
export const MOSS_REMOTE = "https://github.com/mateo-cogeanu/Moss.git";
export async function command(file, args, cwd, timeout = 120000) {
  const { stdout } = await exec(file, args, {
    cwd,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}
export async function checkUpdate(repo, run = command) {
  const git = (...args) => run("git", args, repo);
  if ((await git("branch", "--show-current")) !== "main")
    throw new Error("Automatic updates require the main branch.");
  if (await git("status", "--porcelain"))
    throw new Error(
      "Local changes found. Commit or move them before updating.",
    );
  const origin = await git("remote", "get-url", "origin");
  if (origin !== MOSS_REMOTE)
    throw new Error(
      "Automatic updates require the official Moss HTTPS origin.",
    );
  const previous = await git("rev-parse", "HEAD");
  await git("fetch", "--no-tags", "origin", "main");
  const target = await git("rev-parse", "FETCH_HEAD");
  if (previous === target) return { previous, target, available: false };
  await git("merge-base", "--is-ancestor", previous, target);
  let failed = false;
  const failureFile = path.resolve(
    repo,
    await git("rev-parse", "--git-path", "moss-update-failure.json"),
  );
  try {
    failed =
      JSON.parse(await fs.readFile(failureFile, "utf8")).target === target;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return { previous, target, available: true, failed };
}
export function createUpdater({
  repo,
  backend,
  enabled = false,
  service = "serverui.service",
  port = 3000,
  host = "127.0.0.1",
  intervalMs = 15 * 60 * 1000,
  run = command,
  platform = process.platform,
}) {
  const state = {
    enabled,
    manualAvailable: platform === "linux",
    status: enabled ? "waiting" : "disabled",
    message: enabled
      ? "Automatic updates enabled. First check in one minute."
      : "Automatic updates are disabled.",
    checkedAt: null,
    current: null,
    latest: null,
  };
  let timer,
    checking = false,
    stopped = false;
  function report(status, message) {
    state.status = status;
    state.message = message;
    console.log(`[Moss updates] ${message}`);
  }
  async function performCheck(manual) {
    let maintenance = false;
    try {
      if (platform !== "linux")
        throw new Error("Automatic updates require Linux with user systemd.");
      if (!/^[a-zA-Z0-9_-]+\.service$/.test(service))
        throw new Error("Invalid Moss service name.");
      report("checking", "Checking GitHub for a Moss update…");
      const owner = await run(
        "systemctl",
        ["--user", "show", service, "--property=MainPID", "--value"],
        repo,
      );
      if (owner !== String(process.pid))
        throw new Error(
          "Moss must run as the configured user systemd service.",
        );
      const update = await checkUpdate(repo, run);
      state.checkedAt = new Date().toISOString();
      state.current = update.previous.slice(0, 7);
      state.latest = update.target.slice(0, 7);
      if (stopped) return;
      if (!update.available) {
        report("current", "Moss is up to date.");
      } else if (update.failed && !manual) {
        state.status = "error";
        state.message =
          "The latest Moss update previously failed. Previous version restored if recovery succeeded; inspect the moss-update journal before retrying.";
      } else {
        if (manual) {
          report(
            "stopping",
            "Preparing update: waiting for active changes, then saving and stopping Minecraft servers…",
          );
          await backend.prepareUpdate();
          maintenance = true;
        } else {
          maintenance = backend.beginUpdate();
          if (!maintenance) {
            report(
              "pending",
              "Moss update available. Waiting for all Minecraft servers and active operations to stop.",
            );
            return;
          }
        }
        if (stopped) return;
        report(
          "installing",
          "Updating Moss. The panel will restart; sign in again afterward. Minecraft servers will remain stopped.",
        );
        try {
          await run(
            "systemd-run",
            [
              "--user",
              "--collect",
              "--wait",
              "--unit=moss-update",
              "--property=TimeoutStartSec=20min",
              "--service-type=exec",
              `--working-directory=${repo}`,
              process.execPath,
              path.join(repo, "scripts", "update-worker.mjs"),
              repo,
              update.previous,
              update.target,
              service,
              String(port),
              host,
            ],
            repo,
            21 * 60 * 1000,
          );
        } finally {
          if (maintenance) {
            backend.endUpdate();
            maintenance = false;
          }
        }
      }
    } catch (error) {
      state.status = "error";
      const detail = error.stderr?.trim() || error.message;
      state.message = `Moss update failed: ${detail.slice(-1500)}. See the user journal for details.`;
      console.error(state.message);
    } finally {
      if (maintenance) backend.endUpdate();
      checking = false;
      if (!stopped && enabled) timer = setTimeout(check, intervalMs).unref();
    }
  }
  async function check() {
    if (!enabled || checking || stopped) return;
    clearTimeout(timer);
    checking = true;
    await performCheck(false);
  }
  function requestUpdate() {
    if (platform !== "linux")
      throw Object.assign(
        new Error("Update now requires Linux with a user systemd service."),
        { status: 400 },
      );
    if (checking || stopped)
      throw Object.assign(
        new Error("An update check or shutdown is already in progress."),
        { status: 409 },
      );
    clearTimeout(timer);
    checking = true;
    state.status = "checking";
    state.message = "Checking GitHub for a Moss update…";
    // Allow the HTTP response to finish before maintenance blocks mutations.
    setImmediate(() => {
      if (stopped) {
        checking = false;
        return;
      }
      void performCheck(true);
    });
    return { ...state };
  }
  return {
    state,
    check,
    requestUpdate,
    start() {
      if (enabled) timer = setTimeout(check, 60000).unref();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
