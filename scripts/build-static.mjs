import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { icons as simpleIcons } from "@iconify-json/simple-icons";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = new URL("../dist/static/", import.meta.url);

function simpleIconPath(name) {
  const path = simpleIcons.icons[name]?.body.match(
    /^<path fill="currentColor" d="([^"]+)"\s*\/>$/,
  )?.[1];
  if (!path) throw new Error(`Unexpected Simple Icons SVG: ${name}`);
  return path;
}

await build({
  absWorkingDir: root,
  entryPoints: {
    "assets/v1/comments": "src/client/comments.ts",
    "assets/v1/preview": "src/client/preview.ts",
    "admin/admin": "src/admin/admin.ts",
  },
  outdir: fileURLToPath(output),
  bundle: true,
  format: "esm",
  platform: "browser",
  define: {
    SIMPLE_SYNTAX_ICONS: JSON.stringify({
      gfm: simpleIconPath("github"),
      mfm: simpleIconPath("misskey"),
    }),
  },
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
