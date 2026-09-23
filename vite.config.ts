import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import svg from "vite-svg-loader";
import path from "node:path";
import fs from "node:fs";
const base = path.resolve("vendor/modrinth/packages");
function resolveFile(p: string): string | null {
  for (const s of ["", ".ts", ".js", "/index.ts", "/index.js"])
    if (fs.existsSync(p + s) && fs.statSync(p + s).isFile()) return p + s;
  return null;
}
// Resolve named barrel imports to their original modules, keeping unrelated
// storefront, purchase, and desktop code outside the browser application graph.
function exported(
  file: string,
  name: string,
  seen = new Set<string>(),
): { file: string; name: string } | null {
  if (seen.has(file)) return null;
  seen.add(file);
  const text = fs.readFileSync(file, "utf8");
  for (const m of text.matchAll(
    /export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g,
  )) {
    for (const spec of m[1].split(",")) {
      const [original, alias] = spec.trim().split(/\s+as\s+/);
      if ((alias || original) === name) {
        const f = resolveFile(path.resolve(path.dirname(file), m[2]));
        if (f)
          return original !== "default" && f.endsWith("/index.ts")
            ? exported(f, original, seen)
            : { file: f, name: original };
      }
    }
  }
  if (
    new RegExp(
      "export\\s+(?:async\\s+)?(?:function|class|const|let|interface|type)\\s+" +
        name +
        "\\b",
    ).test(text) ||
    new RegExp("export\\s+const\\s*\\[[^\\]]*\\b" + name + "\\b").test(text)
  )
    return { file, name };
  for (const m of text.matchAll(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g)) {
    const f = resolveFile(path.resolve(path.dirname(file), m[1]));
    const r = f && exported(f, name, seen);
    if (r) return r;
  }
  return null;
}
export default defineConfig({
  plugins: [
    {
      name: "direct-upstream-imports",
      enforce: "pre",
      transform(code, id) {
        if (!/\.(vue|ts|js)$/.test(id) || id.includes("node_modules")) return;
        return code.replace(
          /import\s+(type\s+)?\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
          (all, type, names, spec) => {
            if (type) return all;
            let target = spec.startsWith("#ui/")
              ? path.join(base, "ui/src", spec.slice(4))
              : spec.startsWith(".")
                ? path.resolve(path.dirname(id), spec)
                : spec === "@modrinth/utils"
                  ? path.join(base, "utils")
                  : spec === "@modrinth/api-client"
                    ? path.join(base, "api-client/src")
                    : null;
            if (!target) return all;
            const file = resolveFile(target);
            if (!file || !file.endsWith("/index.ts")) return all;
            const pieces = names
              .split(",")
              .map((x: string) => x.trim())
              .filter(Boolean);
            const out = [];
            for (const piece of pieces) {
              if (piece.startsWith("type ")) continue;
              const [name, alias] = piece.split(/\s+as\s+/);
              const r = exported(file, name);
              if (!r) return all;
              out.push(
                r.name === "default"
                  ? `import ${alias || name} from '${r.file}'`
                  : `import { ${r.name}${r.name !== (alias || name) ? " as " + (alias || name) : ""} } from '${r.file}'`,
              );
            }
            return out.join("\n");
          },
        );
      },
    },
    vue(),
    svg({
      svgoConfig: {
        plugins: [
          {
            name: "preset-default",
            params: {
              overrides: {
                removeViewBox: false,
                cleanupIds: { minify: false },
              },
            },
          },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      "#ui": `${base}/ui/src`,
      "@modrinth/assets": `${base}/assets`,
      "@modrinth/utils": `${base}/utils/index.ts`,
      "@modrinth/api-client": `${base}/api-client/src/index.ts`,
    },
  },
  server: { proxy: { "/api": "http://127.0.0.1:3000" } },
  build: { outDir: "dist" },
  css: {
    preprocessorOptions: {
      scss: {
        silenceDeprecations: [
          "legacy-js-api",
          "import",
          "global-builtin",
          "color-functions",
        ],
      },
    },
  },
});
