import { createCatalog, safeFilename } from "./catalog.js";
import http from "node:http";
import { normalizeIcon } from "./icons.js";
import { createAuth } from "./auth.js";
import { extractWorld, MAX_ZIP } from "./world-import.js";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const fail = (status, message) => Object.assign(new Error(message), { status });
const ID = /^[a-zA-Z0-9-]{1,80}$/;
export async function createBackend({
  dataDir = "./panel-data",
  java = "java",
  stopTimeout = 30000,
  staticDir = "./dist",
  token: configuredToken,
  fetcher = fetch,
} = {}) {
  const catalog = createCatalog(fetcher);
  const root = path.resolve(dataDir),
    dist = path.resolve(staticDir);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, "panel.lock");
  try {
    await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const pid = Number(await fs.readFile(lock, "utf8"));
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("Another panel owns this data directory.");
    await fs.unlink(lock);
    await fs.writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  const tokenFile = path.join(root, "admin-token");
  let token = configuredToken;
  if (!token) {
    try {
      token = await fs.readFile(tokenFile, "utf8");
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
      token = crypto.randomBytes(32).toString("hex");
      await fs.writeFile(tokenFile, token, { mode: 0o600 });
    }
  }
  const auth = await createAuth(root, token);
  const importsDir = path.join(root, "world-imports");
  await fs.rm(importsDir, { recursive: true, force: true });
  await fs.mkdir(importsDir, { recursive: true, mode: 0o700 });
  const worldImports = new Map();
  let records = [];
  try {
    records = JSON.parse(
      await fs.readFile(path.join(root, "servers.json"), "utf8"),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const runtime = new Map(),
    locks = new Map();
  let saveQueue = Promise.resolve(),
    closing = false;
  async function save() {
    const content = JSON.stringify(records, null, 2);
    saveQueue = saveQueue.then(async () => {
      await fs.writeFile(path.join(root, "servers.json.tmp"), content, {
        mode: 0o600,
      });
      await fs.rename(
        path.join(root, "servers.json.tmp"),
        path.join(root, "servers.json"),
      );
    });
    return saveQueue;
  }
  async function exclusive(id, fn) {
    if (locks.has(id)) throw fail(409, "Another operation is in progress.");
    locks.set(id, true);
    try {
      return await fn();
    } finally {
      locks.delete(id);
    }
  }
  const directory = (s) => path.join(root, "servers", s.id);
  function info(s) {
    const r = runtime.get(s.id);
    return {
      ...s,
      status: r?.child ? (r.stopping ? "stopping" : "running") : "stopped",
      pid: r?.child?.pid ?? null,
      uptime: r?.child ? Math.floor((Date.now() - r.started) / 1000) : 0,
      directory: directory(s),
      exitCode: r?.exitCode ?? null,
    };
  }
  function log(id, text) {
    let r = runtime.get(id);
    if (!r) {
      r = { logs: [] };
      runtime.set(id, r);
    }
    r.logs.push({
      seq: (r.seq = (r.seq || 0) + 1),
      text,
      level: /\b(ERROR|FATAL)\b/.test(text)
        ? "error"
        : /\bWARN\b/.test(text)
          ? "warn"
          : "info",
    });
    if (r.logs.length > 2000) r.logs.splice(0, r.logs.length - 2000);
  }
  async function safe(s, relative = "", missing = false) {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      relative.includes("\\")
    )
      throw fail(400, "Invalid file path.");
    const parts = relative.replace(/^\/+/, "").split("/").filter(Boolean);
    if (parts.some((p) => p === ".." || p === "." || p.includes(":")))
      throw fail(400, "Invalid file path.");
    let out = directory(s);
    for (let i = -1; i < parts.length; i++) {
      if (i >= 0) out = path.join(out, parts[i]);
      try {
        const st = await fs.lstat(out);
        if (st.isSymbolicLink())
          throw fail(403, "Symbolic links are not supported.");
      } catch (e) {
        if (e.code === "ENOENT" && missing && i === parts.length - 1)
          return out;
        throw e;
      }
    }
    return out;
  }
  async function tree(p) {
    for (const d of await fs.readdir(p, { withFileTypes: true })) {
      if (d.isSymbolicLink())
        throw fail(403, "Remove symbolic links before backing up.");
      if (d.isDirectory()) await tree(path.join(p, d.name));
    }
  }
  function stopped(s) {
    if (runtime.get(s.id)?.child)
      throw fail(409, "Stop the server before changing its files or backups.");
  }
  async function start(s) {
    if (closing) throw fail(503, "Panel is shutting down.");
    if (runtime.get(s.id)?.child) throw fail(409, "Server is already running.");
    const jar = s.jar || "server.jar";
    await safe(s, jar);
    if (!(await fs.stat(path.join(directory(s), jar))).isFile())
      throw fail(400, "Selected JAR must be a regular file.");
    const eula = await fs.readFile(await safe(s, "eula.txt"), "utf8");
    if (!/^eula=true\s*$/m.test(eula))
      throw fail(400, "Accept the Minecraft EULA before starting.");
    const child = spawn(
      java,
      [
        `-Xms${Math.min(s.memory, 1024)}M`,
        `-Xmx${s.memory}M`,
        "-jar",
        jar,
        "nogui",
      ],
      { cwd: directory(s), stdio: ["pipe", "pipe", "pipe"] },
    );
    const r = runtime.get(s.id) || { logs: [] };
    Object.assign(r, {
      child,
      started: Date.now(),
      stopping: false,
      exitCode: null,
    });
    runtime.set(s.id, r);
    r.done = new Promise((resolve) =>
      child.once("close", (code) => {
        r.child = null;
        r.stopping = false;
        r.exitCode = code;
        log(s.id, `[Panel] Process exited (${code ?? "signal"}).`);
        resolve();
      }),
    );
    child.stdin.on("error", () => {});
    for (const stream of [child.stdout, child.stderr]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop();
        for (const line of lines) log(s.id, line);
        if (pending.length > 65536) {
          log(s.id, pending.slice(0, 65536));
          pending = "";
        }
      });
      stream.on("end", () => {
        if (pending) log(s.id, pending);
      });
    }
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", (e) => {
        log(s.id, `[Panel] ${e.message}`);
        reject(fail(400, `Could not launch Java: ${e.message}`));
      });
    });
    log(
      s.id,
      "[Panel] Java process started. Watch for the Minecraft ready message.",
    );
    return info(s);
  }
  async function stop(s, kill = false) {
    const r = runtime.get(s.id);
    if (!r?.child) return info(s);
    r.stopping = true;
    if (kill) r.child.kill("SIGKILL");
    else r.child.stdin.write("stop\n");
    const timer = setTimeout(() => r.child?.kill("SIGKILL"), stopTimeout);
    try {
      await r.done;
    } finally {
      clearTimeout(timer);
    }
    return info(s);
  }
  async function power(s, action) {
    return exclusive(s.id, async () => {
      if (action === "start") return start(s);
      if (action === "stop") return stop(s);
      if (action === "kill") return stop(s, true);
      if (action === "restart") {
        await stop(s);
        return start(s);
      }
      throw fail(400, "Invalid power action.");
    });
  }
  async function readBody(req, limit = 1024 * 1024) {
    let size = 0,
      chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw fail(413, "Request is too large.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function jsonBody(req) {
    try {
      return JSON.parse((await readBody(req)).toString() || "{}");
    } catch (e) {
      if (e.status) throw e;
      throw fail(400, "Invalid JSON.");
    }
  }
  async function stats(s) {
    const r = runtime.get(s.id);
    let cpu = 0,
      ram = 0;
    if (r?.child?.pid) {
      try {
        const { stdout } = await exec("ps", [
          "-p",
          String(r.child.pid),
          "-o",
          "%cpu=,rss=",
        ]);
        const v = stdout.trim().split(/\s+/).map(Number);
        cpu = v[0] || 0;
        ram = (v[1] || 0) * 1024;
      } catch {}
    }
    async function size(p) {
      let total = 0;
      for (const entry of await fs.readdir(p, { withFileTypes: true })) {
        const f = path.join(p, entry.name);
        if (entry.isDirectory()) total += await size(f);
        else if (entry.isFile()) total += (await fs.stat(f)).size;
      }
      return total;
    }
    const disk = await fs.statfs(directory(s));
    return {
      cpu_percent: cpu,
      ram_usage_bytes: ram,
      ram_total_bytes: s.memory * 1048576,
      storage_usage_bytes: await size(directory(s)),
      storage_total_bytes: Number(disk.blocks) * Number(disk.bsize),
    };
  }
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(value));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host)
        throw fail(403, "Cross-origin requests are forbidden.");
      if (url.pathname.startsWith("/api/")) {
        if (await auth.handle(req, res, url.pathname, jsonBody, send)) return;
        const user = auth.session(req);
        if (!user) throw fail(401, "Sign in to your account.");
        if (url.pathname === "/api/session")
          return send(200, { username: user.username });
        if (url.pathname === "/api/world-imports" && req.method === "PUT") {
          return await exclusive("world-import", async () => {
            for (const [id, item] of worldImports) {
              if (item.expires < Date.now() || item.userId === user.id) {
                await fs.rm(path.join(importsDir, id), {
                  recursive: true,
                  force: true,
                });
                worldImports.delete(id);
              }
            }
            if (worldImports.size >= 10)
              throw fail(429, "Too many pending world imports.");
            const id = crypto.randomUUID(),
              staging = path.join(importsDir, id);
            await fs.mkdir(staging, { mode: 0o700 });
            const archive = path.join(staging, "world.zip");
            const handle = await fs.open(archive, "wx", 0o600);
            try {
              let size = 0;
              for await (const chunk of req) {
                size += chunk.length;
                if (size > MAX_ZIP)
                  throw fail(413, "World ZIP limit is 512 MiB.");
                await handle.writeFile(chunk);
              }
              await handle.close();
              const imported = await extractWorld(
                archive,
                path.join(staging, "files"),
              );
              await fs.rm(archive);
              worldImports.set(id, {
                ...imported,
                userId: user.id,
                expires: Date.now() + 1800000,
              });
              return send(201, {
                id,
                name: imported.name,
                bytes: imported.bytes,
              });
            } catch (e) {
              await fs.rm(staging, { recursive: true, force: true });
              throw e;
            } finally {
              await handle.close().catch(() => {});
            }
          });
        }
        if (url.pathname === "/api/servers") {
          if (req.method === "GET") return send(200, records.map(info));
          if (req.method === "POST")
            return await exclusive("world-import", async () => {
              const b = await jsonBody(req);
              if (
                typeof b.name !== "string" ||
                !b.name.trim() ||
                b.name.length > 80
              )
                throw fail(400, "Provide a name of 1–80 characters.");
              if (
                !Number.isInteger(b.port) ||
                b.port < 1024 ||
                b.port > 65535 ||
                records.some((s) => s.port === b.port)
              )
                throw fail(400, "Choose an unused port from 1024–65535.");
              if (
                !Number.isInteger(b.memory) ||
                b.memory < 512 ||
                b.memory > 65536
              )
                throw fail(400, "Memory must be 512–65536 MiB.");
              if (b.eula !== true)
                throw fail(
                  400,
                  "Accept the Minecraft EULA to create a server.",
                );
              const imported = b.worldImport
                ? worldImports.get(b.worldImport)
                : null;
              if (
                b.worldImport &&
                (!imported ||
                  imported.userId !== user.id ||
                  imported.expires < Date.now())
              )
                throw fail(400, "World upload expired. Upload your ZIP again.");
              const s = {
                id: crypto.randomUUID(),
                name: b.name.trim(),
                port: b.port,
                memory: b.memory,
                created: new Date().toISOString(),
              };
              await fs.mkdir(directory(s), { recursive: true, mode: 0o700 });
              try {
                if (imported)
                  await fs.cp(
                    imported.worldPath,
                    path.join(directory(s), "world"),
                    { recursive: true, errorOnExist: true, force: false },
                  );
                await fs.writeFile(
                  path.join(directory(s), "eula.txt"),
                  "eula=true\n",
                );
                await fs.writeFile(
                  path.join(directory(s), "server.properties"),
                  `server-port=${s.port}\nmotd=${s.name.replace(/[\r\n]/g, " ")}\nonline-mode=true\nlevel-name=world\n`,
                );
                records.push(s);
                try {
                  await save();
                } catch (e) {
                  records.splice(records.indexOf(s), 1);
                  throw e;
                }
              } catch (e) {
                await fs.rm(directory(s), { recursive: true, force: true });
                throw e;
              }
              if (imported) {
                worldImports.delete(b.worldImport);
                await fs
                  .rm(path.join(importsDir, b.worldImport), {
                    recursive: true,
                    force: true,
                  })
                  .catch(() => {});
              }
              return send(201, info(s));
            });
        }
        const match = url.pathname.match(
          /^\/api\/servers\/([a-zA-Z0-9-]+)(?:\/(.*))?$/,
        );
        if (!match) throw fail(404, "Endpoint not found.");
        const s = records.find((s) => s.id === match[1]);
        if (!s) throw fail(404, "Server not found.");
        const route = match[2] || "";
        if (!route && req.method === "GET") return send(200, info(s));
        if (route === "icon" && req.method === "GET") {
          if (!s.iconRevision) throw fail(404, "No server icon uploaded.");
          const image = await fs.readFile(
            path.join(root, "icons", s.id + ".png"),
          );
          res.writeHead(200, {
            "Content-Type": "image/png",
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          });
          return res.end(image);
        }
        if (route === "icon" && req.method === "PUT")
          return await exclusive(s.id, async () => {
            const image = await normalizeIcon(
              await readBody(req, 5 * 1024 * 1024),
            );
            const minecraftTarget = await safe(s, "server-icon.png", true);
            const minecraftTmp =
              minecraftTarget + "." + crypto.randomUUID() + ".tmp";
            const folder = path.join(root, "icons");
            await fs.mkdir(folder, { recursive: true, mode: 0o700 });
            const target = path.join(folder, s.id + ".png"),
              tmp = target + ".tmp";
            try {
              await fs.writeFile(tmp, image.panel, { mode: 0o600 });
              await fs.writeFile(minecraftTmp, image.minecraft, {
                mode: 0o600,
                flag: "wx",
              });
              await fs.rename(minecraftTmp, minecraftTarget);
              await fs.rename(tmp, target);
            } finally {
              await fs.rm(tmp, { force: true });
              await fs.rm(minecraftTmp, { force: true });
            }
            s.iconRevision = crypto.randomUUID();
            await save();
            return send(200, info(s));
          });
        if (route === "installation/catalog" && req.method === "GET")
          return send(
            200,
            await catalog.catalog(
              url.searchParams.get("platform") || "vanilla",
            ),
          );
        if (route === "installation/builds" && req.method === "GET")
          return send(
            200,
            await catalog.builds(
              url.searchParams.get("platform"),
              url.searchParams.get("version"),
            ),
          );
        if (route === "installation" && req.method === "GET") {
          const files = await fs.readdir(await safe(s, ""), {
            withFileTypes: true,
          });
          return send(200, {
            jar: s.jar || "server.jar",
            installation: s.installation || null,
            jars: files
              .filter((f) => f.isFile() && f.name.endsWith(".jar"))
              .map((f) => f.name),
          });
        }
        if (route === "installation/select" && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            const jar = safeFilename(b.jar);
            if (
              !jar.endsWith(".jar") ||
              !(await fs.stat(await safe(s, jar))).isFile()
            )
              throw fail(400, "Select an existing executable JAR.");
            if (
              !["vanilla", "fabric", "paper", "custom"].includes(b.platform) ||
              typeof b.version !== "string" ||
              b.version.length > 80
            )
              throw fail(400, "Choose a platform and Minecraft version.");
            s.jar = jar;
            s.installation = {
              platform: b.platform,
              version: b.version,
              loader: "custom",
              source: "uploaded",
            };
            await save();
            return send(200, info(s));
          });
        if (route === "installation/install" && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            if (b.confirm !== true)
              throw fail(400, "Confirm the server software change.");
            const d = await catalog.artifact(b.platform, b.version, b.loader);
            const jar = `${b.platform}-${b.version}-${b.loader || "release"}-${crypto.randomUUID().slice(0, 8)}.jar`;
            safeFilename(jar);
            const target = await safe(s, jar, true);
            const tmp = path.join(
              directory(s),
              ".install-" + crypto.randomUUID(),
            );
            try {
              await catalog.download(d, tmp);
              await fs.rename(tmp, target);
            } finally {
              await fs.rm(tmp, { force: true });
            }
            s.jar = jar;
            s.installation = {
              platform: b.platform,
              version: b.version,
              loader: b.loader || "",
              java: d.java || null,
              source: "official",
            };
            await save();
            log(
              s.id,
              `[Panel] Installed ${b.platform} ${b.version}. Previous JARs and world files were kept.`,
            );
            return send(200, info(s));
          });
        if (route === "content" && req.method === "GET") {
          const result = [];
          for (const folder of ["mods", "plugins"]) {
            let base;
            try {
              base = await safe(s, folder);
            } catch (e) {
              if (e.code === "ENOENT") continue;
              throw e;
            }
            for (const f of await fs.readdir(base, { withFileTypes: true })) {
              if (!f.isFile() || !/\.jar(?:\.disabled)?$/i.test(f.name))
                continue;
              const filepath = folder + "/" + f.name,
                metadata = s.content?.[filepath];
              result.push({
                id: filepath,
                file_path: filepath,
                file_name: f.name,
                enabled: !f.name.endsWith(".disabled"),
                project_type: folder === "plugins" ? "plugin" : "mod",
                has_update: false,
                update_version_id: null,
                source_kind: "local",
                external: !metadata,
                project: {
                  id: metadata?.projectId || filepath,
                  slug: "",
                  title: metadata?.title || f.name,
                  icon_url: null,
                },
                version: metadata
                  ? {
                      id: metadata.versionId,
                      version_number: metadata.version,
                      file_name: f.name,
                    }
                  : undefined,
              });
            }
          }
          return send(200, result);
        }
        if (route === "content/toggle" && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            if (
              typeof b.path !== "string" ||
              !/^(mods|plugins)\/[^/]+\.jar(?:\.disabled)?$/.test(b.path)
            )
              throw fail(400, "Invalid content path.");
            const dest = b.path.endsWith(".disabled")
              ? b.path.slice(0, -9)
              : b.path + ".disabled";
            const from = await safe(s, b.path),
              to = await safe(s, dest, true);
            try {
              await fs.stat(to);
              throw fail(409, "Destination already exists.");
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            await fs.rename(from, to);
            if (s.content?.[b.path]) {
              s.content[dest] = s.content[b.path];
              delete s.content[b.path];
              await save();
            }
            return send(200, { ok: true });
          });
        if (route === "content/search" && req.method === "GET")
          return send(
            200,
            await catalog.search(s, url.searchParams.get("query") || ""),
          );
        if (route === "content/versions" && req.method === "GET")
          return send(
            200,
            await catalog.versions(s, url.searchParams.get("project") || ""),
          );
        if (route === "content/plan" && req.method === "POST")
          return send(
            200,
            await catalog.plan(s, (await jsonBody(req)).versionId),
          );
        if (route === "content/install" && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            if (b.confirm !== true) throw fail(400, "Confirm installation.");
            const plan = await catalog.plan(s, b.versionId),
              { folder } = catalog.context(s);
            const base = await safe(s, folder, true);
            await fs.mkdir(base, { recursive: true });
            for (const entry of plan) {
              for (const [filepath, installed] of Object.entries(
                s.content || {},
              )) {
                if (
                  installed.projectId === entry.projectId &&
                  installed.versionId !== entry.versionId
                ) {
                  try {
                    await fs.stat(await safe(s, filepath));
                    throw fail(
                      409,
                      "Remove the installed version of " +
                        entry.title +
                        " before changing versions.",
                    );
                  } catch (e) {
                    if (e.code !== "ENOENT") throw e;
                  }
                }
              }
            }
            const pending = [];
            const committed = [];
            try {
              for (const entry of plan) {
                const dest = await safe(
                  s,
                  folder + "/" + entry.file.filename,
                  true,
                );
                try {
                  await fs.stat(dest);
                  if (
                    s.content?.[folder + "/" + entry.file.filename]
                      ?.versionId === entry.versionId
                  )
                    continue;
                  throw fail(
                    409,
                    "File already exists: " + entry.file.filename,
                  );
                } catch (e) {
                  if (e.code !== "ENOENT") throw e;
                }
                const tmp = path.join(
                  directory(s),
                  ".mod-" + crypto.randomUUID(),
                );
                await catalog.download(
                  {
                    url: entry.file.url,
                    hashes: entry.file.hashes,
                    size: entry.file.size,
                  },
                  tmp,
                );
                pending.push({ tmp, dest, entry });
              }
              for (const item of pending) {
                await fs.rename(item.tmp, item.dest);
                committed.push(item.dest);
              }
            } catch (e) {
              for (const dest of committed) await fs.rm(dest, { force: true });
              throw e;
            } finally {
              for (const item of pending)
                await fs.rm(item.tmp, { force: true });
            }
            s.content ||= {};
            for (const { entry } of pending)
              s.content[folder + "/" + entry.file.filename] = {
                projectId: entry.projectId,
                versionId: entry.versionId,
                title: entry.title,
                version: entry.version,
              };
            await save();
            return send(200, { installed: pending.length });
          });
        if (route === "snapshot" && req.method === "GET")
          return send(200, {
            server: info(s),
            logs: runtime.get(s.id)?.logs || [],
            stats: await stats(s),
          });
        if (route === "power" && req.method === "POST")
          return send(200, await power(s, (await jsonBody(req)).action));
        if (route === "command" && req.method === "POST") {
          const { command } = await jsonBody(req);
          if (
            typeof command !== "string" ||
            !command.trim() ||
            command.length > 4096 ||
            /[\r\n\0]/.test(command)
          )
            throw fail(400, "Enter one command.");
          const r = runtime.get(s.id);
          if (!r?.child || r.stopping)
            throw fail(409, "Server is not running.");
          r.child.stdin.write(command + "\n");
          return send(200, { ok: true });
        }
        if (route === "settings" && req.method === "PATCH")
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            if (
              typeof b.name !== "string" ||
              !b.name.trim() ||
              b.name.length > 80 ||
              !Number.isInteger(b.memory) ||
              b.memory < 512 ||
              b.memory > 65536
            )
              throw fail(400, "Invalid name or memory limit.");
            s.name = b.name.trim();
            s.memory = b.memory;
            await save();
            return send(200, info(s));
          });
        if (route === "files" && req.method === "GET") {
          const p = await safe(s, url.searchParams.get("path") || "");
          const st = await fs.stat(p);
          if (st.isDirectory()) {
            const items = [];
            for (const d of await fs.readdir(p, { withFileTypes: true })) {
              if (d.isSymbolicLink()) continue;
              const stat = await fs.lstat(path.join(p, d.name));
              items.push({
                name: d.name,
                path: path.posix.join(
                  "/",
                  url.searchParams.get("path") || "",
                  d.name,
                ),
                type: d.isDirectory() ? "directory" : "file",
                size: stat.size,
                created: stat.birthtimeMs / 1000,
                modified: stat.mtimeMs / 1000,
              });
            }
            return send(200, items);
          }
          if (st.size > 1024 * 1024)
            throw fail(413, "Use Download for files larger than 1 MiB.");
          return send(200, { content: await fs.readFile(p, "utf8") });
        }
        if (route === "download" && req.method === "GET") {
          const p = await safe(s, url.searchParams.get("path") || "");
          if (!(await fs.stat(p)).isFile()) throw fail(400, "Select a file.");
          res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(p))}`,
            "X-Content-Type-Options": "nosniff",
          });
          const handle = await fs.open(p);
          handle
            .createReadStream()
            .on("error", () => res.destroy())
            .pipe(res);
          return;
        }
        if (route === "files" && ["PUT", "POST", "DELETE"].includes(req.method))
          return await exclusive(s.id, async () => {
            stopped(s);
            const b = await jsonBody(req);
            const p = await safe(s, b.path, true);
            if (p === directory(s))
              throw fail(400, "Cannot modify the root directory.");
            if (req.method === "PUT") {
              if (typeof b.content !== "string")
                throw fail(400, "Expected text content.");
              const tmp = path.join(
                directory(s),
                ".write-" + crypto.randomUUID(),
              );
              try {
                await fs.writeFile(tmp, b.content, { flag: "wx", mode: 0o600 });
                await fs.rename(tmp, p);
              } finally {
                await fs.rm(tmp, { force: true });
              }
            } else if (req.method === "DELETE") {
              const st = await fs.lstat(p);
              if (st.isDirectory()) await tree(p);
              await fs.rm(p, { recursive: b.recursive === true });
            } else if (b.action === "rename" || b.action === "move") {
              const dest = await safe(s, b.destination, true);
              if (dest === directory(s))
                throw fail(400, "Invalid destination.");
              try {
                await fs.lstat(dest);
                throw fail(409, "Destination already exists.");
              } catch (e) {
                if (e.code !== "ENOENT") throw e;
              }
              await fs.rename(p, dest);
            } else if (b.type === "directory") await fs.mkdir(p);
            else await fs.writeFile(p, "", { flag: "wx", mode: 0o600 });
            return send(200, { ok: true });
          });
        if (route === "upload" && req.method === "PUT")
          return await exclusive(s.id, async () => {
            stopped(s);
            const p = await safe(s, url.searchParams.get("path"), true);
            if (p === directory(s)) throw fail(400, "Select a filename.");
            const tmp = path.join(
              directory(s),
              ".upload-" + crypto.randomUUID(),
            );
            let size = 0;
            const handle = await fs.open(tmp, "wx", 0o600);
            try {
              for await (const chunk of req) {
                size += chunk.length;
                if (size > 512 * 1024 * 1024)
                  throw fail(413, "Upload limit is 512 MiB.");
                await handle.writeFile(chunk);
              }
              await handle.close();
              await fs.rename(tmp, p);
            } finally {
              await handle.close().catch(() => {});
              await fs.rm(tmp, { force: true });
            }
            return send(200, { ok: true });
          });
        const backupsDir = path.join(root, "backups", s.id);
        if (route === "backups" && req.method === "GET") {
          await fs.mkdir(backupsDir, { recursive: true });
          const list = [];
          for (const id of await fs.readdir(backupsDir)) {
            if (!ID.test(id)) continue;
            try {
              list.push(
                JSON.parse(
                  await fs.readFile(
                    path.join(backupsDir, id, "meta.json"),
                    "utf8",
                  ),
                ),
              );
            } catch {}
          }
          return send(
            200,
            list.sort((a, b) => b.created_at.localeCompare(a.created_at)),
          );
        }
        if (route === "backups" && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            await tree(directory(s));
            const b = await jsonBody(req),
              id = crypto.randomUUID();
            const meta = {
              id,
              name: String(b.name || "Manual backup").slice(0, 80),
              created_at: new Date().toISOString(),
              automated: false,
              history: [],
            };
            const target = path.join(backupsDir, id);
            await fs.mkdir(target, { recursive: true });
            try {
              await fs.cp(directory(s), path.join(target, "files"), {
                recursive: true,
              });
              await fs.writeFile(
                path.join(target, "meta.json"),
                JSON.stringify(meta),
              );
            } catch (e) {
              await fs.rm(target, { recursive: true, force: true });
              throw e;
            }
            return send(201, meta);
          });
        const restore = route.match(/^backups\/([a-zA-Z0-9-]+)\/restore$/);
        if (restore && req.method === "POST")
          return await exclusive(s.id, async () => {
            stopped(s);
            if ((await jsonBody(req)).confirm !== true)
              throw fail(
                400,
                "Confirm that the backup should replace current server files.",
              );
            const source = path.join(backupsDir, restore[1], "files");
            await tree(source);
            const staging = directory(s) + ".restore-" + crypto.randomUUID(),
              old = directory(s) + ".previous-" + crypto.randomUUID();
            await fs.cp(source, staging, { recursive: true });
            await fs.rename(directory(s), old);
            try {
              await fs.rename(staging, directory(s));
            } catch (e) {
              await fs.rename(old, directory(s));
              throw e;
            }
            await fs.rm(old, { recursive: true, force: true });
            return send(200, { ok: true });
          });
        throw fail(404, "Endpoint not found.");
      }
      if (req.method !== "GET") throw fail(405, "Method not allowed.");
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ""),
        requested = path.resolve(dist, relative);
      if (!requested.startsWith(dist + path.sep) && requested !== dist)
        throw fail(403, "Invalid path.");
      let file = requested;
      try {
        if (!(await fs.stat(file)).isFile())
          file = path.join(dist, "index.html");
      } catch {
        file = path.join(dist, "index.html");
      }
      const content = await fs.readFile(file);
      const type =
        {
          ".html": "text/html",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".woff2": "font/woff2",
          ".png": "image/png",
          ".webp": "image/webp",
        }[path.extname(file)] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": type,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'",
      });
      res.end(content);
    } catch (e) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      send(
        e.status ||
          {
            ENOENT: 404,
            EEXIST: 409,
            EISDIR: 400,
            ENOTDIR: 400,
            ENOTEMPTY: 409,
          }[e.code] ||
          500,
        { error: e.status || e.code ? e.message : "Internal server error." },
      );
      if (!e.status && !e.code) console.error(e);
    }
  });
  return {
    server,
    root,
    token,
    async close() {
      closing = true;
      await Promise.all(records.map((s) => stop(s)));
      await saveQueue;
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(lock, { force: true });
    },
  };
}
