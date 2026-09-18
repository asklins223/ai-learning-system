import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const workspaceRoot = resolve(import.meta.dirname, "../../..");

function parseArguments(argv) {
  const result = { spec: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--spec") result.spec = argv[++index] ?? null;
  }
  if (!result.spec) throw new Error("Usage: node extract-room-scene-assets.mjs --spec <path>");
  return result;
}

function inside(root, candidate) {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let errorOutput = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { errorOutput += chunk; });
    child.on("error", rejectRun);
    child.on("close", (code) => code === 0
      ? resolveRun()
      : rejectRun(new Error(errorOutput || `${command} exited with ${code}`)));
  });
}

function pointInPolygon(x, y, polygon) {
  let insidePolygon = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [currentX, currentY] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    if ((currentY > y) !== (previousY > y)
      && x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX) {
      insidePolygon = !insidePolygon;
    }
  }
  return insidePolygon;
}

async function writeMask(path, width, height, polygons) {
  const pixels = Buffer.alloc(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (polygons.some((polygon) => pointInPolygon(x + 0.5, y + 0.5, polygon))) {
        pixels[y * width + x] = 255;
      }
    }
  }
  await writeFile(path, Buffer.concat([Buffer.from(`P5\n${width} ${height}\n255\n`), pixels]));
}

async function extractLayer(layer, sourceRoot, outputRoot, tempRoot) {
  if (!layer || typeof layer !== "object" || typeof layer.id !== "string") throw new Error("Every layer needs an id");
  if (typeof layer.source !== "string" || typeof layer.output !== "string") throw new Error(`${layer.id} needs source and output`);
  const source = resolve(sourceRoot, layer.source);
  const output = resolve(outputRoot, layer.output);
  if (!inside(sourceRoot, source) || !inside(outputRoot, output)) throw new Error(`${layer.id} escapes its declared root`);
  const crop = layer.crop ?? { x: 0, y: 0, width: layer.sourceSize?.width, height: layer.sourceSize?.height };
  const width = positiveInteger(crop.width, `${layer.id}.crop.width`);
  const height = positiveInteger(crop.height, `${layer.id}.crop.height`);
  const x = Number.isInteger(crop.x) && crop.x >= 0 ? crop.x : 0;
  const y = Number.isInteger(crop.y) && crop.y >= 0 ? crop.y : 0;
  const outputWidth = positiveInteger(layer.outputSize?.width ?? width, `${layer.id}.outputSize.width`);
  const outputHeight = positiveInteger(layer.outputSize?.height ?? height, `${layer.id}.outputSize.height`);
  await mkdir(dirname(output), { recursive: true });

  const cropFilter = `crop=${width}:${height}:${x}:${y}`;
  const scaleFilter = outputWidth === width && outputHeight === height
    ? ""
    : `,scale=${outputWidth}:${outputHeight}:flags=lanczos`;
  if (!Array.isArray(layer.maskPolygons) || layer.maskPolygons.length === 0) {
    await run("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y", "-i", source,
      "-vf", `${cropFilter}${scaleFilter},format=rgba`, "-frames:v", "1", output,
    ]);
    return;
  }

  const maskPath = resolve(tempRoot, `${layer.id}.pgm`);
  await writeMask(maskPath, width, height, layer.maskPolygons);
  await run("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-i", source, "-i", maskPath,
    "-filter_complex",
    `[0:v]${cropFilter}${scaleFilter},format=rgba[color];[1:v]format=gray${scaleFilter}[alpha];[color][alpha]alphamerge,format=rgba[out]`,
    "-map", "[out]", "-frames:v", "1", output,
  ]);
}

export async function extractRoomSceneAssets(specPath) {
  const absoluteSpec = resolve(workspaceRoot, specPath);
  if (!inside(workspaceRoot, absoluteSpec)) throw new Error("Spec must stay inside the workspace");
  const spec = JSON.parse(await readFile(absoluteSpec, "utf8"));
  const sourceRoot = resolve(workspaceRoot, spec.sourceRoot ?? ".");
  const outputRoot = resolve(workspaceRoot, spec.outputRoot ?? ".");
  if (!inside(workspaceRoot, sourceRoot) || !inside(workspaceRoot, outputRoot)) throw new Error("Roots must stay inside the workspace");
  const layers = Array.isArray(spec.layers)
    ? spec.layers
    : Object.entries(spec.timeSources ?? {}).flatMap(([time, sources]) => (
        (spec.layerTemplates ?? []).map((template) => ({
          ...template,
          id: template.id.replaceAll("{time}", time),
          source: sources[template.sourceKey],
          output: template.output.replaceAll("{time}", time),
        }))
      ));
  if (!layers.length) throw new Error("Spec must declare layers or timeSources plus layerTemplates");
  const tempRoot = await mkdtemp(resolve(tmpdir(), "ailearn-room-assets-"));
  try {
    for (const layer of layers) await extractLayer(layer, sourceRoot, outputRoot, tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  return { outputRoot, count: layers.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const { spec } = parseArguments(process.argv.slice(2));
  const result = await extractRoomSceneAssets(spec);
  console.log(`Extracted ${result.count} room assets into ${result.outputRoot}`);
}
