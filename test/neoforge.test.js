import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createCatalog } from "../server/catalog.js";
import { createBackend } from "../server/backend.js";
import { neoForgeVersions } from "../server/neoforge.js";
import { catalogFixture } from "./catalog-fixture.js";
import { register } from "./auth-helper.js";

test("NeoForge metadata maps legacy, zero-patch, beta and year-based versions accurately", () => {
  const xml = (values) =>
    `<metadata>${values.map((v) => `<version>${v}</version>`).join("")}</metadata>`;
  const builds = neoForgeVersions(
    xml([
      "20.2.3-beta",
      "20.6.1-beta",
      "21.0.167",
      "21.1.264",
      "21.11.48",
      "26.1.0.8-beta",
      "26.1.1.2-beta",
      "26.3.0.97",
      "26.1.0.0-alpha.1+snapshot-1",
      "../evil",
      "20.1.1",
    ]),
  );
  assert.deepEqual(
    new Set(builds.map((v) => v.minecraft)),
    new Set([
      "1.20.2",
      "1.20.6",
      "1.21",
      "1.21.1",
      "1.21.11",
      "26.1",
      "26.1.1",
      "26.3",
    ]),
  );
  assert.equal(builds.find((v) => v.id === "20.2.3-beta").stable, false);
  assert.equal(
    neoForgeVersions(xml(["1.20.1-47.1.106"]), true)[0].artifact,
    "forge",
  );
  assert.throws(() => neoForgeVersions("not xml"));
});
test("NeoForge catalogs select correct artifacts, verify SHA-256 and reject wrong game builds", async () => {
  const c = createCatalog(catalogFixture);
  assert.ok(
    (await c.catalog("neoforge")).versions.some((v) => v.value === "1.21.1"),
  );
  assert.equal((await c.builds("neoforge", "1.21.1"))[0].id, "21.1.264");
  const d = await c.artifact("neoforge", "1.21.1", "21.1.262");
  assert.match(
    d.url,
    /net\/neoforged\/neoforge\/21.1.262\/neoforge-21.1.262-installer.jar$/,
  );
  assert.equal(d.java, 21);
  assert.equal(d.hashes.sha256.length, 64);
  assert.match(
    (await c.artifact("neoforge", "1.20.1", "47.1.106")).url,
    /net\/neoforged\/forge\/1.20.1-47.1.106\/forge-/,
  );
  assert.equal(
    (await c.artifact("neoforge", "1.20.2", "20.2.3-beta")).java,
    17,
  );
  await assert.rejects(c.artifact("neoforge", "1.21.1", "21.0.167"), /build/);
  await assert.rejects(c.builds("neoforge", "1.19.4"), /version/);
  const corrupt = createCatalog(async (url) =>
    url.endsWith(".sha256") ? new Response("bad") : catalogFixture(url),
  );
  await assert.rejects(
    corrupt.artifact("neoforge", "1.21.1", "21.1.262"),
    /checksum/,
  );
});
test("NeoForge mod queries and dependency checks are restricted to neoforge and the selected game", async () => {
  const urls = [];
  const c = createCatalog(async (url) => {
    urls.push(url);
    return catalogFixture(url);
  });
  const s = { installation: { platform: "neoforge", version: "1.21.1" } };
  await c.search(s, "test");
  await c.versions(s, "testmod");
  assert.match(decodeURIComponent(urls[0]), /categories:neoforge/);
  assert.match(decodeURIComponent(urls[1]), /loaders=\["neoforge"\]/);
  assert.equal((await c.plan(s, "mod-v")).length, 2);
  const incompatible = createCatalog(async (url) => {
    const r = await catalogFixture(url);
    if (new URL(url).pathname.startsWith("/v2/version/"))
      return Response.json({ ...(await r.json()), loaders: ["forge"] });
    return r;
  });
  await assert.rejects(incompatible.plan(s, "mod-v"), /incompatible/);
});
test("NeoForge API installs release families, launches at the server root, and persists startup selection", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss neoforge "));
  let backend, base, cookie;
  async function start() {
    backend = await createBackend({
      dataDir: root,
      token: "key",
      java: path.resolve("test/fake-java.js"),
      fetcher: catalogFixture,
    });
    await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${backend.server.address().port}/api`;
  }
  const call = async (route, method = "GET", body, status = 200) => {
    const r = await fetch(base + route, {
      method,
      headers: { Cookie: cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(r.status, status, await r.clone().text());
    return r.json();
  };
  try {
    await start();
    const user = await register(base, "key");
    cookie = user.cookie;
    const s = await call(
      "/servers",
      "POST",
      { name: "NeoForge test", memory: 2048, port: 25565, eula: true },
      201,
    );
    const p = `/servers/${s.id}`,
      dir = path.join(root, "servers", s.id);
    await fs.mkdir(path.join(dir, "world"));
    await fs.writeFile(path.join(dir, "world", "marker"), "existing world");
    for (const [version, loader] of [
      ["1.20.1", "47.1.106"],
      ["1.20.2", "20.2.3-beta"],
      ["26.1.1", "26.1.1.2-beta"],
      ["26.3", "26.3.0.97"],
      ["1.21.1", "21.1.262"],
    ]) {
      const result = await call(p + "/installation/install", "POST", {
        platform: "neoforge",
        version,
        loader,
        confirm: true,
      });
      assert.equal(result.installation.launch.type, "neoforge-args");
      const args = await fs.readFile(
        path.join(dir, result.installation.launch.argsFile),
        "utf8",
      );
      assert.match(args, /-DlibraryDirectory=neoforge-runtime-/);
      assert.match(args, /-p neoforge-runtime-/);
    }
    const selected = (await call(p)).installation;
    await call(
      p + "/installation/install",
      "POST",
      {
        platform: "neoforge",
        version: "1.21.1",
        loader: "wrong",
        confirm: true,
      },
      400,
    );
    assert.deepEqual((await call(p)).installation, selected);
    await backend.close();
    await start();
    const login = await fetch(base + "/login", {
      method: "POST",
      body: JSON.stringify({
        username: "tester",
        password: "test password long enough",
        code: user.recoveryCodes[0],
      }),
    });
    cookie = login.headers.get("set-cookie").split(";")[0];
    assert.deepEqual((await call(p)).installation, selected);
    await call(p + "/power", "POST", { action: "start" });
    await call(
      p + "/installation/install",
      "POST",
      {
        platform: "neoforge",
        version: "1.21.1",
        loader: "21.1.262",
        confirm: true,
      },
      409,
    );
    let snapshot;
    for (let i = 0; i < 30; i++) {
      snapshot = await call(p + "/snapshot");
      if (snapshot.logs.some((l) => l.text.includes("Java args"))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(
      snapshot.logs.some((l) =>
        l.text.includes(
          `-Xms1024M -Xmx2048M @${selected.launch.argsFile} nogui`,
        ),
      ),
    );
    await call(p + "/power", "POST", { action: "stop" });
    assert.equal(
      await fs.readFile(path.join(dir, "world", "marker"), "utf8"),
      "existing world",
    );
    await call(p + "/installation/install", "POST", {
      platform: "forge",
      version: "1.21.11",
      loader: "61.0.1",
      confirm: true,
    });
    assert.equal((await call(p)).installation.launch.type, "forge-args");
    await call(p + "/power", "POST", { action: "start" });
    await call(p + "/power", "POST", { action: "stop" });
  } finally {
    await backend?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
