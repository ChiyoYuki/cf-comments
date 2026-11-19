import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanBuildOutputDir,
  getWorkerBundleDir,
  readBuildOutput,
  writeAssets,
  writeRootConfig,
  writeWorkerConfig,
} from "@cloudflare/build-output-utils";
import { loadAndParseConfig } from "@cloudflare/config";
import { build as esbuild } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

function parseMode(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === "--mode" || arg === "-m") && argv[i + 1]) {
      return argv[i + 1];
    }
    if (arg?.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }
  return undefined;
}

async function main() {
  const mode = parseMode(process.argv.slice(2));
  const buildContext = {
    isPreview: process.env.CLOUDFLARE_PREVIEW_BUILD === "true",
    mode,
  };

  const configPath = path.join(root, "cloudflare.config.ts");
  const loaded = await loadAndParseConfig(configPath, buildContext);
  if (!loaded.result.success) {
    console.error("Invalid cloudflare.config.ts:", loaded.result.error.issues);
    process.exit(1);
  }

  const { worker, settings } = loaded.result.data;
  if (!worker) {
    throw new Error("cloudflare.config.ts must define a worker.");
  }

  await cleanBuildOutputDir(root);
  const bundleDir = getWorkerBundleDir(root);
  await mkdir(bundleDir, { recursive: true });

  const entrypoint = path.resolve(
    root,
    typeof worker.entrypoint === "string"
      ? worker.entrypoint
      : "./src/worker/index.ts",
  );

  await esbuild({
    entryPoints: [entrypoint],
    outfile: path.join(bundleDir, "index.js"),
    bundle: true,
    format: "esm",
    target: "es2024",
    platform: "neutral",
    mainFields: ["worker", "browser", "module", "main"],
    conditions: ["workerd", "worker", "browser", "import"],
    external: ["cloudflare:*"],
    sourcemap: true,
    minify: mode !== "development",
  });

  const staticDir = path.join(root, "dist", "static");
  if (existsSync(staticDir)) {
    await writeAssets({ root, sourceDirectory: staticDir });
    console.log("Bundled static assets from dist/static/");
  } else {
    console.log(
      "Note: dist/static/ not found yet; building Worker bundle without static assets.",
    );
  }

  await writeRootConfig(root, settings, buildContext);
  await writeWorkerConfig({
    root,
    config: worker,
    manifest: {
      type: "complete",
      mainModule: "index.js",
      modules: {
        "index.js": { type: "esm" },
        "index.js.map": { type: "sourcemap" },
      },
    },
  });

  // Verify the generated Build Output tree passes Cloudflare's own validator
  const verified = await readBuildOutput(root);
  console.log(
    `Build Output ready (version=${verified.version}, worker=${verified.workers.default.config.name}, mode=${mode ?? "default"}, assets=${Boolean(verified.workers.default.assetsDir)})`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
