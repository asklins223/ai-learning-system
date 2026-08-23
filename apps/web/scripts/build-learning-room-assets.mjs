import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsVolume, KHRMeshQuantization } from "@gltf-transform/extensions";
import { prune } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";

const webRoot = resolve(import.meta.dirname, "..");
const workspaceRoot = resolve(webRoot, "..", "..");
const sourceRoot = join(workspaceRoot, "docs/design/assets");
const modelRoot = join(sourceRoot, "3d-reference/3d模型");
const staticRoot = join(sourceRoot, "static");
const runtimeRoot = join(webRoot, "public/assets/3d/learning-room/v1");
const referenceRoot = join(sourceRoot, "3d-reference");
const gltfCli = join(webRoot, "node_modules/.bin/gltf-transform");

const io = new NodeIO()
  .registerExtensions([EXTMeshoptCompression, EXTTextureWebP, KHRMaterialsVolume, KHRMeshQuantization])
  .registerDependencies({ "meshopt.decoder": MeshoptDecoder, "meshopt.encoder": MeshoptEncoder });

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

function writeJson(path, value) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args) {
  execFileSync(command, args, { cwd: webRoot, stdio: "inherit" });
}

function fileHash(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mimeFor(path) {
  if (path.endsWith(".glb")) return "model/gltf-binary";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

async function fileEntry(relativePath, options = {}) {
  const absolutePath = join(runtimeRoot, relativePath);
  const stat = statSync(absolutePath);
  const entry = {
    path: relativePath,
    mimeType: mimeFor(relativePath),
    bytes: stat.size,
    sha256: fileHash(absolutePath),
    loadGroup: options.loadGroup ?? "scene",
    preload: options.preload ?? false,
  };

  if (relativePath.endsWith(".webp")) {
    const metadata = await sharp(absolutePath).metadata();
    entry.width = metadata.width;
    entry.height = metadata.height;
    entry.colorSpace = "srgb";
    entry.alphaMode = metadata.hasAlpha ? "BLEND" : "OPAQUE";
    if (options.safeArea) entry.safeArea = options.safeArea;
    if (options.cropAnchor) entry.cropAnchor = options.cropAnchor;
    if (options.themePair) entry.themePair = options.themePair;
    if (options.registrationAnchors) entry.registrationAnchors = options.registrationAnchors;
  }

  return entry;
}

function addAnchor(document, root, name, translation = [0, 0, 0]) {
  const node = document.createNode(name).setTranslation(translation);
  root.addChild(node);
}

async function applySemanticNames(path, spec) {
  const document = await io.read(path);
  const nodes = document.getRoot().listNodes();
  const root = nodes.find((node) => /root/i.test(node.getName())) ?? nodes[0];
  if (root) root.setName(spec.rootName);

  const meshNode = nodes.find((node) => node.getMesh());
  if (meshNode && spec.meshName) meshNode.setName(spec.meshName);

  if (root) {
    for (const anchor of spec.anchors ?? []) addAnchor(document, root, anchor.name, anchor.translation);
  }

  await io.write(path, document);
}

function boxGeometry(document, buffer, name, min, max, material) {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const faces = [
    { normal: [0, 0, 1], corners: [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]] },
    { normal: [0, 0, -1], corners: [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]] },
    { normal: [-1, 0, 0], corners: [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]] },
    { normal: [1, 0, 0], corners: [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]] },
    { normal: [0, 1, 0], corners: [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]] },
    { normal: [0, -1, 0], corners: [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    const base = faceIndex * 4;
    face.corners.forEach((corner, cornerIndex) => {
      positions.push(...corner);
      normals.push(...face.normal);
      uvs.push(cornerIndex === 1 || cornerIndex === 2 ? 1 : 0, cornerIndex >= 2 ? 1 : 0);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const primitive = document.createPrimitive()
    .setAttribute("POSITION", document.createAccessor(`${name}_POSITION`).setBuffer(buffer).setType("VEC3").setArray(new Float32Array(positions)))
    .setAttribute("NORMAL", document.createAccessor(`${name}_NORMAL`).setBuffer(buffer).setType("VEC3").setArray(new Float32Array(normals)))
    .setAttribute("TEXCOORD_0", document.createAccessor(`${name}_UV`).setBuffer(buffer).setType("VEC2").setArray(new Float32Array(uvs)))
    .setIndices(document.createAccessor(`${name}_INDICES`).setBuffer(buffer).setType("SCALAR").setArray(new Uint16Array(indices)))
    .setMaterial(material);
  const mesh = document.createMesh(name).addPrimitive(primitive);
  const node = document.createNode(name).setMesh(mesh);
  return node;
}

async function createRoomShell(path, lod) {
  const document = new Document();
  const buffer = document.createBuffer("ROOM_SHELL_BUFFER");
  const scene = document.createScene("Scene_P0");
  const root = document.createNode("ROOT_RoomShell");
  scene.addChild(root);

  const floorMaterials = [
    document.createMaterial("MAT_WarmOak_A").setBaseColorFactor([0.9, 0.68, 0.42, 1]).setEmissiveFactor([0.04, 0.025, 0.01]).setRoughnessFactor(0.78),
    document.createMaterial("MAT_WarmOak_B").setBaseColorFactor([1, 0.82, 0.56, 1]).setEmissiveFactor([0.04, 0.025, 0.01]).setRoughnessFactor(0.78),
    document.createMaterial("MAT_WarmOak_C").setBaseColorFactor([0.82, 0.58, 0.3, 1]).setEmissiveFactor([0.04, 0.025, 0.01]).setRoughnessFactor(0.8),
  ];
  const floorMaterial = floorMaterials[0];
  const wallMaterial = document.createMaterial("MAT_WarmPlaster")
    .setBaseColorFactor([0.92, 0.82, 0.68, 1])
    .setEmissiveFactor([0.22, 0.16, 0.09])
    .setRoughnessFactor(0.88)
    .setDoubleSided(true);
  const trimMaterial = document.createMaterial("MAT_OakTrim").setBaseColorFactor([0.36, 0.16, 0.07, 1]).setRoughnessFactor(0.62);
  const glassMaterial = document.createMaterial("MAT_WindowGlass").setBaseColorFactor([0.25, 0.46, 0.55, 0.42]).setMetallicFactor(0.05).setRoughnessFactor(0.18).setAlphaMode("BLEND");
  const skyMaterial = document.createMaterial("MAT_WindowSky").setBaseColorFactor([0.48, 0.72, 0.82, 1]).setEmissiveFactor([0.18, 0.3, 0.4]).setRoughnessFactor(0.95);

  const add = (name, min, max, material) => root.addChild(boxGeometry(document, buffer, name, min, max, material));

  add("MESH_Floor", [-4, -0.08, -3], [4, 0, 3], floorMaterial);

  if (lod === 0) {
    const boardDepth = 0.34;
    const boardLength = 1.24;
    let boardIndex = 0;
    for (let row = 0; row < Math.ceil(6 / boardDepth); row += 1) {
      const z0 = -3 + row * boardDepth + 0.012;
      const z1 = Math.min(3, z0 + boardDepth - 0.018);
      const offset = row % 2 === 0 ? 0 : boardLength * 0.5;
      for (let x0 = -4 + offset; x0 < 4; x0 += boardLength) {
        const start = Math.max(-4, x0 + 0.008);
        const end = Math.min(4, x0 + boardLength - 0.008);
        if (end - start < 0.18) continue;
        add(`MESH_FloorBoard_${boardIndex}`, [start, 0.002, z0], [end, 0.018, z1], floorMaterials[boardIndex % floorMaterials.length]);
        boardIndex += 1;
      }
    }
  } else if (lod === 1) {
    for (let row = 0; row < 6; row += 1) {
      const z0 = -3 + row * 0.98 + 0.012;
      add(`MESH_FloorBoard_L1_${row}`, [-4, 0.002, z0], [4, 0.018, Math.min(3, z0 + 0.94)], floorMaterials[row % floorMaterials.length]);
    }
  }

  // The canonical image is a corner view: the back wall is plain and the
  // window sits on the right wall, so the floor remains the main visual field.
  add("MESH_BackWall", [-4, 0, -3.08], [4, 3.4, -2.92], wallMaterial);
  if (lod <= 1) add("MESH_LeftWall", [-4, 0, -3], [-3.84, 3.4, 3], wallMaterial);

  const windowZ0 = -2.18;
  const windowZ1 = -0.38;
  const windowBottom = 0.72;
  const windowTop = 2.68;

  if (lod <= 1) {
    add("MESH_RightWallLower", [3.84, 0, -3], [4, windowBottom, 3], wallMaterial);
    add("MESH_RightWallUpper", [3.84, windowTop, -3], [4, 3.4, 3], wallMaterial);
    add("MESH_RightWallFront", [3.84, windowBottom, windowZ1], [4, windowTop, 3], wallMaterial);
    add("MESH_RightWallBack", [3.84, windowBottom, -3], [4, windowTop, windowZ0], wallMaterial);
    add("MESH_WindowSky", [3.865, windowBottom + 0.03, windowZ0 + 0.03], [3.89, windowTop - 0.03, windowZ1 - 0.03], skyMaterial);
    add("MESH_WindowReveal", [3.79, windowBottom, windowZ0], [3.82, windowTop, windowZ1], glassMaterial);
    add("MESH_WindowFrameBack", [3.62, windowBottom - 0.08, windowZ0 - 0.08], [4.02, windowTop + 0.08, windowZ0], trimMaterial);
    add("MESH_WindowFrameFront", [3.62, windowBottom - 0.08, windowZ1], [4.02, windowTop + 0.08, windowZ1 + 0.08], trimMaterial);
    add("MESH_WindowFrameTop", [3.62, windowTop, windowZ0], [4.02, windowTop + 0.08, windowZ1], trimMaterial);
    add("MESH_WindowFrameBottom", [3.62, windowBottom - 0.08, windowZ0], [4.02, windowBottom, windowZ1], trimMaterial);
    add("MESH_WindowMullion", [3.62, windowBottom, (windowZ0 + windowZ1) / 2 - 0.035], [4.02, windowTop, (windowZ0 + windowZ1) / 2 + 0.035], trimMaterial);
    add("MESH_WindowSill", [3.4, windowBottom - 0.22, windowZ0 - 0.22], [4.06, windowBottom, windowZ1 + 0.22], trimMaterial);
  }

  if (lod === 0) {
    add("MESH_TrimBack", [-3.84, 0.02, -2.9], [3.84, 0.16, -2.74], trimMaterial);
    add("MESH_TrimLeft", [-3.84, 0.02, -2.74], [-3.68, 0.16, 2.74], trimMaterial);
    add("MESH_TrimRight", [3.68, 0.02, -2.74], [3.84, 0.16, 2.74], trimMaterial);
  }

  addAnchor(document, root, "ANCHOR_Desk", [0, 0.02, 0.15]);
  addAnchor(document, root, "ANCHOR_Window", [3.78, 1.7, (windowZ0 + windowZ1) / 2]);
  addAnchor(document, root, "ANCHOR_Shelf", [-3.1, 0.02, -2.15]);
  addAnchor(document, root, "ANCHOR_Companion", [2.05, 0.02, 0.55]);
  addAnchor(document, root, "HOTSPOT_RoomOverview", [2.8, 1.2, -2.3]);
  addAnchor(document, root, "COLLIDER_RoomBounds", [0, 1.7, 0]);

  await new NodeIO().write(path, document);
}

async function createRoomReferences() {
  // Documentation-only diagrams. They are never imported as runtime materials;
  // the approved room image remains the canonical visual backplate.
  const partsRoot = join(referenceRoot, "parts");
  ensureDir(partsRoot);
  const common = `font-family="Noto Serif SC, Songti SC, serif" fill="#432615"`;
  const layoutSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#f4ecdf"/><g ${common}><text x="90" y="90" font-size="42">理解书房 · P0 房间布局 / 固定相机基准</text><rect x="180" y="180" width="980" height="510" rx="8" fill="#d9b983" stroke="#70401f" stroke-width="8"/><rect x="390" y="255" width="560" height="160" fill="#78a5b0" stroke="#70401f" stroke-width="8"/><rect x="500" y="485" width="340" height="130" fill="#8b552d" stroke="#432615" stroke-width="8"/><circle cx="1020" cy="535" r="42" fill="#7db9c4" stroke="#70401f" stroke-width="8"/><text x="1160" y="260" font-size="28">房间：8m × 6m × 3.4m</text><text x="1160" y="320" font-size="28">窗洞：3.1m × 1.96m</text><text x="1160" y="380" font-size="28">桌面 anchor：中央偏前</text><text x="1160" y="440" font-size="28">人物 anchor：桌面右后</text><text x="1160" y="500" font-size="28">固定预设：room-overview</text><text x="1160" y="560" font-size="28">单位：米 / Y-up / 右手坐标</text></g></svg>`;
  const shellSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900"><rect width="1600" height="900" fill="#f4ecdf"/><g ${common}><text x="90" y="90" font-size="42">room-shell · canonical corner view</text><path d="M150 650L650 520L1130 615L565 760Z" fill="#c98a4e" stroke="#70401f" stroke-width="10"/><path d="M150 650V230L565 315V760Z" fill="#ead8b6" stroke="#70401f" stroke-width="10"/><path d="M565 315L1130 220V615L565 760Z" fill="#e4cda8" stroke="#70401f" stroke-width="10"/><path d="M625 350L1010 285L1010 475L625 535Z" fill="#7fb7c8" stroke="#70401f" stroke-width="12"/><path d="M817 318L817 505" stroke="#70401f" stroke-width="12"/><path d="M620 540L1040 470" stroke="#8b552d" stroke-width="18"/><path d="M190 640L620 530M230 662L660 552M270 684L700 574M310 706L740 596" stroke="#e0aa6f" stroke-width="8" opacity=".9"/><text x="1210" y="280" font-size="28">以 room-empty-day-v2 为视觉基准</text><text x="1210" y="340" font-size="28">浅木地板 / 暖米白墙面</text><text x="1210" y="400" font-size="28">右侧墙窗，不做居中后墙窗</text><text x="1210" y="460" font-size="28">LOD0：窗框、窗台、固定 trim</text><text x="1210" y="520" font-size="28">LOD1：主要墙体与简化地板</text><text x="1210" y="580" font-size="28">LOD2：地面、后墙、窗洞</text><text x="1210" y="640" font-size="28">不包含家具与人物</text><text x="1210" y="700" font-size="28">交互由 anchor / hotspot 提供</text></g></svg>`;
  await sharp(Buffer.from(layoutSvg)).png().toFile(join(partsRoot, "room-layout-scale-camera-v1.png"));
  await sharp(Buffer.from(shellSvg)).png().toFile(join(partsRoot, "room-shell-v1.png"));
}

const modelSpecs = [
  { id: "P0-DESK-01", source: "木质办公桌3d模型.glb", stem: "desk", lods: 2, rootName: "ROOT_Desk", anchors: [{ name: "ANCHOR_Drawer", translation: [0, 0.28, 0.45] }], reference: "REF-DESK-01", fallback: "FB-DESK-01", loadGroup: "scene", preload: true },
  { id: "P0-LAMP-01", source: "桌灯3d模型.glb", stem: "lamp", lods: 2, rootName: "ROOT_Lamp", anchors: [{ name: "PIVOT_LampSwitch", translation: [0, 0.4, 0] }, { name: "ANCHOR_LampGlow", translation: [0, 0.9, 0] }], reference: "REF-LAMP-01", fallback: "FB-THEME-01", loadGroup: "scene", preload: true },
  { id: "P0-WINDOW-01", source: "木质窗户3d模型.glb", stem: "window", lods: 2, rootName: "ROOT_Window", anchors: [{ name: "PIVOT_WindowSash", translation: [0, 0.9, 0] }, { name: "HOTSPOT_Window", translation: [0, 0.9, 0] }], reference: "REF-WINDOW-01", fallback: "FB-ROOM-01", loadGroup: "scene", preload: false },
  { id: "P0-SHELF-01", source: "木质书架.glb", stem: "bookshelf", lods: 3, rootName: "ROOT_Shelf", anchors: [{ name: "ANCHOR_ShelfContent", translation: [0, 1, 0] }], reference: "REF-SHELF-01", fallback: "FB-SHELF-01", loadGroup: "scene", preload: false },
  { id: "P0-NOTEBOOK-01", source: "笔记本3d模型-2.glb", stem: "notebook-looseleaf", lods: 2, rootName: "ROOT_Notebook", meshName: "MESH_NotebookShell", anchors: [{ name: "PIVOT_NotebookCover", translation: [0, 0, 0] }, { name: "HOTSPOT_Notebook", translation: [0, 0.12, 0] }, { name: "ANCHOR_NotebookContent", translation: [0, 0.08, 0] }], reference: "REF-NOTEBOOK-01", fallback: "FB-NOTE-01", loadGroup: "workflow", preload: false },
  { id: "P0-ORB-01", source: "蓝色星球3d模型-3.glb", stem: "companion-orb", lods: 2, rootName: "ROOT_Orb", meshName: "MESH_OrbCore", anchors: [{ name: "MESH_OrbRing", translation: [0, 0, 0] }, { name: "FX_OrbGlow", translation: [0, 0, 0] }, { name: "ANCHOR_OrbFocus", translation: [0, 0, 0] }], reference: "REF-ORB-01", fallback: "FB-ORB-01", loadGroup: "character", preload: false },
  { id: "P0-HUMANOID-01", source: "伴星角色.glb", stem: "companion-humanoid", lods: 2, rootName: "ROOT_CompanionHumanoid", meshName: "MESH_CompanionBody", anchors: [{ name: "RIG_Companion", translation: [0, 0, 0] }, { name: "ANCHOR_CompanionFocus", translation: [0, 1.2, 0] }, { name: "ANCHOR_CompanionFX", translation: [0, 1, 0] }], reference: "REF-HUMANOID-01", fallback: "FB-ORB-01", loadGroup: "character", preload: false, character: true },
  { id: "P0-CARD-BOX-01", source: "木制卡片盒3d模型-2.glb", stem: "card-box", lods: 2, rootName: "ROOT_CardBox", anchors: [{ name: "PIVOT_CardBoxLid", translation: [0, 0.2, 0] }, { name: "HOTSPOT_CardBox", translation: [0, 0.15, 0] }], reference: "REF-CARD-BOX-01", fallback: "FB-CARD-01", loadGroup: "workflow", preload: false },
  { id: "P0-CALENDAR-01", source: "木质日历3d模型-2.glb", stem: "review-calendar", lods: 2, rootName: "ROOT_ReviewCalendar", anchors: [{ name: "ANCHOR_CalendarPage", translation: [0, 0.4, 0] }], reference: "REF-CALENDAR-01", fallback: "FB-REVIEW-01", loadGroup: "workflow", preload: false },
  { id: "P0-REVIEW-TRAY-01", source: "三分区木制托盘3d模型-2.glb", stem: "review-tray", lods: 2, rootName: "ROOT_ReviewTray", anchors: [{ name: "ANCHOR_ReviewTrayCards", translation: [0, 0.1, 0] }], reference: "REF-REVIEW-TRAY-01", fallback: "FB-REVIEW-01", loadGroup: "workflow", preload: false },
  { id: "P4-DRAWER-01", source: "木质抽屉3d模型-3.glb", stem: "drawer-capture", lods: 2, rootName: "ROOT_Drawer", anchors: [{ name: "PIVOT_DrawerSlide", translation: [0, 0, 0] }, { name: "HOTSPOT_Drawer", translation: [0, 0.2, 0] }], reference: "REF-DRAWER-01", fallback: "FB-DRAWER-01", loadGroup: "optional", preload: false, phase: "P4" },
];

async function buildModel(spec) {
  const phase = spec.phase ?? "P0";
  const outputRoot = join(runtimeRoot, "models", phase.toLowerCase());
  ensureDir(outputRoot);
  const source = join(modelRoot, spec.source);
  const lod0 = join(outputRoot, `${spec.stem}-lod0.glb`);
  run(gltfCli, ["optimize", source, lod0, "--compress", "meshopt", "--flatten", "false", "--instance", "false", "--join", "false", "--join-meshes", "false", "--palette", "false", "--simplify", "false", "--texture-compress", "webp", "--texture-size", "1024"]);
  await applySemanticNames(lod0, spec);

  for (let lod = 1; lod < spec.lods; lod += 1) {
    const ratio = lod === 1 ? "0.5" : "0.2";
    const simplified = join(outputRoot, `${spec.stem}-lod${lod}.intermediate.glb`);
    const output = join(outputRoot, `${spec.stem}-lod${lod}.glb`);
    try {
      run(gltfCli, ["simplify", lod0, simplified, "--ratio", ratio, "--error", "0.001"]);
      run(gltfCli, ["meshopt", simplified, output]);
    } catch (error) {
      writeFileSync(output, readFileSync(lod0));
      console.warn(`[learning-room] LOD${lod} simplification failed for ${spec.id}; copied LOD0 for review:`, error.message);
    }
    await applySemanticNames(output, spec);
    rmSync(simplified, { force: true });
  }
  return spec;
}

async function extractAnimationPack() {
  const source = join(modelRoot, "伴星角色.glb");
  const output = join(runtimeRoot, "animations/p0/companion-humanoid-core.glb");
  ensureDir(dirname(output));
  const document = await io.read(source);
  const nodes = document.getRoot().listNodes();
  for (const node of nodes) {
    if (node.getMesh()) node.setMesh(null);
    if (node.getSkin()) node.setSkin(null);
  }
  const animation = document.getRoot().listAnimations()[0];
  if (animation) animation.setName("humanoid_idle");
  try {
    await document.transform(prune());
  } catch (error) {
    console.warn("[learning-room] animation prune warning:", error.message);
  }
  await io.write(output, document);
  return output;
}

const fallbackSpecs = [
  { id: "FB-ROOM-01", source: ["room-empty-day-v2.png", "room-empty-night-v20.png"], output: ["fallback/room-day.webp", "fallback/room-night.webp"], sourceIds: ["STATIC-ROOM-01", "STATIC-ROOM-02"], routes: ["/", "/today"], themePair: "room-day-night", loadGroup: "critical", preload: true },
  { id: "FB-DESK-01", source: ["desk-flat-fallback-v2.png"], output: ["fallback/desk.webp"], sourceIds: ["STATIC-DESK-02"], routes: ["/today"], loadGroup: "scene" },
  { id: "FB-NOTE-01", source: ["notebook-open-flat-fallback-v1.png"], output: ["fallback/notebook.webp"], sourceIds: ["STATIC-NOTE-01"], routes: ["/notes/[id]"], loadGroup: "workflow" },
  { id: "FB-CARD-01", source: ["card-box-flat-fallback-v1.png"], output: ["fallback/card-box.webp"], sourceIds: ["STATIC-CARD-01"], routes: ["/cards", "/learning-cards/[cardId]"], loadGroup: "workflow" },
  { id: "FB-VERIFY-01", source: ["answer-sheet-flat-fallback-v1.png"], output: ["fallback/answer-sheet.webp"], sourceIds: ["STATIC-VERIFY-01"], routes: ["/learning-runs/new"], loadGroup: "workflow" },
  { id: "FB-REVIEW-01", source: ["review-calendar-flat-fallback-v2.png"], output: ["fallback/review-calendar.webp"], sourceIds: ["STATIC-REVIEW-01"], routes: ["/review"], loadGroup: "workflow" },
  { id: "FB-SHELF-01", source: ["shelf-flat-fallback-v1.png"], output: ["fallback/shelf.webp"], sourceIds: ["STATIC-SHELF-01"], routes: ["/notes", "/sources"], loadGroup: "scene" },
  { id: "FB-SOURCE-01", source: ["source-folder-flat-fallback-v1.png"], output: ["fallback/source-folder.webp"], sourceIds: ["STATIC-SOURCE-01"], routes: ["/sources", "/sources/[id]"], loadGroup: "workflow" },
  { id: "FB-GRAPH-01", source: ["window-sky-night-v20.png"], output: ["fallback/window-graph-night.webp"], sourceIds: ["STATIC-WINDOW-02"], routes: ["/graph"], loadGroup: "scene" },
  { id: "FB-ORB-01", source: ["companion-orb-flat-fallback-v1.png"], output: ["fallback/companion-orb.webp"], sourceIds: ["STATIC-PET-01"], routes: ["companion"], loadGroup: "character" },
];

async function buildFallbacks() {
  const safeArea = { x: 0.06, y: 0.06, width: 0.88, height: 0.88 };
  const cropAnchor = { x: 0.5, y: 0.5 };
  const anchors = [
    { name: "top_left", u: 0.08, v: 0.08 }, { name: "top_right", u: 0.92, v: 0.08 },
    { name: "bottom_left", u: 0.08, v: 0.92 }, { name: "bottom_right", u: 0.92, v: 0.92 },
    { name: "window_left", u: 0.24, v: 0.38 }, { name: "window_right", u: 0.76, v: 0.38 },
    { name: "horizon_left", u: 0.24, v: 0.58 }, { name: "horizon_right", u: 0.76, v: 0.58 },
  ];
  for (const spec of fallbackSpecs) {
    for (let i = 0; i < spec.source.length; i += 1) {
      const source = join(staticRoot, spec.source[i]);
      const output = join(runtimeRoot, spec.output[i]);
      ensureDir(dirname(output));
      await sharp(source).webp({ quality: 82, effort: 6 }).toFile(output);
    }
  }

  const textureSpecs = [
    ["paper-sticky-note-sun-v1.png", "textures/p0/sticky-note-base.webp"],
    ["paper-lined-warm-v1.png", "textures/p0/notebook-pages.webp"],
    ["paper-card-warm-v1.png", "textures/p0/learning-card-base.webp"],
    ["paper-grid-warm-v1.png", "textures/p0/answer-sheet-base.webp"],
    ["paper-warm-seamless-v1.png", "textures/p0/source-folder-base.webp"],
  ];
  for (const [sourceName, outputName] of textureSpecs) {
    const output = join(runtimeRoot, outputName);
    ensureDir(dirname(output));
    await sharp(join(staticRoot, sourceName)).resize(1024, 1024).webp({ quality: 86, effort: 6 }).toFile(output);
  }

  return { safeArea, cropAnchor, anchors };
}

function sceneConfig() {
  return {
    schemaVersion: 1,
    coordinateSystem: { unit: "meters", up: "+Y", forward: "+Z", handedness: "right-handed" },
    presets: {
      "room-overview": { position: [-2.6, 3.1, 7.4], target: [0.7, 1.3, -1.8], fov: 42, near: 0.05, far: 40, visible: ["P0-ROOM-01", "P0-DESK-01", "P0-LAMP-01", "P0-SHELF-01", "P0-ORB-01"] },
      "desk-focus": { position: [4.2, 2.7, 4.3], target: [0, 0.75, 0.1], fov: 32, near: 0.05, far: 30, visible: ["P0-ROOM-01", "P0-DESK-01", "P0-LAMP-01", "P0-NOTEBOOK-01", "P0-ORB-01"] },
      "notebook-top": { position: [0.3, 4.6, 0.8], target: [0, 0, 0.1], fov: 30, near: 0.05, far: 20, visible: ["P0-DESK-01", "P0-NOTEBOOK-01"] },
      "card-top": { position: [0.4, 4.5, 0.8], target: [0, 0, 0.1], fov: 30, near: 0.05, far: 20, visible: ["P0-DESK-01", "P0-CARD-BOX-01"] },
      "shelf-close": { position: [-3.4, 2.7, 3.2], target: [-3.1, 1.4, -2.2], fov: 34, near: 0.05, far: 25, visible: ["P0-ROOM-01", "P0-SHELF-01"] },
      "window-graph": { position: [2.9, 2.6, 4.5], target: [3.78, 1.6, -1.25], fov: 34, near: 0.05, far: 25, visible: ["P0-ROOM-01", "P0-WINDOW-01"] },
      "review-desk": { position: [4.5, 3, 4.6], target: [0, 0.7, 0], fov: 34, near: 0.05, far: 30, visible: ["P0-ROOM-01", "P0-DESK-01", "P0-CALENDAR-01", "P0-REVIEW-TRAY-01"] },
    },
    anchors: { companion: "ANCHOR_Companion", notebook: "ANCHOR_NotebookContent", drawer: "ANCHOR_Drawer" },
    lighting: { day: { ambient: 0.85, key: "warm_window" }, night: { ambient: 0.22, key: "lamp_warm" } },
  };
}

function flowConfig() {
  return {
    schemaVersion: 1,
    defaultMode: "2d",
    storageKey: "learning-room.view-mode",
    presets: ["room-overview", "desk-focus", "notebook-top", "card-top", "shelf-close", "window-graph", "review-desk"],
    fallback: { webgl2Failure: "2d", assetFailure: "2d", timeoutMs: 5000, contextLossRecoveryMs: 3000, lowQualityFps: 24 },
    sequence: ["dom_actions", "room_light", "lamp_on", "companion_or_fallback", "wait_for_user", "camera_room_to_desk", "notebook_open", "editable_note"],
    preserveFields: ["url", "domainObject", "draft", "selectedObject", "focus", "aiTask", "learningRunId", "completedSteps"],
  };
}

async function buildManifest(textureMeta) {
  const entries = [];
  const addEntry = async (entry) => entries.push(entry);
  const modelSpecsWithRoom = [
    { id: "P0-ROOM-01", stem: "room-shell", lods: 3, reference: "REF-ROOM-SHELL-01", fallback: "FB-ROOM-01", loadGroup: "critical", preload: true, rootName: "ROOT_RoomShell" },
    ...modelSpecs,
  ];

  for (const spec of modelSpecsWithRoom) {
    const phase = spec.phase ?? "P0";
    const files = [];
    for (let lod = 0; lod < spec.lods; lod += 1) {
      const relativePath = `models/${phase.toLowerCase()}/${spec.stem}-lod${lod}.glb`;
      files.push(await fileEntry(relativePath, { loadGroup: spec.loadGroup, preload: lod === 0 && spec.preload }));
    }
    await addEntry({ id: spec.id, kind: "model", priority: phase, owner: "3D", status: "IN_REVIEW", files, references: [spec.reference], dependencies: [], fallback: spec.fallback, extensionsRequired: ["EXT_meshopt_compression"], license: "Owner-provided/generated asset; release license review pending" });
  }

  const animationPath = "animations/p0/companion-humanoid-core.glb";
  await addEntry({ id: "P0-HUMANOID-ANIM-01", kind: "animation", priority: "P0", owner: "3D", status: "IN_REVIEW", files: [await fileEntry(animationPath, { loadGroup: "character", preload: false })], references: ["REF-HUMANOID-01"], dependencies: ["P0-HUMANOID-01"], fallback: "FB-ORB-01", animations: [{ name: "humanoid_idle", loop: true, durationMs: 1000 }], extensionsRequired: [], license: "Owner-provided/generated asset; release license review pending" });

  const textureEntries = [
    ["P0-STICKY-01", "sticky-note-base.webp", ["STATIC-PAPER-05"], "FB-STATUS-01"],
    ["P0-NOTE-PAGES-01", "notebook-pages.webp", ["STATIC-PAPER-02", "STATIC-PAPER-03"], "FB-NOTE-01"],
    ["P0-CARD-01", "learning-card-base.webp", ["STATIC-PAPER-04"], "FB-CARD-01"],
    ["P0-ANSWER-01", "answer-sheet-base.webp", ["STATIC-PAPER-03"], "FB-VERIFY-01"],
    ["P0-SOURCE-FOLDER-01", "source-folder-base.webp", ["STATIC-PAPER-01"], "FB-SOURCE-01"],
  ];
  for (const [id, fileName, sourceIds, fallback] of textureEntries) {
    const relativePath = `textures/p0/${fileName}`;
    await addEntry({ id, kind: "texture", priority: "P0", owner: "FE", status: "IN_REVIEW", files: [await fileEntry(relativePath, { loadGroup: "workflow", preload: false })], sourceIds, dependencies: [], fallback, extensionsRequired: [], license: "Project-generated derivative from project-owned visual source" });
  }

  const configSpecs = [
    ["P0-SCENE-01", "scene-p0.json", ["P0-ROOM-01", "P0-DESK-01", "P0-LAMP-01", "P0-WINDOW-01", "P0-SHELF-01", "P0-ORB-01"], "FB-ROOM-01"],
    ["P0-FLOW-01", "flow-p0.json", ["P0-NOTEBOOK-01", "P0-CARD-01", "P0-ANSWER-01"], "FB-ROOM-01"],
  ];
  for (const [id, fileName, dependencies, fallback] of configSpecs) {
    const relativePath = `config/${fileName}`;
    await addEntry({ id, kind: "config", priority: "P0", owner: "FE", status: "IN_REVIEW", files: [await fileEntry(relativePath, { loadGroup: "critical", preload: true })], references: [], dependencies, fallback, extensionsRequired: [], license: "Project-owned configuration" });
  }

  for (const spec of fallbackSpecs) {
    const files = [];
    for (let index = 0; index < spec.output.length; index += 1) {
      files.push(await fileEntry(spec.output[index], { loadGroup: spec.loadGroup, preload: spec.preload ?? false, safeArea: textureMeta.safeArea, cropAnchor: textureMeta.cropAnchor, themePair: spec.themePair, registrationAnchors: spec.themePair ? textureMeta.anchors : undefined }));
    }
    await addEntry({ id: spec.id, kind: "fallback", priority: spec.id === "FB-ORB-01" ? "P0" : "P0", owner: "FE", status: "IN_REVIEW", files, sourceIds: spec.sourceIds, dependencies: [], routes: spec.routes, license: "Project-generated derivative from project-owned visual source" });
  }

  for (const [id, actions, routes] of [
    ["FB-DRAWER-01", ["quick_capture", "archive", "history", "recent"], ["/", "/notes?view=archive", "/notes/[id]?panel=history", "/notes?filter=recent"]],
    ["FB-THEME-01", ["set_day", "set_night"], ["/", "/today"]],
    ["FB-STATUS-01", ["render_status"], ["/", "/today"]],
    ["FB-HIDE-01", ["hide_decorative_asset"], ["*"]],
  ]) {
    await addEntry({ id, kind: "behavior", priority: "P0", owner: "FE", status: "IN_REVIEW", files: [], behavior: { actions, routes, preserveFields: flowConfig().preserveFields, accessibleDescription: "DOM path remains authoritative when the visual layer is unavailable." }, license: "Project-owned behavior contract" });
  }

  return {
    schemaVersion: 1,
    revision: 1,
    reviewOnly: true,
    assetBase: "/assets/3d/learning-room/v1/",
    coordinateSystem: sceneConfig().coordinateSystem,
    entries,
    acceptance: { state: "IN_REVIEW", blockers: ["KTX2 encoder not installed; WebP review textures are used", "P0 model geometry and animation QA pending", "Electron/offline smoke test pending"] },
  };
}

async function main() {
  ensureDir(runtimeRoot);
  ensureDir(join(runtimeRoot, "models/p0"));
  ensureDir(join(runtimeRoot, "licenses"));
  await createRoomReferences();
  await createRoomShell(join(runtimeRoot, "models/p0/room-shell-lod0.glb"), 0);
  await createRoomShell(join(runtimeRoot, "models/p0/room-shell-lod1.glb"), 1);
  await createRoomShell(join(runtimeRoot, "models/p0/room-shell-lod2.glb"), 2);
  for (const spec of modelSpecs) await buildModel(spec);
  await extractAnimationPack();
  const textureMeta = await buildFallbacks();
  writeJson(join(runtimeRoot, "config/scene-p0.json"), sceneConfig());
  writeJson(join(runtimeRoot, "config/flow-p0.json"), flowConfig());
  writeJson(join(runtimeRoot, "config/card-visual.json"), { schemaVersion: 1, geometry: "shared-rounded-plane", faces: ["front", "back"], content: "DOM" });
  writeJson(join(runtimeRoot, "config/evidence-visual.json"), { schemaVersion: 1, objects: ["evidence-note", "source-label", "citation-clip"], content: "DOM" });
  writeJson(join(runtimeRoot, "config/answer-sheet.json"), { schemaVersion: 1, geometry: "shared-page-plane", content: "DOM", safeArea: { x: 0.08, y: 0.08, width: 0.84, height: 0.84 } });
  writeJson(join(runtimeRoot, "config/validation-marker.json"), { schemaVersion: 1, states: ["demonstrated", "partial", "needs_repair", "not_assessable", "practice_completed", "skipped", "declared_unable"], content: "DOM" });
  writeJson(join(runtimeRoot, "config/source-folder.json"), { schemaVersion: 1, geometry: "shared-folded-plane", openable: false, content: "DOM" });
  const manifest = await buildManifest(textureMeta);
  writeJson(join(runtimeRoot, "manifest.review.json"), manifest);
  writeJson(join(runtimeRoot, "manifest.json"), manifest);
  writeJson(join(runtimeRoot, "manifest.schema.json"), { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", required: ["schemaVersion", "revision", "assetBase", "coordinateSystem", "entries"], properties: { schemaVersion: { type: "integer" }, revision: { type: "integer" }, reviewOnly: { type: "boolean" }, assetBase: { type: "string" }, coordinateSystem: { type: "object" }, entries: { type: "array" } } });
  writeFileSync(join(runtimeRoot, "licenses/THIRD_PARTY.md"), "# Learning Room asset provenance\n\n- `room-shell-*`: project-generated geometry, project-owned.\n- P0/P4 GLB sources: owner-provided/generated source files; redistribution/license confirmation remains a release gate.\n- Static derivatives: generated from project-owned design sources.\n\nThis review package is not a final release-license approval.\n");
  writeFileSync(join(runtimeRoot, "README.md"), "# Learning Room v1 review package\n\nGenerated by `apps/web/scripts/build-learning-room-assets.mjs`.\n\n`manifest.json` is intentionally marked `reviewOnly: true` until the GLB, KTX2, Electron offline, budget, and visual regression gates pass. The browser prototype loads this package to validate the spatial contract and 2D fallback.\n");
  console.log(`[learning-room] built review package at ${runtimeRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
