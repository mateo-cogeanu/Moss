#!/usr/bin/env node
if (process.argv.includes("--installServer")) {
  const fs = await import("node:fs/promises");
  for (const build of ["61.0.1", "61.0.2"]) {
    const folder = "libraries/net/minecraftforge/forge/1.21.11-" + build;
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      folder + "/unix_args.txt",
      build === "61.0.2"
        ? "-Djava.net.preferIPv6Addresses=system -jar forge-1.21.11-61.0.2-shim.jar\n"
        : "-DlibraryDirectory=libraries\n-p libraries/fixture.jar\nFixtureMain\n--launchTarget forgeserver",
    );
  }
  for (const [artifact, version] of [
    ["neoforge", "21.1.262"],
    ["neoforge", "21.1.264"],
    ["neoforge", "20.2.3-beta"],
    ["neoforge", "26.1.1.2-beta"],
    ["neoforge", "26.3.0.97"],
    ["forge", "1.20.1-47.1.106"],
  ]) {
    const folder = `libraries/net/neoforged/${artifact}/${version}`;
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      folder + "/unix_args.txt",
      "-DlibraryDirectory=libraries\n-p libraries/fixture.jar\n" +
        (version.startsWith("26.")
          ? "net.neoforged.fml.startup.Server"
          : "FixtureMain\n--launchTarget forgeserver"),
    );
  }
  await fs.writeFile("forge-1.21.11-61.0.2-shim.jar", "fixture shim");
  console.log("Forge installer fixture complete");
  process.exit(0);
}
console.log(
  "[Server thread/INFO]: Java args " + process.argv.slice(2).join(" "),
);
console.log("[Server thread/INFO]: Done! Test fixture ready.");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  for (const command of chunk.trim().split("\n")) {
    if (command === "stop") process.exit(0);
    console.log("[Server thread/INFO]: " + command);
  }
});
