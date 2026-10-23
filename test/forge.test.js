import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createBackend } from "../server/backend.js";
import { createCatalog } from "../server/catalog.js";
import { installForge, runInstaller } from "../server/forge.js";
import { catalogFixture } from "./catalog-fixture.js";
import { register } from "./auth-helper.js";

test("Forge catalog validates builds, checksums and mod compatibility", async () => {
  const c = createCatalog(catalogFixture);
  assert.deepEqual(
    (await c.catalog("forge")).versions.map((v) => v.value),
    ["1.21.11"],
  );
  assert.equal(
    (await c.builds("forge", "1.21.11"))[1].label,
    "61.0.1 (recommended)",
  );
  await assert.rejects(c.artifact("forge", "1.12.2", "14.23.5.2860"));
  await assert.rejects(c.artifact("forge", "1.21.11", "../bad"));
  assert.equal((await c.artifact("forge", "1.21.11", "61.0.1")).forge, true);
  assert.equal(
    (
      await c.plan(
        { installation: { platform: "forge", version: "1.21.11" } },
        "mod-v",
      )
    ).length,
    2,
  );
  const corrupt = createCatalog(async (url) =>
    url.endsWith(".sha1") ? new Response("invalid") : catalogFixture(url),
  );
  await assert.rejects(
    corrupt.artifact("forge", "1.21.11", "61.0.1"),
    /checksum/,
  );
});
test("Forge install failure cleans staging and keeps existing world/runtime untouched", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss forge "));
  try {
    await fs.writeFile(path.join(directory, "world-marker"), "keep");
    const catalog = createCatalog(catalogFixture);
    const descriptor = await catalog.artifact("forge", "1.21.11", "61.0.1");
    for (const run of [
      async () => {
        throw new Error("installer failed");
      },
      async () => {},
      async (_java, _installer, cwd) => {
        await fs.symlink(directory, path.join(cwd, "escape"));
      },
    ]) {
      await assert.rejects(
        installForge({
          catalog,
          descriptor,
          directory,
          java: "java",
          log() {},
          run,
        }),
      );
      assert.deepEqual(await fs.readdir(directory), ["world-marker"]);
    }
    await assert.rejects(
      runInstaller(
        path.resolve("test/fake-java.js"),
        "unused",
        directory,
        () => {},
        10,
      ),
      /failed/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
test("Forge installs, starts through args with heap limits, preserves worlds and switches back to Vanilla", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss forge api "));
  let backend;
  try {
    async function start() {
      backend = await createBackend({
        dataDir: directory,
        java: path.resolve("test/fake-java.js"),
        token: "key",
        fetcher: catalogFixture,
      });
      await new Promise((resolve) =>
        backend.server.listen(0, "127.0.0.1", resolve),
      );
      return `http://127.0.0.1:${backend.server.address().port}/api`;
    }
    let base = await start();
    const user = await register(base, "key");
    let cookie = user.cookie;
    async function call(route, method = "GET", body, status = 200) {
      const response = await fetch(base + route, {
        method,
        headers: { Cookie: cookie },
        body: body ? JSON.stringify(body) : undefined,
      });
      assert.equal(response.status, status, await response.clone().text());
      return response.json();
    }
    const s = await call(
      "/servers",
      "POST",
      { name: "Forge test", memory: 2048, port: 25565, eula: true },
      201,
    );
    const root = path.join(directory, "servers", s.id),
      p = `/servers/${s.id}`;
    await fs.mkdir(path.join(root, "world"));
    await fs.writeFile(path.join(root, "world", "marker"), "existing world");
    const installed = await call(p + "/installation/install", "POST", {
      platform: "forge",
      version: "1.21.11",
      loader: "61.0.1",
      confirm: true,
    });
    const argsFile = installed.installation.launch.argsFile;
    const args = await fs.readFile(path.join(root, argsFile), "utf8");
    assert.match(
      args,
      /-DlibraryDirectory=forge-runtime-[a-f0-9-]+\/libraries/,
    );
    assert.match(args, /-p forge-runtime-[a-f0-9-]+\/libraries\/fixture.jar/);
    assert.equal(
      await fs.readFile(path.join(root, "world", "marker"), "utf8"),
      "existing world",
    );
    await backend.close();
    base = await start();
    const login = await fetch(base + "/login", {
      method: "POST",
      body: JSON.stringify({
        username: "tester",
        password: "test password long enough",
        code: user.recoveryCodes[0],
      }),
    });
    cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await call(p)).installation.launch.argsFile, argsFile);
    await call(p + "/power", "POST", { action: "start" });
    let snapshot;
    for (let i = 0; i < 30; i++) {
      snapshot = await call(p + "/snapshot");
      if (snapshot.logs.some((l) => l.text.includes("Java args"))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      snapshot.logs.some((l) =>
        l.text.includes(`-Xms1024M -Xmx2048M @${argsFile} nogui`),
      ),
    );
    await call(
      p + "/installation/install",
      "POST",
      {
        platform: "forge",
        version: "1.21.11",
        loader: "61.0.1",
        confirm: true,
      },
      409,
    );
    await call(p + "/power", "POST", { action: "stop" });
    const savedArgs = await fs.readFile(path.join(root, argsFile));
    await fs.rm(path.join(root, argsFile));
    await fs.symlink(
      path.join(root, "world", "marker"),
      path.join(root, argsFile),
    );
    await call(p + "/power", "POST", { action: "start" }, 403);
    await fs.rm(path.join(root, argsFile));
    await fs.writeFile(path.join(root, argsFile), savedArgs);
    await call(p + "/installation/install", "POST", {
      platform: "vanilla",
      version: "1.21.11",
      confirm: true,
    });
    assert.equal((await call(p)).installation.launch, undefined);
    await call(p + "/power", "POST", { action: "start" });
    await call(p + "/power", "POST", { action: "stop" });
  } finally {
    await backend?.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("recent Forge shim launchers publish identical shared libraries without overwriting conflicts", async () => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "moss-forge-shim-"),
  );
  try {
    const descriptor = { coordinate: "1.21.11-61.1.0" };
    const shim = `forge-${descriptor.coordinate}-shim.jar`;
    const options = {
      directory,
      descriptor,
      java: "java",
      log() {},
      catalog: { download: async (_d, p) => fs.writeFile(p, "installer") },
      run: async (_j, _i, cwd) => {
        const folder = path.join(
          cwd,
          "libraries/net/minecraftforge/forge",
          descriptor.coordinate,
        );
        await fs.mkdir(folder, { recursive: true });
        await fs.writeFile(
          path.join(folder, "unix_args.txt"),
          `-Djava.net.preferIPv6Addresses=system -jar ${shim}\n`,
        );
        await fs.writeFile(path.join(cwd, shim), "launcher");
        await fs.writeFile(
          path.join(cwd, "libraries", "library.jar"),
          "library",
        );
      },
    };
    const launch = await installForge(options);
    assert.equal(launch.sharedLibraries, true);
    assert.equal(launch.shim, shim);
    assert.equal(
      await fs.readFile(path.join(directory, shim), "utf8"),
      "launcher",
    );
    assert.match(
      await fs.readFile(path.join(directory, launch.argsFile), "utf8"),
      /-jar forge-1.21.11-61.1.0-shim.jar/,
    );
    await installForge(options);
    await fs.writeFile(
      path.join(directory, "libraries", "library.jar"),
      "existing custom file",
    );
    await assert.rejects(installForge(options), /differs/);
    assert.equal(
      await fs.readFile(
        path.join(directory, "libraries", "library.jar"),
        "utf8",
      ),
      "existing custom file",
    );
    await fs.rm(path.join(directory, "libraries"), { recursive: true });
    await fs.symlink(os.tmpdir(), path.join(directory, "libraries"));
    await assert.rejects(installForge(options), /link/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
