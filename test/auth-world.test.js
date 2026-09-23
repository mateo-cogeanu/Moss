import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";
import { createBackend } from "../server/backend.js";
import { totp } from "../server/auth.js";
import { register } from "./auth-helper.js";
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "panel-auth-world-"));
  let backend,
    base,
    cookie = "";
  async function start() {
    backend = await createBackend({ dataDir: dir, token: "setup-key" });
    await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${backend.server.address().port}/api`;
  }
  await start();
  return {
    dir,
    get base() {
      return base;
    },
    set cookie(value) {
      cookie = value;
    },
    async call(
      route,
      body,
      status = 200,
      method = body === undefined ? "GET" : "POST",
    ) {
      const response = await fetch(base + route, {
        method,
        headers: { Cookie: cookie },
        body:
          body === undefined
            ? undefined
            : Buffer.isBuffer(body)
              ? body
              : JSON.stringify(body),
      });
      assert.equal(response.status, status, await response.clone().text());
      return response;
    },
    async restart() {
      await backend.close();
      await start();
    },
    async close() {
      await backend.close();
      await fs.rm(dir, { force: true, recursive: true });
    },
  };
}
test("TOTP matches RFC 6238 SHA-1 test vector", () => {
  assert.equal(totp("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 1), "287082");
});
test("account enrollment, mandatory 2FA, recovery reuse, password changes and persistence", async () => {
  const f = await fixture();
  try {
    await f.call(
      "/register/start",
      {
        username: "alice",
        password: "a long test password",
        adminKey: "wrong",
      },
      401,
    );
    await f.call(
      "/register/start",
      { username: "alice", password: "short", adminKey: "setup-key" },
      400,
    );
    const user = await register(f.base, "setup-key", "alice");
    f.cookie = user.cookie;
    assert.equal((await (await f.call("/session")).json()).username, "alice");
    await f.call("/logout", {});
    await f.call("/session", undefined, 401);
    await f.call("/login", { token: "setup-key" }, 401);
    await f.call(
      "/login",
      { username: "alice", password: "test password long enough" },
      401,
    );
    const login = await f.call("/login", {
      username: "ALICE",
      password: "test password long enough",
      code: totp(user.secret),
    });
    assert.match(login.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
    f.cookie = login.headers.get("set-cookie").split(";")[0];
    await f.call(
      "/login",
      {
        username: "alice",
        password: "test password long enough",
        code: totp(user.secret),
      },
      401,
    );
    const recovery = await f.call("/login", {
      username: "alice",
      password: "test password long enough",
      code: user.recoveryCodes[0],
    });
    const otherCookie = recovery.headers.get("set-cookie").split(";")[0];
    // Restart also proves one-time state is durable and sessions are invalidated.
    await f.restart();
    await f.call("/session", undefined, 401);
    await f.call(
      "/login",
      {
        username: "alice",
        password: "test password long enough",
        code: user.recoveryCodes[0],
      },
      401,
    );
    const next = await f.call("/login", {
      username: "alice",
      password: "test password long enough",
      code: user.recoveryCodes[1],
    });
    f.cookie = next.headers.get("set-cookie").split(";")[0];
    const second = await f.call("/login", {
      username: "alice",
      password: "test password long enough",
      code: user.recoveryCodes[2],
    });
    await f.call("/account/password", {
      password: "test password long enough",
      newPassword: "another strong test password",
      code: user.recoveryCodes[3],
    });
    f.cookie = second.headers.get("set-cookie").split(";")[0];
    await f.call("/session", undefined, 401);
    await f.call(
      "/login",
      {
        username: "alice",
        password: "test password long enough",
        code: user.recoveryCodes[4],
      },
      401,
    );
    await f.call("/login", {
      username: "alice",
      password: "another strong test password",
      code: user.recoveryCodes[4],
    });
    const stored = await fs.readFile(path.join(f.dir, "users.json"), "utf8");
    assert.ok(!stored.includes(user.secret));
    assert.ok(!stored.includes(user.recoveryCodes[0]));
    assert.ok(!stored.includes("another strong test password"));
    assert.equal(
      (await fs.stat(path.join(f.dir, "users.json"))).mode & 0o777,
      0o600,
    );
    assert.ok(otherCookie);
  } finally {
    await f.close();
  }
});
test("registration needs verified authenticator, rejects duplicate accounts and rate-limits attempts", async () => {
  const f = await fixture();
  try {
    const start = await (
      await f.call("/register/start", {
        username: "bob",
        password: "long password for bob",
        adminKey: "setup-key",
      })
    ).json();
    await f.call(
      "/register/finish",
      { enrollment: start.enrollment, code: "invalid" },
      401,
    );
    await f.call(
      "/login",
      {
        username: "bob",
        password: "long password for bob",
        code: totp(start.secret),
      },
      401,
    );
    const done = await f.call(
      "/register/finish",
      { enrollment: start.enrollment, code: totp(start.secret) },
      201,
    );
    f.cookie = done.headers.get("set-cookie").split(";")[0];
    await f.call(
      "/register/finish",
      { enrollment: start.enrollment, code: totp(start.secret) },
      400,
    );
    await f.call(
      "/register/start",
      {
        username: "BOB",
        password: "long password for bob",
        adminKey: "setup-key",
      },
      409,
    );
    for (let i = 0; i < 4; i++) await f.call("/login", {}, 401);
    await f.call("/login", {}, 429);
  } finally {
    await f.close();
  }
});
async function zip(files, options = {}) {
  const z = new JSZip();
  for (const [name, data] of Object.entries(files)) z.file(name, data, options);
  return z.generateAsync({ type: "nodebuffer", platform: "UNIX" });
}
test("world ZIP import supports wrapped/root worlds and rejects unsafe or ambiguous archives atomically", async () => {
  const f = await fixture();
  try {
    const body = {
      name: "Imported world",
      port: 25565,
      memory: 1024,
      eula: true,
    };
    const archive = await zip({
      "Survival/level.dat": "level fixture",
      "Survival/region/r.0.0.mca": "region fixture",
      "Survival/DIM-1/region/r.0.0.mca": "nether fixture",
    });
    await f.call("/world-imports", archive, 401, "PUT");
    f.cookie = (await register(f.base, "setup-key")).cookie;
    for (const invalid of [
      Buffer.from("not a ZIP"),
      await zip({ "readme.txt": "no world" }),
      await zip({ "a/level.dat": "one", "b/level.dat": "two" }),
      await zip({ "../outside.txt": "unsafe", "level.dat": "level" }),
      await zip(
        { "level.dat": "level", linked: "/etc/passwd" },
        { unixPermissions: 0o120777 },
      ),
      await zip({ "level.dat": "" }),
    ]) {
      await f.call("/world-imports", invalid, 400, "PUT");
      assert.deepEqual(await fs.readdir(path.join(f.dir, "world-imports")), []);
      assert.deepEqual(await (await f.call("/servers")).json(), []);
    }
    const imported = await (
      await f.call("/world-imports", archive, 201, "PUT")
    ).json();
    await f.call(
      "/servers",
      { ...body, port: 1, worldImport: imported.id },
      400,
    );
    const server = await (
      await f.call("/servers", { ...body, worldImport: imported.id }, 201)
    ).json();
    assert.equal(
      await fs.readFile(
        path.join(server.directory, "world/region/r.0.0.mca"),
        "utf8",
      ),
      "region fixture",
    );
    assert.equal(
      await fs.readFile(
        path.join(server.directory, "world/DIM-1/region/r.0.0.mca"),
        "utf8",
      ),
      "nether fixture",
    );
    assert.match(
      await fs.readFile(
        path.join(server.directory, "server.properties"),
        "utf8",
      ),
      /level-name=world/,
    );
    assert.deepEqual(await fs.readdir(path.join(f.dir, "world-imports")), []);
    await f.call(
      "/servers",
      { ...body, port: 25566, worldImport: imported.id },
      400,
    );
    const root = await (
      await f.call(
        "/world-imports",
        await zip({
          "level.dat": "root world",
          "region/r.0.0.mca": "root region",
        }),
        201,
        "PUT",
      )
    ).json();
    const firstCookie = (await register(f.base, "setup-key", "other")).cookie;
    f.cookie = firstCookie;
    await f.call(
      "/servers",
      { ...body, port: 25566, worldImport: root.id },
      400,
    );
    // A new root ZIP imported by the second account produces the same canonical world folder.
    f.cookie = firstCookie;
    const own = await (
      await f.call(
        "/world-imports",
        await zip({ "level.dat": "root world" }),
        201,
        "PUT",
      )
    ).json();
    const second = await (
      await f.call(
        "/servers",
        { ...body, port: 25566, worldImport: own.id },
        201,
      )
    ).json();
    assert.equal(
      await fs.readFile(path.join(second.directory, "world/level.dat"), "utf8"),
      "root world",
    );
  } finally {
    await f.close();
  }
});
