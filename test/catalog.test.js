import { register } from "./auth-helper.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createCatalog, allowedUrl, safeFilename } from "../server/catalog.js";
import { createBackend } from "../server/backend.js";
import { catalogFixture, jarBytes } from "./catalog-fixture.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
test("catalog validation, required dependencies, and corrupt downloads", async () => {
  const catalog = createCatalog(catalogFixture),
    s = { installation: { platform: "fabric", version: "1.21.11" } };
  assert.throws(() => allowedUrl("http://127.0.0.1/x"));
  assert.throws(() => allowedUrl("https://cdn.modrinth.com.evil.example/x"));
  assert.throws(() => safeFilename("../mod.jar"));
  const plan = await catalog.plan(s, "mod-v");
  assert.deepEqual(
    plan.map((v) => v.versionId),
    ["dep-v", "mod-v"],
  );
  assert.equal((await catalog.artifact("vanilla", "1.21.11", "")).java, 21);
  assert.match(
    (await catalog.artifact("fabric", "1.21.11", "0.19.5")).url,
    /server\/jar$/,
  );
  assert.ok((await catalog.artifact("paper", "1.21.11", "132")).hashes);
  await assert.rejects(() => catalog.artifact("fabric", "1.21.11", "bogus"));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-download-"));
  try {
    await assert.rejects(
      () =>
        catalog.download(
          {
            url: "https://cdn.modrinth.com/bad.jar",
            hashes: { sha1: "wrong" },
          },
          path.join(dir, "bad.jar"),
        ),
      /checksum/,
    );
    await assert.rejects(() => fs.stat(path.join(dir, "bad.jar")));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
test("install official software, select uploaded JAR, and manage mods through API", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-install-"));
  const backend = await createBackend({
    dataDir: dir,
    java: path.resolve("test/fake-java.js"),
    token: "test-token",
    fetcher: catalogFixture,
  });
  await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${backend.server.address().port}/api`;
  let cookie = "";
  async function call(p, method = "GET", body, status = 200) {
    const r = await fetch(base + p, {
      method,
      headers: { Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, status, await r.clone().text());
    return r;
  }
  try {
    cookie = (await register(base, "test-token")).cookie;
    const s = await (
        await call(
          "/servers",
          "POST",
          { name: "Install test", memory: 1024, port: 25565, eula: true },
          201,
        )
      ).json(),
      p = "/servers/" + s.id;
    await call(
      p + "/installation/install",
      "POST",
      { platform: "fabric", version: "1.21.11", loader: "0.19.5" },
      400,
    );
    const installed = await (
      await call(p + "/installation/install", "POST", {
        platform: "fabric",
        version: "1.21.11",
        loader: "0.19.5",
        confirm: true,
      })
    ).json();
    assert.equal(installed.installation.platform, "fabric");
    assert.deepEqual(
      await fs.readFile(path.join(s.directory, installed.jar)),
      jarBytes,
    );
    await call(p + "/content/install", "POST", {
      versionId: "mod-v",
      confirm: true,
    });
    const mods = await (await call(p + "/content")).json();
    assert.equal(mods.length, 2);
    await call(p + "/content/toggle", "POST", { path: "mods/mod-v.jar" });
    assert.equal(
      (await (await call(p + "/content")).json()).find(
        (m) => m.file_name === "mod-v.jar.disabled",
      ).enabled,
      false,
    );
    await call(p + "/content/toggle", "POST", { path: "../admin-token" }, 400);
    await call(
      p + "/installation/select",
      "POST",
      { jar: "../outside.jar", platform: "custom", version: "" },
      400,
    );
    await fs.writeFile(path.join(s.directory, "chosen.jar"), jarBytes);
    await call(p + "/installation/select", "POST", {
      jar: "chosen.jar",
      platform: "fabric",
      version: "1.21.11",
    });
    await call(p + "/power", "POST", { action: "start" });
    await call(
      p + "/installation/install",
      "POST",
      { platform: "vanilla", version: "1.21.11", confirm: true },
      409,
    );
    await call(p + "/content/toggle", "POST", { path: "mods/dep-v.jar" }, 409);
    await call(p + "/power", "POST", { action: "stop" });
    assert.equal(
      (await (await call(p + "/installation")).json()).jar,
      "chosen.jar",
    );
  } finally {
    await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
