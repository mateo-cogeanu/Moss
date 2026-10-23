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
