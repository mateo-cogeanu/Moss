import fs from "node:fs/promises";
import path from "node:path";
import yauzl from "yauzl";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
const fail = (message) => Object.assign(new Error(message), { status: 400 });
export const MAX_ZIP = 512 * 1024 * 1024;
const MAX_EXTRACTED = 4 * 1024 * 1024 * 1024;
export async function extractWorld(archive, target) {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(
      archive,
      { lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
      (e, zip) => (e ? reject(fail("Invalid world ZIP.")) : resolve(zip)),
    ),
  );
  let count = 0,
    declared = 0,
    written = 0;
  const seen = new Set(),
    levels = [];
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", () => reject(fail("Invalid or damaged world ZIP.")));
      zip.on("end", resolve);
      zip.on("entry", (entry) => {
        (async () => {
          if (++count > 100000)
            throw fail("World ZIP contains too many files (limit 100,000).");
          const name = entry.fileName;
          const parts = name.replace(/\/$/, "").split("/");
          if (
            !name ||
            parts.some(
              (p) => !p || p === "." || p === ".." || /[\\:\x00-\x1f]/.test(p),
            ) ||
            name.startsWith("/") ||
            name.length > 1024
          )
            throw fail("World ZIP contains an unsafe path.");
          const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (mode && mode !== 0x8000 && mode !== 0x4000)
            throw fail(
              "World ZIP cannot contain symbolic links or special files.",
            );
          if (entry.generalPurposeBitFlag & 1)
            throw fail("Encrypted world ZIPs are not supported.");
          declared += entry.uncompressedSize;
          if (declared > MAX_EXTRACTED)
            throw fail("Expanded world exceeds the 4 GiB limit.");
          if (parts[0] === "__MACOSX" || parts.at(-1) === ".DS_Store") {
            zip.readEntry();
            return;
          }
          const normalized = parts.join("/").normalize("NFC").toLowerCase();
          if (seen.has(normalized))
            throw fail("World ZIP contains duplicate paths.");
          seen.add(normalized);
          const dest = path.join(target, ...parts);
          if (name.endsWith("/"))
            await fs.mkdir(dest, { recursive: true, mode: 0o700 });
          else {
            await fs.mkdir(path.dirname(dest), {
              recursive: true,
              mode: 0o700,
            });
            const input = await new Promise((resolve, reject) =>
              zip.openReadStream(entry, (e, stream) =>
                e ? reject(e) : resolve(stream),
              ),
            );
            const handle = await fs.open(dest, "wx", 0o600);
            try {
              await pipeline(
                input,
                new Transform({
                  transform(chunk, encoding, callback) {
                    written += chunk.length;
                    callback(
                      written > MAX_EXTRACTED
                        ? fail("Expanded world exceeds the 4 GiB limit.")
                        : null,
                      chunk,
                    );
                  },
                }),
                handle.createWriteStream(),
              );
            } finally {
              await handle.close().catch(() => {});
            }
            if (parts.at(-1) === "level.dat") {
              if (!entry.uncompressedSize)
                throw fail("The world level.dat file is empty.");
              levels.push(parts.slice(0, -1));
            }
          }
          zip.readEntry();
        })().catch(reject);
      });
      zip.readEntry();
    });
    if (levels.length !== 1)
      throw fail(
        "Upload one Java world containing exactly one level.dat file. ZIP the world folder, not the entire server.",
      );
    return {
      worldPath: path.join(target, ...levels[0]),
      name: levels[0].at(-1) || "world",
      bytes: written,
    };
  } finally {
    zip.close();
  }
}
