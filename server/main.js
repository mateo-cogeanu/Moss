import { createBackend } from "./backend.js";
const backend = await createBackend({
  dataDir: process.env.DATA_DIR || "./panel-data",
  java: process.env.JAVA_BIN || "java",
});
const port = Number(process.env.PORT || 3000),
  host = process.env.HOST || "127.0.0.1";
backend.server.listen(port, host, () =>
  console.log(
    `Server panel: http://${host}:${port}\nAdmin token file: ${backend.root}/admin-token`,
  ),
);
let closing = false;
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    await backend.close();
    process.exit(0);
  });
