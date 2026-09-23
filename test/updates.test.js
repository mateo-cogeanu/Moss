import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createUpdater, checkUpdate, MOSS_REMOTE } from "../server/updates.js";
import { applyUpdate } from "../scripts/update-worker.mjs";
import { createBackend } from "../server/backend.js";
import { register } from "./auth-helper.js";
const previous = "a".repeat(40),
  target = "b".repeat(40);
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-updater-"));
  const repo = path.join(root, "repo");
  await fs.mkdir(path.join(repo, ".git"), { recursive: true });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const calls = [];
  const run = async (file, args) => {
    const cmd = [file, ...args].join(" ");
    calls.push(cmd);
    if (cmd.includes("--property=MainPID")) return String(process.pid);
    if (cmd === "git branch --show-current") return options.branch || "main";
    if (cmd === "git status --porcelain")
      return options.dirty ? " M README.md" : "";
    if (cmd === "git remote get-url origin")
      return options.remote || MOSS_REMOTE;
    if (cmd === "git rev-parse HEAD") return previous;
    if (cmd === "git rev-parse FETCH_HEAD")
      return options.current ? previous : target;
    if (cmd === "git rev-parse --git-path moss-update-failure.json")
      return ".git/moss-update-failure.json";
    if (cmd.startsWith("git merge-base") && options.diverged)
      throw new Error("Diverged history");
    if (file === "systemd-run" && options.launchError)
      throw new Error("No systemd user session");
    if (file === "npm") {
      const name = args[0] === "ci" ? "node_modules" : "dist";
      await fs.mkdir(path.join(repo, name), { recursive: true });
      await fs.writeFile(path.join(repo, name, "marker"), "new");
      if (options.fail === args.at(-1)) throw new Error("Simulated failure");
    }
    return "";
  };
  return { repo, run, calls };
}
test("updates require a clean official main checkout and fast-forward history", async (t) => {
  for (const options of [
    { branch: "other" },
    { dirty: true },
    { remote: "https://example.org/repo" },
    { diverged: true },
  ]) {
    const f = await fixture(t, options);
    await assert.rejects(checkUpdate(f.repo, f.run));
    assert.ok(
      !f.calls.some((c) => c.startsWith("npm") || c.startsWith("systemctl")),
    );
  }
  const f = await fixture(t, { current: true });
  assert.equal((await checkUpdate(f.repo, f.run)).available, false);
});
test("updater defers while busy and releases maintenance on launcher failure", async (t) => {
  const f = await fixture(t, { launchError: true });
  let idle = false,
    released = 0;
  const updater = createUpdater({
    ...f,
    enabled: true,
    platform: "linux",
    backend: {
      beginUpdate: () => idle,
      endUpdate: () => released++,
    },
  });
  t.after(() => updater.stop());
  await updater.check();
  assert.equal(updater.state.status, "pending");
  assert.ok(!f.calls.some((c) => c.startsWith("systemd-run")));
  idle = true;
  await updater.check();
  assert.equal(updater.state.status, "error");
  assert.equal(released, 1);
});
test("worker replaces the build and restarts Moss; failures restore dependencies and build", async (t) => {
  for (const fail of [null, "ci", "build", "health"]) {
    const f = await fixture(t, { fail });
    for (const name of ["node_modules", "dist", "panel-data"]) {
      await fs.mkdir(path.join(f.repo, name));
      await fs.writeFile(path.join(f.repo, name, "marker"), "old");
    }
    let healthChecks = 0;
    const work = () =>
      applyUpdate({
        ...f,
        previous,
        target,
        service: "serverui.service",
        port: 3000,
        host: "127.0.0.1",
        health: async () => {
          if (++healthChecks === 1 && fail === "health")
            throw new Error("Unhealthy build");
        },
      });
    if (fail) await assert.rejects(work());
    else await work();
    for (const name of ["node_modules", "dist"])
      assert.equal(
        await fs.readFile(path.join(f.repo, name, "marker"), "utf8"),
        fail ? "old" : "new",
      );
    assert.equal(
      await fs.readFile(path.join(f.repo, "panel-data", "marker"), "utf8"),
      "old",
    );
    assert.ok(
      f.calls.indexOf("systemctl --user stop serverui.service") <
        f.calls.indexOf("npm ci"),
    );
    assert.ok(f.calls.includes("systemctl --user start serverui.service"));
    if (fail) {
      assert.ok(f.calls.includes(`git reset --keep ${previous}`));
      assert.equal((await checkUpdate(f.repo, f.run)).failed, true);
    }
  }
});
test("maintenance admission blocks mutations and requires completed requests", async (t) => {
  const f = await fixture(t);
  const backend = await createBackend({
    dataDir: path.join(f.repo, "panel-data"),
    token: "test-key",
  });
  await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
  t.after(() => backend.close());
  const base = `http://127.0.0.1:${backend.server.address().port}/api`;
  assert.equal((await fetch(base + "/updates")).status, 401);
  const user = await register(base, "test-key");
  const admitted = new Promise((resolve) =>
    backend.server.once("request", () => setImmediate(resolve)),
  );
  let upload;
  const responseDone = new Promise((resolve, reject) => {
    upload = http.request(
      base + "/servers",
      {
        method: "POST",
        headers: { Cookie: user.cookie, "Content-Length": "2" },
      },
      (response) => {
        response.resume();
        response.on("end", resolve);
      },
    );
    upload.on("error", reject);
    upload.write("{");
  });
  await admitted;
  assert.equal(backend.beginUpdate(), false);
  upload.end("}");
  await responseDone;
  assert.equal(backend.beginUpdate(), true);
  assert.equal(backend.beginUpdate(), false);
  const response = await fetch(base + "/servers", {
    method: "POST",
    headers: { Cookie: user.cookie },
    body: "{}",
  });
  assert.equal(response.status, 503);
  assert.equal(
    (await (await fetch(base + "/health")).json()).application,
    "Moss",
  );
  backend.endUpdate();
  assert.equal(
    (await fetch(base + "/updates", { headers: { Cookie: user.cookie } }))
      .status,
    200,
  );
});
