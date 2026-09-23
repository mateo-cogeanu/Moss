import { register } from "./auth-helper.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createBackend } from "../server/backend.js";
test("authenticated lifecycle, file boundaries, uploads, backups, and persistence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-test-"));
  let backend;
  let cookie = "";
  try {
    backend = await createBackend({
      dataDir: dir,
      java: path.resolve("test/fake-java.js"),
      token: "integration-token",
      stopTimeout: 1000,
    });
    await new Promise((resolve) =>
      backend.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${backend.server.address().port}`;
    async function request(
      route,
      method = "GET",
      body,
      expected = 200,
      headers = {},
    ) {
      const r = await fetch(base + "/api" + route, {
        method,
        headers: { Cookie: cookie, ...headers },
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
      });
      assert.equal(r.status, expected, await r.clone().text());
      return r;
    }
    await request("/servers", "GET", undefined, 401);
    await request("/login", "POST", { token: "wrong" }, 401);
    cookie = (await register(base + "/api", "integration-token")).cookie;
    await request("/servers", "POST", {}, 403, {
      Origin: "https://evil.example",
    });
    await request(
      "/servers",
      "POST",
      { name: "Test", port: 25565, memory: 1024, eula: false },
      400,
    );
    const s = await (
      await request(
        "/servers",
        "POST",
        { name: "Test", port: 25565, memory: 1024, eula: true },
        201,
      )
    ).json();
    const prefix = "/servers/" + s.id;
    await request(
      "/servers",
      "POST",
      { name: "Duplicate port", port: 25565, memory: 1024, eula: true },
      400,
    );
    await request(
      prefix + "/files?path=" + encodeURIComponent("../admin-token"),
      "GET",
      undefined,
      400,
    );
    await fs.symlink(
      path.join(dir, "servers.json"),
      path.join(s.directory, "link"),
    );
    await request(prefix + "/files?path=link", "GET", undefined, 403);
    await request(
      prefix + "/files",
      "PUT",
      { path: "link", content: "overwrite" },
      403,
    );
    await request(prefix + "/backups", "POST", {}, 403);
    await fs.unlink(path.join(s.directory, "link"));
    await request(prefix + "/power", "POST", { action: "start" }, 404);
    await request(prefix + "/upload?path=server.jar", "PUT", "fake jar bytes");
    await request(prefix + "/files", "POST", {
      path: "test.txt",
      type: "file",
    });
    await request(prefix + "/files", "PUT", {
      path: "test.txt",
      content: "before",
    });
    const backup = await (
      await request(prefix + "/backups", "POST", { name: "Saved" }, 201)
    ).json();
    await request(prefix + "/files", "PUT", {
      path: "test.txt",
      content: "after",
    });
    await request(
      prefix + `/backups/${backup.id}/restore`,
      "POST",
      { confirm: false },
      400,
    );
    await request(prefix + `/backups/${backup.id}/restore`, "POST", {
      confirm: true,
    });
    assert.equal(
      (await (await request(prefix + "/files?path=test.txt")).json()).content,
      "before",
    );
    await request(prefix + "/files", "POST", {
      action: "rename",
      path: "test.txt",
      destination: "renamed.txt",
    });
    assert.equal(
      await (await request(prefix + "/download?path=renamed.txt")).text(),
      "before",
    );
    await request(prefix + "/power", "POST", { action: "start" });
    await request(prefix + "/power", "POST", { action: "start" }, 409);
    await request(
      prefix + "/files",
      "PUT",
      { path: "test.txt", content: "unsafe" },
      409,
    );
    await request(prefix + "/backups", "POST", {}, 409);
    await request(prefix + "/command", "POST", { command: "say hello" });
    await request(
      prefix + "/command",
      "POST",
      { command: "say hello\nstop" },
      400,
    );
    let snapshot;
    for (let i = 0; i < 30; i++) {
      snapshot = await (await request(prefix + "/snapshot")).json();
      if (snapshot.logs.some((l) => l.text.includes("say hello"))) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(snapshot.server.status, "running");
    assert.ok(snapshot.logs.some((l) => l.text.includes("say hello")));
    await request(prefix + "/power", "POST", { action: "restart" });
    await request(prefix + "/power", "POST", { action: "stop" });
    assert.equal((await (await request(prefix)).json()).status, "stopped");
    await request(prefix + "/settings", "PATCH", {
      name: "Renamed server",
      memory: 2048,
    });
    await request("/logout", "POST");
    await request("/servers", "GET", undefined, 401);
    await backend.close();
    backend = null;
    backend = await createBackend({ dataDir: dir, token: "integration-token" });
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dir, "servers.json")))[0].name,
      "Renamed server",
    );
  } finally {
    if (backend) await backend.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
