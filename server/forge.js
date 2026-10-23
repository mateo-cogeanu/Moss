import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
const fail = (message) => Object.assign(new Error(message), { status: 400 });
// No shell: launch Java directly, with a bounded installer run.
export function runInstaller(
  java,
  installer,
  cwd,
  log,
  timeout = 15 * 60 * 1000,
  signal,
) {
  return new Promise((resolve, reject) => {
    const child = spawn(java, ["-jar", installer, "--installServer"], {
      cwd,
      signal,
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let tail = "",
      spawnError;
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        tail = (tail + chunk.toString()).slice(-4000);
        log(chunk.toString().slice(0, 4000).trim());
      });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (spawnError) reject(spawnError);
      else if (code === 0) resolve();
      else
        reject(
          fail(
            `Forge installer failed (${signal || code}). Check Java compatibility and the console. ${tail.slice(-1000)}`,
          ),
        );
    });
  });
}
export async function installForge({
  catalog,
  descriptor,
  directory,
  java,
  log,
  run = runInstaller,
  signal,
}) {
  const name = "forge-runtime-" + crypto.randomUUID();
  const root = path.join(directory, name);
  await fs.mkdir(root, { mode: 0o700 });
  const published = [];
  try {
    await catalog.download(descriptor, path.join(root, "installer.jar"), {
      signal,
    });
    signal?.throwIfAborted();
    log("Installing Forge libraries. This can take several minutes…");
    await run(java, "installer.jar", root, log, undefined, signal);
    signal?.throwIfAborted();
    const source = path.join(
      root,
      "libraries/net/minecraftforge/forge",
      descriptor.coordinate,
      "unix_args.txt",
    );
    // Reject links throughout generated output before accepting the runtime.
    async function check(folder) {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        if (entry.isSymbolicLink())
          throw fail("Forge installer output contains a symbolic link.");
        if (entry.isDirectory()) await check(path.join(folder, entry.name));
      }
    }
    await check(root);
    const args = await fs.readFile(source, "utf8");
    if (args.length > 1024 * 1024)
      throw fail("Forge launch file is too large.");
    let rewritten,
      sharedLibraries = false;
    const shim = `forge-${descriptor.coordinate}-shim.jar`;
    if (args.trim() === `-Djava.net.preferIPv6Addresses=system -jar ${shim}`) {
      // Recent Forge launchers require libraries/ relative to the server cwd.
      // Publish only absent files or reuse identical versioned libraries. Never
      // overwrite an existing, different file. Roll back newly published files
      // on failure, leaving worlds/config/mods and other installations intact.
      async function publish(source, target) {
        const st = await fs.lstat(source);
        try {
          const existing = await fs.lstat(target);
          if (
            existing.isSymbolicLink() ||
            existing.isDirectory() !== st.isDirectory()
          )
            throw fail(
              "Forge library path conflicts with an existing file or link.",
            );
          if (!st.isDirectory()) {
            const [a, b] = await Promise.all([
              fs.readFile(source),
              fs.readFile(target),
            ]);
            if (!a.equals(b))
              throw fail(
                "An existing Forge library differs from the downloaded version. Restore or remove that library before reinstalling.",
              );
            return;
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          if (st.isDirectory()) await fs.mkdir(target);
          else {
            await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
            published.push(target);
            return;
          }
        }
        for (const entry of await fs.readdir(source))
          await publish(path.join(source, entry), path.join(target, entry));
      }
      if (!(await fs.stat(path.join(root, shim))).isFile())
        throw fail("Forge launcher JAR is missing.");
      sharedLibraries = true;
      await publish(
        path.join(root, "libraries"),
        path.join(directory, "libraries"),
      );
      await publish(path.join(root, shim), path.join(directory, shim));
      rewritten = args;
    } else {
      if (!args.includes("libraries/") || !args.includes("forgeserver"))
        throw fail(
          "Unsupported Forge server launch files. Select another build.",
        );
      // Keep cwd at the server root so existing worlds, mods and icons work.
      rewritten = args
        .replaceAll("libraries/", `${name}/libraries/`)
        .replace(
          /-DlibraryDirectory=libraries(?=\s|$)/g,
          `-DlibraryDirectory=${name}/libraries`,
        );
    }
    const argsFile = name + "/moss_args.txt";
    await fs.writeFile(path.join(directory, argsFile), rewritten, {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rm(path.join(root, "installer.jar"));
    return {
      type: "forge-args",
      argsFile,
      ...(sharedLibraries ? { sharedLibraries: true, shim } : {}),
    };
  } catch (error) {
    for (const target of published.reverse())
      await fs.rm(target, { force: true });
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}
