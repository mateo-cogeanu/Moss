import fs from "node:fs/promises";
import crypto from "node:crypto";
const root = new URL("../vendor/modrinth/", import.meta.url);
const manifest = JSON.parse(
  await fs.readFile(new URL("SOURCE_MANIFEST.json", root), "utf8"),
);
for (const file of manifest.files) {
  const hash = crypto
    .createHash("sha256")
    .update(await fs.readFile(new URL(file.path, root)))
    .digest("hex");
  if (hash !== file.sha256)
    throw new Error(`Upstream snapshot changed: ${file.path}`);
}
console.log(
  `Verified ${manifest.files.length} upstream files at ${manifest.commit}.`,
);
