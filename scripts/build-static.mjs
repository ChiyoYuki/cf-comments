import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/static/", import.meta.url);

await build({
  absWorkingDir: root,
  entryPoints: {
    "assets/v1/comments": "src/client/comments.ts",
    "admin/admin": "src/admin/admin.ts",
  },
  outdir: fileURLToPath(output),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome131", "firefox133", "safari18.4"],
  minify: true,
});

await build({
  absWorkingDir: root,
  entryPoints: {
    "assets/v1/comments": "src/client/comments.css",
    "admin/admin": "src/admin/admin.css",
  },
  outdir: fileURLToPath(output),
  bundle: true,
  minify: true,
});

await mkdir(new URL("admin/", output), { recursive: true });
await Promise.all([
  copyFile(
    new URL("../src/admin/index.html", import.meta.url),
    new URL("admin/index.html", output),
  ),
  copyFile(
    new URL("../src/admin/_headers", import.meta.url),
    new URL("_headers", output),
  ),
]);
