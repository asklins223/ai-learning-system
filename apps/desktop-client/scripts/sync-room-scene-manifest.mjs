import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function replaceTime(value, time) {
  return value.replaceAll("{time}", time).replaceAll("{TIME}", time.toUpperCase());
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

async function hash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function syncRoomSceneManifest(specPath) {
  const specAbsolute = resolve(workspaceRoot, specPath);
  if (!inside(workspaceRoot, specAbsolute)) throw new Error("Spec must stay inside the workspace");
  const spec = JSON.parse(await readFile(specAbsolute, "utf8"));
  if (!spec.manifest || !spec.timeSources || !Array.isArray(spec.layerTemplates)) {
    throw new Error("Spec needs manifest, timeSources, and layerTemplates");
  }
  const manifestAbsolute = resolve(workspaceRoot, spec.manifest.path);
  const outputRoot = resolve(workspaceRoot, spec.outputRoot);
  if (!inside(workspaceRoot, manifestAbsolute) || !inside(workspaceRoot, outputRoot)) {
    throw new Error("Manifest and output roots must stay inside the workspace");
  }
  const manifest = JSON.parse(await readFile(manifestAbsolute, "utf8"));
  const times = Object.keys(spec.timeSources);
  const posters = {};
  const roomLayers = [];

  for (const time of times) {
    const posterPath = `${spec.manifest.posterPrefix}/lighthouse-${time}-poster-v1.png`;
    const posterAbsolute = resolve(manifestAbsolute, "..", posterPath);
    posters[time] = {
      id: `STATIC-HOME-V2-LIGHTHOUSE-${time.toUpperCase()}-01`,
      path: posterPath,
      width: 1672,
      height: 941,
      sha256: await hash(posterAbsolute),
      reviewStatus: spec.manifest.reviewStatus,
    };

    for (const template of spec.layerTemplates) {
      const output = replaceTime(template.output, time);
      const path = `${spec.manifest.runtimeAssetPrefix}/${output}`;
      const outputAbsolute = resolve(outputRoot, output);
      const sourceSize = template.outputSize
        ?? (template.crop ? { width: template.crop.width, height: template.crop.height } : template.sourceSize);
      if (!sourceSize) throw new Error(`${template.id} has no output dimensions`);
      roomLayers.push({
        assetId: replaceTime(template.assetId, time),
        path,
        theme: time,
        depth: template.depth,
        order: template.order,
        anchorId: null,
        sourceSize,
        registration: template.registration,
        alphaMode: "straight-rgba",
        sha256: await hash(outputAbsolute),
        sourcePath: posterPath,
        promptPath: spec.manifest.promptPath,
        license: spec.manifest.license,
        reviewStatus: spec.manifest.reviewStatus,
        releaseApproval: spec.manifest.releaseApproval,
      });
    }
  }

  manifest.homeV2Posters = posters;
  manifest.roomLayers = roomLayers;
  await writeFile(manifestAbsolute, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest: manifestAbsolute, posters: times.length, layers: roomLayers.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const spec = argument("--spec");
  if (!spec) throw new Error("Usage: node sync-room-scene-manifest.mjs --spec <path>");
  const result = await syncRoomSceneManifest(spec);
  console.log(`Registered ${result.posters} posters and ${result.layers} room layers in ${result.manifest}`);
}
