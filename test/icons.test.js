import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { createBackend } from "../server/backend.js";
import { register } from "./auth-helper.js";
test("icons require authentication, validate images, normalize and survive restart", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-icons-"));
  let backend, base;
  async function start() {
    backend = await createBackend({ dataDir: dir, token: "test-key" });
    await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${backend.server.address().port}/api`;
  }
  try {
    await start();
    let user = await register(base, "test-key");
    const request = (route, method = "GET", body) =>
      fetch(base + route, { method, headers: { Cookie: user.cookie }, body });
    const s = await (
      await request(
        "/servers",
        "POST",
        JSON.stringify({
          name: "Icon server",
          port: 25565,
          memory: 1024,
          eula: true,
        }),
      )
    ).json();
    const route = `/servers/${s.id}/icon`;
    assert.equal((await fetch(base + route)).status, 401);
    assert.equal((await request(route)).status, 404);
    const bytes = await sharp({
      create: { width: 300, height: 180, channels: 3, background: "#16a34a" },
    })
      .jpeg()
      .toBuffer();
    const uploaded = await request(route, "PUT", bytes);
    assert.equal(uploaded.status, 200);
    let revision = (await uploaded.json()).iconRevision;
    const minecraftPath = path.join(dir, "servers", s.id, "server-icon.png");
    let minecraftIcon = await fs.readFile(minecraftPath);
    const gameMeta = await sharp(minecraftIcon).metadata();
    assert.equal(gameMeta.format, "png");
    assert.equal(gameMeta.width, 64);
    assert.equal(gameMeta.height, 64);
    for (const invalid of [
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      Buffer.from("not an image"),
    ])
      assert.equal((await request(route, "PUT", invalid)).status, 400);
    assert.equal(
      (await request(route, "PUT", Buffer.alloc(5 * 1024 * 1024 + 1))).status,
      413,
    );
    const image = await request(route);
    assert.equal(image.headers.get("content-type"), "image/png");
    const meta = await sharp(Buffer.from(await image.arrayBuffer())).metadata();
    assert.equal(meta.width, 256);
    assert.equal(meta.height, 256);
    assert.deepEqual(await fs.readFile(minecraftPath), minecraftIcon);
    const replacement = await sharp({
      create: { width: 90, height: 140, channels: 3, background: "#ff0000" },
    })
      .png()
      .toBuffer();
    const replaced = await request(route, "PUT", replacement);
    assert.equal(replaced.status, 200);
    const nextRevision = (await replaced.json()).iconRevision;
    assert.notEqual(nextRevision, revision);
    revision = nextRevision;
    assert.notDeepEqual(await fs.readFile(minecraftPath), minecraftIcon);
    minecraftIcon = await fs.readFile(minecraftPath);
    const panelIcon = Buffer.from(await (await request(route)).arrayBuffer());
    const outside = path.join(dir, "untouched.png");
    await fs.writeFile(outside, "untouched");
    await fs.rm(minecraftPath);
    await fs.symlink(outside, minecraftPath);
    assert.equal((await request(route, "PUT", bytes)).status, 403);
    assert.equal(await fs.readFile(outside, "utf8"), "untouched");
    assert.deepEqual(
      Buffer.from(await (await request(route)).arrayBuffer()),
      panelIcon,
    );
    await fs.rm(minecraftPath);
    await fs.mkdir(minecraftPath);
    assert.equal((await request(route, "PUT", bytes)).status, 400);
    assert.deepEqual(
      Buffer.from(await (await request(route)).arrayBuffer()),
      panelIcon,
    );
    await fs.rmdir(minecraftPath);
    await fs.writeFile(minecraftPath, minecraftIcon);
    assert.equal(
      (await fs.readdir(path.dirname(minecraftPath))).some((name) =>
        name.endsWith(".tmp"),
      ),
      false,
    );
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
    user.cookie = login.headers.get("set-cookie").split(";")[0];
    assert.equal((await request(route)).status, 200);
    assert.deepEqual(await fs.readFile(minecraftPath), minecraftIcon);
    assert.equal(
      (await (await request(`/servers/${s.id}`)).json()).iconRevision,
      revision,
    );
  } finally {
    if (backend) await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
