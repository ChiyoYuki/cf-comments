import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig } from "../src/config/load-config.ts";
import { validateCanonicalExport } from "../src/importers/canonical.ts";
import {
  convertWalineToCanonical,
  type WalineExportPayload,
} from "../src/importers/waline.ts";

interface CliOptions {
  input: string;
  out?: string;
  skipPaths: string[];
  includePrivate: boolean;
  siteUrl?: string;
  dryRun: boolean;
  configPath?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let input = "";
  let out: string | undefined;
  const skipPaths: string[] = [];
  let includePrivate = false;
  let siteUrl: string | undefined;
  let dryRun = false;
  let configPath: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    if (arg === "--input" && argv[i + 1]) {
      input = argv[++i] ?? "";
    } else if (arg.startsWith("--input=")) {
      input = arg.slice("--input=".length);
    } else if (arg === "--out" && argv[i + 1]) {
      out = argv[++i];
    } else if (arg.startsWith("--out=")) {
      out = arg.slice("--out=".length);
    } else if (arg === "--skip-paths" && argv[i + 1]) {
      skipPaths.push(
        ...(argv[++i] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith("--skip-paths=")) {
      skipPaths.push(
        ...arg
          .slice("--skip-paths=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg === "--include-private") {
      includePrivate = true;
    } else if (arg === "--site" && argv[i + 1]) {
      siteUrl = argv[++i];
    } else if (arg.startsWith("--site=")) {
      siteUrl = arg.slice("--site=".length);
    } else if (arg === "--config" && argv[i + 1]) {
      configPath = argv[++i];
    } else if (arg.startsWith("--config=")) {
      configPath = arg.slice("--config=".length);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (!arg.startsWith("--") && !input) {
      input = arg;
    }
  }

  if (!input) {
    console.error(
      "Usage: pnpm run import:waline -- --input <waline.json> [--config <cf-comments.config.json>] [--site <url>] [--skip-paths=/] [--include-private] [--out <canonical.json>] [--dry-run]",
    );
    process.exit(1);
  }

  return { input, out, skipPaths, includePrivate, siteUrl, dryRun, configPath };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const projectConfig = loadProjectConfig(opts.configPath);
  const resolvedSiteUrl =
    opts.siteUrl ??
    (projectConfig.siteUrl !== "https://example.com"
      ? projectConfig.siteUrl
      : undefined);

  const rawText = await readFile(path.resolve(opts.input), "utf8");
  const waline = JSON.parse(rawText) as WalineExportPayload;

  const result = convertWalineToCanonical(waline, {
    includePrivate: opts.includePrivate,
    skipPaths: opts.skipPaths,
    ...(resolvedSiteUrl ? { siteUrl: resolvedSiteUrl } : {}),
  });

  if (result.errors.length > 0) {
    console.error("Conversion errors:");
    for (const err of result.errors) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  // Validate against strict canonical rules before writing
  validateCanonicalExport(result.canonical);

  const byPath = new Map<string, number>();
  const byStatus = new Map<string, number>();
  for (const c of result.canonical.comments) {
    byPath.set(c.path, (byPath.get(c.path) ?? 0) + 1);
    byStatus.set(c.status, (byStatus.get(c.status) ?? 0) + 1);
  }

  console.log("=== Waline -> cf-comments Reconciliation Report ===");
  console.log("Stats:", JSON.stringify(result.stats));
  console.log("Statuses:", JSON.stringify(Object.fromEntries(byStatus)));
  console.log(
    "Paths:",
    JSON.stringify(Object.fromEntries([...byPath.entries()].sort())),
  );
  if (result.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of result.warnings) {
      console.log(`  - ${w}`);
    }
  }

  if (!opts.dryRun && opts.out) {
    await writeFile(
      path.resolve(opts.out),
      `${JSON.stringify(result.canonical, null, 2)}\n`,
      "utf8",
    );
    console.log(`Wrote canonical JSON to ${opts.out}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
