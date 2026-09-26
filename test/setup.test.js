import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
// No real service/package-manager mutations: exercise the actual shell script
// with command fixtures. Unit generation still runs in the real Node runtime.
test(
  "setup creates and starts a user service, preserves existing settings, and stops on failures",
  {
    skip: process.getuid?.() === 0 ? "setup intentionally refuses root" : false,
  },
  async (t) => {
    for (const mode of [
      "fresh",
      "existing",
      "mismatch",
      "build-failure",
      "updating",
    ]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-setup-"));
      t.after(() => fs.rm(root, { recursive: true, force: true }));
      const repo = path.join(root, "Moss space % test");
      const bin = path.join(root, "bin");
      const config = path.join(root, "config");
      const log = path.join(root, "commands");
      await fs.mkdir(bin);
      await fs.mkdir(path.join(repo, "server"), { recursive: true });
      await fs.copyFile(
        new URL("../setup.sh", import.meta.url),
        path.join(repo, "setup.sh"),
      );
      await fs.writeFile(path.join(repo, "package-lock.json"), "{}");
      await fs.writeFile(path.join(repo, "server", "main.js"), "");
      const unit = path.join(config, "systemd/user/serverui.service");
      await fs.mkdir(path.dirname(unit), { recursive: true });
      if (mode === "existing")
        await fs.writeFile(unit, "existing service config");
      const commands = {
        uname: "echo Linux",
        java: "exit 0",
        git: "exit 0",
        loginctl: "echo yes",
        npm: 'echo "npm $*" >> "$SETUP_LOG"; if [ "$SETUP_MODE" = build-failure ]; then exit 1; fi',
        node: 'if [ -n "${MOSS_EFFECTIVE_ENV:-}" ]; then echo "health verified by fixture"; exit 0; fi; exec "$REAL_NODE" "$@"',
        systemctl: `echo "systemctl $*" >> "$SETUP_LOG"
case "$*" in
  *show-environment*) exit 0;;
  *LoadState*) if [ "$SETUP_MODE" = existing ] || [ "$SETUP_MODE" = mismatch ]; then echo loaded; else echo not-found; fi;;
  *WorkingDirectory*) if [ "$SETUP_MODE" = mismatch ]; then echo /old/serverui; else echo "$SETUP_REPO"; fi;;
  *Environment*) echo 'HOST=127.0.0.1 PORT=3000';;
  *is-active*moss-update.service*) [ "$SETUP_MODE" = updating ];;
  *) exit 0;;
esac`,
      };
      for (const [name, body] of Object.entries(commands))
        await fs.writeFile(path.join(bin, name), "#!/bin/sh\n" + body + "\n", {
          mode: 0o755,
        });
      const run = () =>
        exec("bash", [path.join(repo, "setup.sh")], {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            XDG_CONFIG_HOME: config,
            SETUP_LOG: log,
            SETUP_MODE: mode,
            SETUP_REPO: repo,
            REAL_NODE: process.execPath,
            JAVA_BIN: "java",
            SECURE_COOKIE: "true",
            AUTO_UPDATE: "true",
            HOST: "127.0.0.1",
            PORT: "3000",
            MOSS_SERVICE_NAME: "serverui.service",
          },
        });
      if (["mismatch", "build-failure", "updating"].includes(mode))
        await assert.rejects(run());
      else await run();
      const calls = await fs.readFile(log, "utf8");
      if (mode === "fresh") {
        const content = await fs.readFile(unit, "utf8");
        assert.ok(content.includes(repo.replaceAll("%", "%%")));
        assert.ok(content.includes('Environment="SECURE_COOKIE=true"'));
        assert.ok(content.includes('Environment="AUTO_UPDATE=true"'));
        assert.ok(content.includes('Environment="DATA_DIR='));
        assert.match(calls, /enable serverui.service/);
        assert.match(calls, /start serverui.service/);
      } else if (mode === "existing") {
        assert.equal(
          await fs.readFile(unit, "utf8"),
          "existing service config",
        );
        assert.ok(
          calls.indexOf("stop serverui.service") < calls.indexOf("npm ci"),
        );
      } else {
        assert.ok(!calls.includes("start serverui.service"));
        if (mode !== "build-failure") assert.ok(!calls.includes("npm ci"));
        await assert.rejects(fs.access(unit));
      }
    }
  },
);
