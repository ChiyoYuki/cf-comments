import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  convertWalineToCanonical,
  type WalineExportPayload,
} from "../src/importers/waline.ts";
import { sha256Hex } from "../src/shared/id.ts";
import type {
  AdminAvatarBackfillItem,
  AdminAvatarBackfillReport,
} from "../src/shared/types.ts";
import {
  readWalineSourceOption,
  type WalineSourceOptions,
} from "./lib/waline-options.ts";

interface CliOptions extends WalineSourceOptions {
  apiBase?: string;
  tokenFile?: string;
  apply: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const source: WalineSourceOptions = { input: "", skipPaths: [] };
  let apiBase: string | undefined;
  let tokenFile: string | undefined;
  let apply = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg) continue;
    const consumed = readWalineSourceOption(argv, i, source);
    if (consumed !== undefined) {
      i = consumed;
      continue;
    }
    if (arg === "--api-base" && argv[i + 1]) {
      apiBase = argv[++i];
    } else if (arg.startsWith("--api-base=")) {
      apiBase = arg.slice("--api-base=".length);
    } else if (arg === "--token-file" && argv[i + 1]) {
      tokenFile = argv[++i];
    } else if (arg.startsWith("--token-file=")) {
      tokenFile = arg.slice("--token-file=".length);
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--dry-run") {
      apply = false;
    }
  }

  if (!source.input) {
    console.error(
      "Usage: pnpm run backfill:waline-avatars -- --input <waline.json> [--skip-paths=/] [--api-base <https://comments.example.com>] [--token-file <.dev.vars.prod>] [--dry-run | --apply]",
    );
    process.exit(1);
  }

  return { ...source, apiBase, tokenFile, apply };
}

async function resolveAdminToken(tokenFile?: string): Promise<string> {
  if (tokenFile) {
    const raw = await readFile(path.resolve(tokenFile), "utf8");
    const match = raw.match(/^ADMIN_TOKEN=(.+)$/m);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
    throw new Error(`ADMIN_TOKEN not found in ${tokenFile}`);
  }
  const envToken = process.env.ADMIN_TOKEN?.trim();
  if (envToken) {
    return envToken;
  }
  throw new Error(
    "Missing admin token: pass --token-file <.dev.vars> or set ADMIN_TOKEN.",
  );
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rawJson = await readFile(path.resolve(opts.input), "utf8");
  const waline = JSON.parse(rawJson) as WalineExportPayload;

  // Convert in memory with includePrivate=true strictly to hash emails locally;
  // raw emails are never persisted or transmitted.
  const result = convertWalineToCanonical(waline, {
    includePrivate: true,
    skipPaths: opts.skipPaths,
  });

  let noEmail = 0;
  let publicWithEmail = 0;
  let nonPublicWithEmail = 0;
  const items: AdminAvatarBackfillItem[] = [];

  for (const c of result.canonical.comments) {
    if (!c.author_email) {
      noEmail++;
      continue;
    }
    if (!c.source) {
      continue;
    }
    if (c.status === "approved") {
      publicWithEmail++;
    } else {
      nonPublicWithEmail++;
    }
    const avatarHash = await sha256Hex(c.author_email);
    items.push({
      import_source: c.source.system,
      import_external_id: c.source.external_id,
      avatar_hash: avatarHash,
    });
  }

  console.log("=== Waline Avatar Hash Backfill Summary ===");
  console.log(
    "Local:",
    JSON.stringify({
      source_total: result.stats.source_total,
      skipped_by_path: result.stats.skipped_by_path,
      candidates: result.stats.converted,
      no_email: noEmail,
      with_valid_email: items.length,
      public_with_email: publicWithEmail,
      non_public_with_email: nonPublicWithEmail,
    }),
  );

  if (!opts.apiBase) {
    console.log("Dry local inspection only (pass --api-base to query Worker).");
    return;
  }

  const token = await resolveAdminToken(opts.tokenFile);
  const dryRun = !opts.apply;
  const endpoint = `${opts.apiBase.replace(/\/$/, "")}/v1/admin/avatars/backfill?dry_run=${dryRun ? "true" : "false"}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ items }),
  });

  const text = await response.text();
  if (!response.ok) {
    console.error(`Worker returned HTTP ${response.status}: ${text}`);
    process.exit(1);
  }

  const report = JSON.parse(text) as AdminAvatarBackfillReport;
  console.log("Server:", JSON.stringify(report));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
