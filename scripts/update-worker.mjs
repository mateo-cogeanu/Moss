// Runs in a separate systemd unit so stopping Moss does not kill its updater.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { command, MOSS_REMOTE } from "../server/updates.js";

export async function applyUpdate({
  repo,
  previous,
  target,
  service,
  port,
  host,
  run = command,
  health = waitHealthy,
}) {
  if (
    ![previous, target].every((v) => /^[a-f0-9]{40}$/.test(v)) ||
    !/^[a-zA-Z0-9_-]+\.service$/.test(service)
  )
    throw new Error("Invalid update arguments.");
  const git = (...args) => run("git", args, repo);
  const systemctl = (...args) =>
    run("systemctl", ["--user", ...args, service], repo);
  if (
    (await git("branch", "--show-current")) !== "main" ||
    (await git("rev-parse", "HEAD")) !== previous ||
    (await git("status", "--porcelain")) ||
    (await git("remote", "get-url", "origin")) !== MOSS_REMOTE
  )
    throw new Error(
      "Checkout changed since the update check; refusing update.",
    );
  await git("merge-base", "--is-ancestor", previous, target);
  const failureFile = path.resolve(
    repo,
    await git("rev-parse", "--git-path", "moss-update-failure.json"),
  );
  // Sibling directory: never mixed with accounts, backups or worlds.
  const backup = await fs.mkdtemp(
    path.join(path.dirname(repo), ".moss-update-"),
  );
  const saved = [];
  let stopped = false,
    movedCode = false,
    restored = false;
  try {
    await systemctl("stop");
    stopped = true;
    for (const name of ["node_modules", "dist"]) {
      try {
        await fs.rename(path.join(repo, name), path.join(backup, name));
        saved.push(name);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    await git("merge", "--ff-only", target);
    movedCode = true;
    await run("npm", ["ci"], repo, 10 * 60 * 1000);
    await run("npm", ["run", "build"], repo, 5 * 60 * 1000);
    await systemctl("start");
    await health({ host, port, run, repo, service });
    await fs.rm(failureFile, { force: true });
    console.log(
      `Moss updated to ${target.slice(0, 7)} and restarted successfully.`,
    );
    restored = true;
  } catch (error) {
    await fs
      .writeFile(
        failureFile,
        JSON.stringify({ target, date: new Date().toISOString() }),
      )
      .catch((error) =>
        console.error("Could not record failed revision:", error.message),
      );
    console.error(
      "Moss update failed; restoring the previous code, dependencies and build:",
      error.message,
    );
    if (stopped) {
      await systemctl("stop");
      if (movedCode) await git("reset", "--keep", previous);
      for (const name of ["node_modules", "dist"]) {
        if (saved.includes(name)) {
          await fs.rm(path.join(repo, name), { recursive: true, force: true });
          await fs.rename(path.join(backup, name), path.join(repo, name));
        }
      }
      await systemctl("start");
      await health({ host, port, run, repo, service });
    }
    restored = true;
    throw error;
  } finally {
    if (restored || !stopped)
      await fs.rm(backup, { recursive: true, force: true });
    else
      console.error(
        `Recovery files retained at ${backup}. Inspect before retrying.`,
      );
  }
}
async function waitHealthy({ host, port, run, repo, service }) {
  const address =
    host === "0.0.0.0"
      ? "127.0.0.1"
      : host === "::"
        ? "[::1]"
        : host.includes(":")
          ? `[${host}]`
          : host;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await run("systemctl", ["--user", "is-active", "--quiet", service], repo);
      const response = await fetch(`http://${address}:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok && (await response.json()).application === "Moss") return;
    } catch {
      /* Startup can take a moment. */
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("Moss failed its startup health check.");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [repo, previous, target, service, port, host] = process.argv.slice(2);
  applyUpdate({ repo, previous, target, service, port, host }).catch(
    (error) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
