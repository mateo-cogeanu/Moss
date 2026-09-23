import crypto from "node:crypto";
export const jarBytes = Buffer.from("test server or mod jar");
const hashes = {
  sha512: crypto.createHash("sha512").update(jarBytes).digest("hex"),
  sha1: crypto.createHash("sha1").update(jarBytes).digest("hex"),
};
export async function catalogFixture(url) {
  const u = new URL(url),
    p = u.pathname;
  let data;
  if (p.endsWith("version_manifest_v2.json"))
    data = {
      versions: [
        {
          id: "1.21.11",
          type: "release",
          url: "https://piston-meta.mojang.com/version.json",
        },
      ],
    };
  else if (p === "/version.json")
    data = {
      javaVersion: { majorVersion: 21 },
      downloads: {
        server: {
          url: "https://piston-data.mojang.com/server.jar",
          sha1: hashes.sha1,
          size: jarBytes.length,
        },
      },
    };
  else if (p === "/v2/versions")
    data = {
      game: [{ version: "1.21.11", stable: true }],
      loader: [{ version: "0.19.5", stable: true }],
      installer: [{ version: "1.1.2", stable: true }],
    };
  else if (p === "/v3/projects/paper")
    data = { versions: { 1.21: ["1.21.11"] } };
  else if (p.endsWith("/builds"))
    data = [
      {
        id: 132,
        channel: "STABLE",
        downloads: {
          "server:default": {
            url: "https://fill-data.papermc.io/paper.jar",
            checksums: hashes,
            size: jarBytes.length,
          },
        },
      },
    ];
  else if (p === "/v2/search")
    data = {
      hits: [
        {
          project_id: "testmod",
          title: "Test server mod",
          description: "Compatible test fixture",
        },
      ],
    };
  else if (/^\/v2\/version\//.test(p)) {
    const id = p.split("/").at(-1);
    data = {
      id,
      project_id: id === "dep-v" ? "dependency" : "testmod",
      version_number: "1.0",
      game_versions: ["1.21.11"],
      loaders: ["fabric"],
      dependencies:
        id === "mod-v"
          ? [{ dependency_type: "required", version_id: "dep-v" }]
          : [],
      files: [
        {
          primary: true,
          filename: id + ".jar",
          url: "https://cdn.modrinth.com/" + id + ".jar",
          hashes,
          size: jarBytes.length,
        },
      ],
    };
  } else if (p.endsWith("/version"))
    data = [{ id: "mod-v", version_number: "1.0" }];
  else if (/^\/v2\/project\//.test(p))
    data = {
      title: p.endsWith("dependency")
        ? "Required dependency"
        : "Test server mod",
      server_side: "required",
    };
  else if (p.endsWith(".jar") || p.endsWith("/server/jar"))
    return new Response(jarBytes);
  else throw new Error("Unexpected fixture request: " + url);
  return Response.json(data);
}
