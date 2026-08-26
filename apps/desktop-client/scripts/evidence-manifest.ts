import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, stat, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve, sep } from "node:path";
import {
  qualityEvidenceManifestV1Schema,
  qualityEvidenceRelativePathV1Schema,
  sha256Schema,
  type QualityEvidenceManifestV1,
} from "../../../packages/shared/src/quality-evidence-contracts.ts";

type RawEvidenceFile = { path?: unknown; sha256?: unknown };
type RawGate = { evidenceFiles?: unknown };

export type EvidenceManifestCliOptions = {
  readonly inputPath: string;
  readonly outputPath?: string;
  readonly rootPath: string;
};

function usage(): string {
  return [
    "Usage: node --experimental-strip-types scripts/evidence-manifest.ts --input <manifest.json> [--output <manifest.json>] [--root <workspace>]",
    "",
    "The input may use sha256=\"auto\" for evidence files. All evidence paths are",
    "resolved below --root and are re-hashed before the strict manifest is emitted.",
  ].join("\n");
}

function parseArgs(argv: readonly string[]): EvidenceManifestCliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument?.startsWith("--")) throw new Error(`${usage()}\n\nUnexpected argument: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${usage()}\n\nMissing value for ${argument}`);
    values.set(argument.slice(2), value);
    index += 1;
  }

  const inputPath = values.get("input");
  if (!inputPath) throw new Error(usage());
  const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  return {
    inputPath: resolve(process.cwd(), inputPath),
    outputPath: values.has("output") ? resolve(process.cwd(), values.get("output") as string) : undefined,
    rootPath: resolve(process.cwd(), values.get("root") ?? scriptRoot),
  };
}

function digestBuffer(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function digestPath(path: string): Promise<string> {
  const info = await stat(path);
  if (info.isFile()) return digestBuffer(await readFile(path));
  if (!info.isDirectory()) throw new Error(`Evidence path is not a regular file or directory: ${path}`);

  const entries = await readdir(path, { withFileTypes: true });
  const chunks: Buffer[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = resolve(path, entry.name);
    const childDigest = await digestPath(child);
    chunks.push(Buffer.from(`${entry.name}\0${childDigest}\n`, "utf8"));
  }
  return digestBuffer(Buffer.concat(chunks));
}

function resolveEvidencePath(rootPath: string, value: unknown): string {
  const relativePath = qualityEvidenceRelativePathV1Schema.parse(value);
  const absolutePath = resolve(rootPath, relativePath);
  const relativeFromRoot = relative(rootPath, absolutePath);
  if (relativeFromRoot === "" || relativeFromRoot.startsWith(`..${sep}`) || relativeFromRoot === "..") {
    throw new Error(`Evidence path escapes root: ${relativePath}`);
  }
  return absolutePath;
}

function gitCommit(rootPath: string): string {
  try {
    const value = execFileSync("git", ["-C", rootPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (/^[a-f0-9]{7,64}$/.test(value)) return value;
  } catch {
    // The strict schema below reports the missing identity; no synthetic
    // commit is allowed in evidence.
  }
  throw new Error("Unable to resolve a git commit for the evidence root");
}

async function rehashEvidenceFiles(raw: Record<string, unknown>, rootPath: string): Promise<Record<string, unknown>> {
  const gates = raw.gates;
  if (!Array.isArray(gates)) return raw;

  const normalizedGates: RawGate[] = [];
  for (const gate of gates) {
    if (!gate || typeof gate !== "object") {
      normalizedGates.push(gate as RawGate);
      continue;
    }
    const candidate = gate as RawGate;
    if (!Array.isArray(candidate.evidenceFiles)) {
      normalizedGates.push(candidate);
      continue;
    }

    const evidenceFiles: RawEvidenceFile[] = [];
    for (const file of candidate.evidenceFiles as RawEvidenceFile[]) {
      if (!file || typeof file !== "object") {
        evidenceFiles.push(file);
        continue;
      }
      const absolutePath = resolveEvidencePath(rootPath, file.path);
      const actualDigest = await digestPath(absolutePath);
      if (file.sha256 !== undefined && file.sha256 !== "auto") {
        const expected = sha256Schema.parse(file.sha256);
        if (expected !== actualDigest) {
          throw new Error(`SHA-256 mismatch for ${String(file.path)}: expected ${expected}, got ${actualDigest}`);
        }
      }
      evidenceFiles.push({ path: file.path, sha256: actualDigest });
    }
    normalizedGates.push({ ...candidate, evidenceFiles });
  }

  const visualBaselines = Array.isArray(raw.visualBaselines) ? raw.visualBaselines : [];
  for (const baseline of visualBaselines) await stat(resolveEvidencePath(rootPath, baseline));
  return { ...raw, gates: normalizedGates };
}

export async function validateEvidenceManifest(options: EvidenceManifestCliOptions): Promise<QualityEvidenceManifestV1> {
  const raw = JSON.parse(await readFile(options.inputPath, "utf8")) as Record<string, unknown>;
  const withHashes = await rehashEvidenceFiles(raw, options.rootPath);
  return qualityEvidenceManifestV1Schema.parse({
    ...withHashes,
    environment: {
      ...(withHashes.environment as Record<string, unknown>),
      gitCommit: gitCommit(options.rootPath),
    },
  });
}

export async function runEvidenceManifestCli(options: EvidenceManifestCliOptions): Promise<QualityEvidenceManifestV1> {
  const manifest = await validateEvidenceManifest(options);
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  runEvidenceManifestCli(parseArgs(process.argv.slice(2))).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
