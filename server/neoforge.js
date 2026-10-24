const invalid = (message) => Object.assign(new Error(message), { status: 400 });
export const NEOFORGE_MAVEN =
  "https://maven.neoforged.net/releases/net/neoforged/";
export function neoForgeVersions(xml, legacy = false) {
  if (typeof xml !== "string" || !xml.includes("<metadata"))
    throw invalid("Invalid NeoForge Maven metadata.");
  const result = [];
  for (const [, id] of xml.matchAll(/<version>\s*([^<]+?)\s*<\/version>/g)) {
    if (legacy) {
      const match = /^(1\.20\.1)-(47\.[0-9]+\.[0-9]+)$/.exec(id);
      if (match)
        result.push({
          id: match[2],
          minecraft: match[1],
          coordinate: id,
          artifact: "forge",
          stable: true,
        });
      continue;
    }
    const match =
      /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(-beta|-alpha(?:\.\d+)?)?$/.exec(id);
    if (!match) continue; // Snapshot/pre-release coordinates require a distinct Minecraft mapping.
    const [, major, minor, patch, build, suffix] = match;
    let minecraft;
    if (
      ["20", "21"].includes(major) &&
      build === undefined &&
      !(major === "20" && +minor < 2)
    )
      minecraft = `1.${major}${+minor ? "." + minor : ""}`;
    else if (+major >= 26 && build !== undefined)
      minecraft = `${major}.${minor}${+patch ? "." + patch : ""}`;
    else continue;
    result.push({
      id,
      minecraft,
      coordinate: id,
      artifact: "neoforge",
      stable: !suffix,
    });
  }
  if (!result.length) throw invalid("No supported NeoForge versions found.");
  return result.sort(
    (a, b) =>
      Number(b.stable) - Number(a.stable) ||
      b.id.localeCompare(a.id, undefined, { numeric: true }),
  );
}
