import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { command } from "../server/updates.js";
const service = process.argv[2] || "serverui.service";
if (process.platform !== "linux" || !/^[a-zA-Z0-9_-]+\.service$/.test(service))
  throw new Error(
    "Use Linux with a user systemd service, e.g. serverui.service.",
  );
const repo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const workingDir = await command(
  "systemctl",
  ["--user", "show", service, "--property=WorkingDirectory", "--value"],
  repo,
);
if (workingDir !== repo)
  throw new Error(`The ${service} working directory must be ${repo}.`);
const directory = path.join(
  os.homedir(),
  ".config",
  "systemd",
  "user",
  `${service}.d`,
);
await fs.mkdir(directory, { recursive: true });
await fs.writeFile(
  path.join(directory, "moss-updates.conf"),
  `[Service]\nEnvironment=AUTO_UPDATE=true\nEnvironment=MOSS_SERVICE_NAME=${service}\n`,
);
await command("systemctl", ["--user", "daemon-reload"], repo);
console.log(
  `Automatic updates enabled. Stop Minecraft servers, then run: systemctl --user restart ${service}`,
);
