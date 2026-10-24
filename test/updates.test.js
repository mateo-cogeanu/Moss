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
      if (options.fail === args.at(-1) || options.fail === args[0])
        throw new Error("Simulated failure");
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
        f.calls.indexOf("npm ci --include=dev"),
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

async function waitForStatus(updater, expected) {
  for (let i = 0; i < 200; i++) {
    if (updater.state.status === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(updater.state.status, expected, updater.state.message);
}
test("Update now works with automatic checks disabled and leaves current or dirty installs running", async (t) => {
  for (const options of [{ current: true }, { dirty: true }]) {
    const f = await fixture(t, options);
    let prepared = 0;
    const updater = createUpdater({
      ...f,
      platform: "linux",
      backend: {
        prepareUpdate() {
          prepared++;
        },
        endUpdate() {},
      },
    });
    t.after(() => updater.stop());
    assert.equal(updater.state.manualAvailable, true);
    assert.equal(updater.requestUpdate().status, "checking");
    assert.throws(() => updater.requestUpdate(), { status: 409 });
    await waitForStatus(updater, options.current ? "current" : "error");
    assert.equal(prepared, 0);
    assert.ok(!f.calls.some((c) => c.startsWith("systemd-run")));
  }
});
test("Update now retries a failed revision only on explicit request, after graceful preparation", async (t) => {
  const f = await fixture(t, { launchError: true });
  await fs.writeFile(
    path.join(f.repo, ".git/moss-update-failure.json"),
    JSON.stringify({ target }),
  );
  let prepared = 0,
    released = 0;
  const updater = createUpdater({
    ...f,
    platform: "linux",
    enabled: true,
    backend: {
      async prepareUpdate() {
        prepared++;
      },
      beginUpdate() {
        assert.fail("automatic retry must remain suppressed");
      },
      endUpdate() {
        released++;
      },
    },
  });
  t.after(() => updater.stop());
  await updater.check();
  assert.equal(updater.state.status, "error");
  assert.equal(prepared, 0);
  updater.requestUpdate();
  await waitForStatus(updater, "error");
  assert.equal(prepared, 1);
  assert.equal(released, 1);
});
test("authenticated manual update stops Minecraft cleanly before worker launch and releases maintenance on failure", async (t) => {
  const f = await fixture(t);
  let updater;
  const backend = await createBackend({
    dataDir: path.join(f.repo, "panel-data"),
    token: "key",
    java: path.resolve("test/fake-java.js"),
    updateStatus: () => updater.state,
    updateNow: () => updater.requestUpdate(),
  });
  await new Promise((resolve) =>
    backend.server.listen(0, "127.0.0.1", resolve),
  );
  const base = `http://127.0.0.1:${backend.server.address().port}/api`;
  let cookie = "",
    launches = 0;
  const request = (route, method = "GET", body, headers = {}) =>
    fetch(base + route, {
      method,
      headers: { Cookie: cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  updater = createUpdater({
    repo: f.repo,
    backend,
    platform: "linux",
    run: async (file, args, ...rest) => {
      if (file === "systemd-run") {
        launches++;
        const servers = await (await request("/servers")).json();
        assert.ok(servers.every((s) => s.status === "stopped"));
        assert.equal((await request("/servers", "POST", {})).status, 503);
        throw new Error("Simulated worker launch failure");
      }
      return f.run(file, args, ...rest);
    },
  });
  t.after(async () => {
    updater.stop();
    await backend.close();
  });
  assert.equal(
    (await request("/updates", "POST", { confirm: true })).status,
    401,
  );
  cookie = (await register(base, "key")).cookie;
  assert.equal((await request("/updates", "POST", {})).status, 400);
  assert.equal(
    (
      await request(
        "/updates",
        "POST",
        { confirm: true },
        { Origin: "https://untrusted.invalid" },
      )
    ).status,
    403,
  );
  for (const port of [25565, 25566]) {
    const s = await (
      await request("/servers", "POST", {
        name: "Update test",
        memory: 1024,
        port,
        eula: true,
      })
    ).json();
    await fs.writeFile(
      path.join(backend.root, "servers", s.id, "server.jar"),
      "fixture",
    );
    await request(`/servers/${s.id}/power`, "POST", { action: "start" });
  }
  const response = await request("/updates", "POST", { confirm: true });
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "checking");
  await waitForStatus(updater, "error");
  assert.equal(launches, 1);
  assert.equal((await request("/servers", "POST", {})).status, 400);
});
test("manual preparation drains active uploads and cancels safely if a Minecraft process refuses to stop", async (t) => {
  const f = await fixture(t);
  const stubbornJava = path.join(f.repo, "stubborn-java");
  await fs.writeFile(
    stubbornJava,
    `#!${process.execPath}\nprocess.stdin.resume();\nsetInterval(() => {}, 1000);\n`,
    { mode: 0o755 },
  );
  const backend = await createBackend({
    dataDir: path.join(f.repo, "panel-data"),
    token: "key",
    java: stubbornJava,
    stopTimeout: 100,
    updateDrainTimeout: 100,
  });
  await new Promise((resolve) =>
    backend.server.listen(0, "127.0.0.1", resolve),
  );
  t.after(() => backend.close());
  const base = `http://127.0.0.1:${backend.server.address().port}/api`;
  const user = await register(base, "key");
  const admitted = new Promise((resolve) =>
    backend.server.once("request", () => setImmediate(resolve)),
  );
  let upload;
  const done = new Promise((resolve, reject) => {
    upload = http.request(
      base + "/servers",
      { method: "POST", headers: { Cookie: user.cookie, "Content-Length": 2 } },
      (r) => {
        r.resume();
        r.on("end", resolve);
      },
    );
    upload.on("error", reject);
    upload.write("{");
  });
  await admitted;
  await assert.rejects(
    backend.prepareUpdate(),
    /Active changes have not finished/,
  );
  upload.end("}");
  await done;
  const response = await fetch(base + "/servers", {
    method: "POST",
    headers: { Cookie: user.cookie },
    body: JSON.stringify({
      name: "Stubborn",
      memory: 1024,
      port: 25565,
      eula: true,
    }),
  });
  const s = await response.json();
  await fs.writeFile(
    path.join(backend.root, "servers", s.id, "server.jar"),
    "fixture",
  );
  await fetch(base + `/servers/${s.id}/power`, {
    method: "POST",
    headers: { Cookie: user.cookie },
    body: JSON.stringify({ action: "start" }),
  });
  await assert.rejects(backend.prepareUpdate(), /did not stop cleanly/);
  const state = await (
    await fetch(base + `/servers/${s.id}`, { headers: { Cookie: user.cookie } })
  ).json();
  assert.ok(state.pid, "the updater must not force-kill the game");
  backend.endUpdate();
});
