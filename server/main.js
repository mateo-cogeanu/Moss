import { createBackend } from "./backend.js";
import { createUpdater } from "./updates.js";
let updater;
const backend = await createBackend({
  dataDir: process.env.DATA_DIR || "./panel-data",
  java: process.env.JAVA_BIN || "java",
  updateStatus: () => updater.state,
});
const port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "127.0.0.1";
backend.server.listen(port, host, () =>
  console.log(
    `Moss: http://${host}:${port}\nAdmin token file: ${backend.root}/admin-token`,
  ),
);
updater = createUpdater({
  repo: process.cwd(),
  backend,
  port,
  host,
  enabled: process.env.AUTO_UPDATE === "true",
  service: process.env.MOSS_SERVICE_NAME || "serverui.service",
});
updater.start();
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    updater.stop();
    await backend.close();
    process.exit(0);
  });
