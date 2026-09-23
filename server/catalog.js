import crypto from "node:crypto";
import fs from "node:fs/promises";
const UA = "SelfHostedServerPanel/0.1 (personal server administration)";
const hosts = new Set([
  "piston-meta.mojang.com",
  "piston-data.mojang.com",
  "launcher.mojang.com",
  "launchermeta.mojang.com",
  "meta.fabricmc.net",
  "fill.papermc.io",
  "fill-data.papermc.io",
  "api.modrinth.com",
  "cdn.modrinth.com",
]);
const err = (message) => Object.assign(new Error(message), { status: 400 });
export function allowedUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    !hosts.has(u.hostname) ||
    u.port ||
    u.username ||
    u.password
  )
    throw err("Untrusted download URL.");
  return u.href;
}
export function safeFilename(name) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 200 ||
    name === "." ||
    name === ".." ||
    /[\\/\x00-\x1f:]/.test(name)
  )
    throw err("Invalid artifact filename.");
  return name;
}
export function createCatalog(fetcher = fetch) {
  const cache = new Map();
  async function response(url) {
    let next = allowedUrl(url);
    for (let i = 0; i < 5; i++) {
      const r = await fetcher(next, {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(120000),
      });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        next = allowedUrl(new URL(r.headers.get("location"), next).href);
        continue;
      }
      if (!r.ok)
        throw err(
          `Upstream service returned HTTP ${r.status}. Try again later.`,
        );
      return r;
    }
    throw err("Too many download redirects.");
  }
  async function json(url) {
    const hit = cache.get(url);
    if (hit && hit.expires > Date.now()) return hit.value;
    const r = await response(url);
    const text = await r.text();
    if (text.length > 20 * 1024 * 1024)
      throw err("Metadata response too large.");
    const value = JSON.parse(text);
    if (cache.size > 300) cache.clear();
    cache.set(url, { value, expires: Date.now() + 300000 });
    return value;
  }
  async function catalog(platform) {
    if (platform === "vanilla") {
      const m = await json(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
      );
      return {
        versions: m.versions
          .filter((v) => ["release", "snapshot"].includes(v.type))
          .map((v) => ({
            value: v.id,
            label: v.id,
            stable: v.type === "release",
          })),
        loaders: [],
      };
    }
    if (platform === "fabric") {
      const m = await json("https://meta.fabricmc.net/v2/versions");
      return {
        versions: m.game.map((v) => ({
          value: v.version,
          label: v.version,
          stable: v.stable,
        })),
        loaders: m.loader.map((v) => ({ id: v.version, stable: v.stable })),
        installer: m.installer.find((v) => v.stable)?.version,
      };
    }
    if (platform === "paper") {
      const m = await json("https://fill.papermc.io/v3/projects/paper");
      return {
        versions: Object.values(m.versions)
          .flat()
          .map((v) => ({
            value: v,
            label: v,
            stable: !/(pre|rc|snapshot)/i.test(v),
          })),
        loaders: [],
      };
    }
    throw err("Choose Vanilla, Fabric, or Paper.");
  }
  async function builds(platform, version) {
    if (platform === "fabric") return (await catalog("fabric")).loaders;
    if (platform === "vanilla") return [];
    if (platform !== "paper") throw err("Unsupported platform.");
    return (
      await json(
        `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`,
      )
    )
      .filter((b) => b.channel === "STABLE")
      .map((b) => ({ id: String(b.id), stable: true, label: `Build ${b.id}` }));
  }
  async function artifact(platform, version, loader) {
    const list = await catalog(platform);
    if (!list.versions.some((v) => v.value === version))
      throw err("Unknown Minecraft version.");
    if (platform === "vanilla") {
      const m = await json(
        "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json",
      );
      const data = await json(m.versions.find((v) => v.id === version).url);
      if (!data.downloads?.server)
        throw err("This version has no dedicated server download.");
      return {
        ...data.downloads.server,
        hashes: { sha1: data.downloads.server.sha1 },
        java: data.javaVersion?.majorVersion,
      };
    }
    if (platform === "fabric") {
      if (!list.loaders.some((l) => l.id === loader))
        throw err("Unknown Fabric loader.");
      return {
        url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader)}/${encodeURIComponent(list.installer)}/server/jar`,
      };
    }
    const builds = await json(
      `https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`,
    );
    const b = builds.find(
      (b) => String(b.id) === String(loader) && b.channel === "STABLE",
    );
    if (!b) throw err("Choose a stable Paper build.");
    const d = b.downloads["server:default"];
    return { ...d, hashes: d.checksums };
  }
  async function download(descriptor, destination) {
    const r = await response(descriptor.url);
    const handle = await fs.open(destination, "wx", 0o600);
    const algorithms = Object.keys(descriptor.hashes || {}).filter((x) =>
      ["sha1", "sha256", "sha512"].includes(x),
    );
    const hashes = Object.fromEntries(
      algorithms.map((a) => [a, crypto.createHash(a)]),
    );
    let bytes = 0;
    try {
      for await (const chunk of r.body) {
        bytes += chunk.length;
        if (bytes > 512 * 1024 * 1024) throw err("Download exceeds 512 MiB.");
        for (const h of Object.values(hashes)) h.update(chunk);
        await handle.write(chunk);
      }
      if (!bytes) throw err("Empty download.");
      for (const [alg, h] of Object.entries(hashes))
        if (h.digest("hex") !== descriptor.hashes[alg])
          throw err("Downloaded file checksum does not match.");
      if (descriptor.size && bytes !== descriptor.size)
        throw err("Incomplete download.");
    } catch (e) {
      await handle.close();
      await fs.rm(destination, { force: true });
      throw e;
    }
    await handle.close();
    return bytes;
  }
  const modrinth = (p) => json("https://api.modrinth.com/v2" + p);
  function context(s) {
    const platform = s.installation?.platform,
      version = s.installation?.version;
    if (!["fabric", "paper"].includes(platform) || !version)
      throw err(
        "Choose Fabric or Paper and a Minecraft version in Installation first.",
      );
    return {
      platform,
      version,
      folder: platform === "paper" ? "plugins" : "mods",
    };
  }
  async function search(s, query) {
    const { platform, version } = context(s);
    const facets = JSON.stringify([
      [`categories:${platform}`],
      [`versions:${version}`],
      ["server_side:required", "server_side:optional"],
    ]);
    return modrinth(
      "/search?" +
        new URLSearchParams({
          query: query.slice(0, 150),
          facets,
          limit: "20",
        }),
    );
  }
  async function versions(s, project) {
    const { platform, version } = context(s);
    return modrinth(
      `/project/${encodeURIComponent(project)}/version?` +
        new URLSearchParams({
          loaders: JSON.stringify([platform]),
          game_versions: JSON.stringify([version]),
        }),
    );
  }
  async function plan(s, versionId) {
    const { platform, version } = context(s),
      seen = new Set(),
      projects = new Map(),
      result = [];
    async function visit(id) {
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 40) throw err("Too many required dependencies.");
      const v = await modrinth("/version/" + encodeURIComponent(id));
      if (!v.loaders.includes(platform) || !v.game_versions.includes(version))
        throw err("A version is incompatible with the selected server.");
      if (projects.has(v.project_id) && projects.get(v.project_id) !== v.id)
        throw err("Conflicting dependency versions.");
      projects.set(v.project_id, v.id);
      const project = await modrinth(
        "/project/" + encodeURIComponent(v.project_id),
      );
      if (project.server_side === "unsupported")
        throw err("Client-only mods cannot be installed on this server.");
      for (const dep of v.dependencies || []) {
        if (dep.dependency_type !== "required") continue;
        if (dep.version_id) await visit(dep.version_id);
        else if (dep.project_id) {
          const compatible = await versions(s, dep.project_id);
          if (!compatible.length)
            throw err("No compatible required dependency found.");
          await visit(compatible[0].id);
        } else throw err("A required dependency must be installed manually.");
      }
      const file = v.files.find((f) => f.primary) || v.files[0];
      if (!file || !file.filename.endsWith(".jar"))
        throw err("Only server mod/plugin JARs are supported.");
      safeFilename(file.filename);
      result.push({
        versionId: v.id,
        projectId: v.project_id,
        title: project.title,
        version: v.version_number,
        file,
      });
    }
    await visit(versionId);
    const names = new Set();
    for (const entry of result) {
      if (names.has(entry.file.filename))
        throw err("Conflicting dependency filenames.");
      names.add(entry.file.filename);
    }
    return result;
  }
  return {
    catalog,
    builds,
    artifact,
    download,
    search,
    versions,
    plan,
    context,
  };
}
