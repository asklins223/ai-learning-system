"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "meshoptimizer";

type RoomMode = "2d-canonical" | "3d-loading" | "3d-ready" | "2d-fallback";

type AssetFile = {
  path: string;
};

type AssetEntry = {
  id: string;
  kind: string;
  files: AssetFile[];
};

type RoomManifest = {
  assetBase: string;
  entries: AssetEntry[];
};

type CameraPreset = {
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
  near: number;
  far: number;
};

type RoomSceneConfig = {
  presets: Record<string, CameraPreset>;
};

const ASSET_ROOT = "/assets/3d/learning-room/v1/";
const CANONICAL_BACKPLATE = `${ASSET_ROOT}fallback/room-day.webp`;

function findLod(entry: AssetEntry | undefined, lod: number) {
  return entry?.files.find((file) => file.path.endsWith(`lod${lod}.glb`))?.path
    ?? entry?.files.find((file) => file.path.endsWith("lod0.glb"))?.path;
}

function fitObject(object: THREE.Object3D, maxDimension: number, position: THREE.Vector3) {
  const bounds = new THREE.Box3().setFromObject(object);
  const size = bounds.getSize(new THREE.Vector3());
  const largest = Math.max(size.x, size.y, size.z, 0.001);
  const scale = maxDimension / largest;
  object.scale.setScalar(scale);
  const fittedBounds = new THREE.Box3().setFromObject(object);
  object.position.copy(position);
  object.position.y = position.y - fittedBounds.min.y;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.castShadow = true;
    child.receiveShadow = true;
  });
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) value.dispose();
      });
      material.dispose();
    });
  });
}

function applyReviewPalette(object: THREE.Object3D, assetId: string) {
  const palette: Record<string, string> = {
    "P0-DESK-01": "#b99567",
    "P0-LAMP-01": "#d9c9ad",
    "P0-SHELF-01": "#936b45",
    "P0-ORB-01": "#5fa8b8",
    "P0-HUMANOID-01": "#f2e9d9",
  };
  const fallbackColor = palette[assetId];
  if (!fallbackColor) return;
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (!("color" in material) || !(material.color instanceof THREE.Color)) return;
      const textured = "map" in material && material.map instanceof THREE.Texture;
      if (!textured) material.color.set(fallbackColor);
    });
  });
}

export function LearningRoomCanvas() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const roomRootRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef<number | null>(null);
  const loadGenerationRef = useRef(0);
  const [mode, setMode] = useState<RoomMode>("2d-canonical");
  const [message, setMessage] = useState("当前使用 2D 工作区；3D 是可选增强。\u200b");
  const [preset, setPreset] = useState("room-overview");
  const [canUse3d, setCanUse3d] = useState(true);

  const cleanup = useCallback(() => {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    if (roomRootRef.current) disposeObject(roomRootRef.current);
    roomRootRef.current = null;
    sceneRef.current = null;
    cameraRef.current = null;
    rendererRef.current?.dispose();
    rendererRef.current = null;
  }, []);

  const load3d = useCallback(async () => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || !canUse3d) {
      setMode("2d-fallback");
      setMessage("当前窗口较窄，已保留完整 2D 学习路径。\u200b");
      return;
    }

    const generation = ++loadGenerationRef.current;
    setMode("3d-loading");
    setMessage("正在检查 WebGL2 与房间资产…\u200b");
    cleanup();

    try {
      const webgl2 = canvas.getContext("webgl2", { antialias: true, alpha: true });
      if (!webgl2) throw new Error("WebGL2 unavailable");
      const [manifestResponse, configResponse] = await Promise.all([
        fetch(`${ASSET_ROOT}manifest.json`, { cache: "no-store" }),
        fetch(`${ASSET_ROOT}config/scene-p0.json`, { cache: "no-store" }),
      ]);
      if (!manifestResponse.ok || !configResponse.ok) throw new Error("Room manifest unavailable");
      const manifest = await manifestResponse.json() as RoomManifest;
      const config = await configResponse.json() as RoomSceneConfig;
      if (generation !== loadGenerationRef.current) return;

      const presetConfig = config.presets[preset] ?? config.presets["room-overview"];
      const renderer = new THREE.WebGLRenderer({ canvas, context: webgl2, antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.08;
      renderer.shadowMap.enabled = false;
      rendererRef.current = renderer;

      const scene = new THREE.Scene();
      // The canonical 2D room image owns the architectural look. Three.js
      // contributes only the volumetric props and their interaction layer.
      scene.background = null;
      scene.fog = null;
      sceneRef.current = scene;
      scene.add(new THREE.HemisphereLight("#fff4df", "#50311d", 2.7));
      scene.add(new THREE.AmbientLight("#fff1d5", 1.05));
      const keyLight = new THREE.DirectionalLight("#ffd49c", 1.7);
      keyLight.position.set(4, 7, 5);
      scene.add(keyLight);
      const coolFill = new THREE.DirectionalLight("#a7cbd5", 1.25);
      coolFill.position.set(-4, 4, 3);
      scene.add(coolFill);

      const camera = new THREE.PerspectiveCamera(presetConfig.fov, 1, presetConfig.near, presetConfig.far);
      camera.position.set(...presetConfig.position);
      camera.lookAt(...presetConfig.target);
      cameraRef.current = camera;

      await MeshoptDecoder.ready;
      const loader = new GLTFLoader()
        .setPath(`${window.location.origin}${manifest.assetBase}`)
        .setMeshoptDecoder(MeshoptDecoder);
      const entry = (id: string) => manifest.entries.find((item) => item.id === id);
      const root = new THREE.Group();
      root.name = "LearningRoom_P0_Review";
      scene.add(root);
      roomRootRef.current = root;

      const loadModel = async (id: string, maxDimension: number, position: THREE.Vector3) => {
        const path = findLod(entry(id), id === "P0-ROOM-01" ? 0 : 1);
        if (!path) throw new Error(`Missing asset ${id}`);
        const gltf = await loader.loadAsync(path);
        const object = gltf.scene;
        object.name = id;
        fitObject(object, maxDimension, position);
        applyReviewPalette(object, id);
        if (id === "P0-ROOM-01") object.visible = false;
        root.add(object);
        return { object, gltf };
      };

      await Promise.race([
        Promise.all([
          loadModel("P0-ROOM-01", 8, new THREE.Vector3(0, 0, 0)),
          loadModel("P0-DESK-01", 3, new THREE.Vector3(0, 0, 0.2)),
          loadModel("P0-LAMP-01", 1.05, new THREE.Vector3(-0.55, 0.55, 0.1)),
          loadModel("P0-SHELF-01", 2.6, new THREE.Vector3(-3.05, 0, -2.38)),
          loadModel("P0-ORB-01", 0.58, new THREE.Vector3(2.1, 1.2, 0.5)),
        ]),
        new Promise((_, reject) => window.setTimeout(() => reject(new Error("3D asset timeout")), 5000)),
      ]);
      if (generation !== loadGenerationRef.current) return;

      try {
        const characterPath = findLod(entry("P0-HUMANOID-01"), 1);
        if (characterPath) {
          const character = await loader.loadAsync(characterPath);
          fitObject(character.scene, 2.05, new THREE.Vector3(2.05, 0, 0.5));
          applyReviewPalette(character.scene, "P0-HUMANOID-01");
          root.add(character.scene);
          const orb = root.children.find((child) => child !== character.scene && child.name === "P0-ORB-01");
          if (orb) {
            root.remove(orb);
            disposeObject(orb);
          }
        }
      } catch {
        // 光球已经在首屏中，人物失败不影响空间验证或 DOM 学习操作。
      }

      const resize = () => {
        const width = Math.max(1, stage.clientWidth);
        const height = Math.max(1, stage.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(stage);
      resize();
      const onContextLost = (event: Event) => {
        event.preventDefault();
        resizeObserver.disconnect();
        cleanup();
        setMode("2d-fallback");
        setMessage("3D 画布暂时中断，已切换到 2D；学习内容与草稿保持不变。\u200b");
      };
      canvas.addEventListener("webglcontextlost", onContextLost, { once: true });
      const render = () => {
        if (generation !== loadGenerationRef.current || rendererRef.current !== renderer) return;
        renderer.render(scene, camera);
        frameRef.current = requestAnimationFrame(render);
      };
      render();
      window.localStorage.setItem("learning-room.view-mode", "3d");
      setMode("3d-ready");
      setMessage("3D 房间已载入；文字、笔记和学习任务仍由 DOM 工作区负责。\u200b");
    } catch {
      cleanup();
      setMode("2d-fallback");
      setMessage("3D 资产暂时不可用，已回退到 2D 工作区。\u200b");
    }
  }, [canUse3d, cleanup, preset]);

  useEffect(() => {
    const updateViewport = () => setCanUse3d(window.innerWidth >= 960 && !window.matchMedia("(pointer: coarse)").matches);
    updateViewport();
    window.addEventListener("resize", updateViewport);
    return () => window.removeEventListener("resize", updateViewport);
  }, []);

  useEffect(() => () => {
    loadGenerationRef.current += 1;
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    if (!canUse3d && mode === "3d-ready") {
      cleanup();
      setMode("2d-fallback");
      setMessage("已进入窄窗 2D 适配路径。\u200b");
    }
  }, [canUse3d, cleanup, mode]);

  const is3d = mode === "3d-ready" || mode === "3d-loading";
  return (
    <main className="learning-room-page">
      <header className="learning-room-page__header">
        <div>
          <p className="learning-room-page__eyebrow">理解书房 / 空间验证</p>
          <h1>把下一步放在桌面上</h1>
          <p className="learning-room-page__lede">空间是学习闭环的提示层。真正的笔记、卡片、验证和复习内容始终保留在可访问的 2D 工作区。</p>
        </div>
        <div className="learning-room-page__controls" aria-label="学习空间控制">
          <label>
            <span>镜头</span>
            <select value={preset} onChange={(event) => setPreset(event.target.value)} disabled={is3d}>
              <option value="room-overview">房间总览</option>
              <option value="desk-focus">桌面聚焦</option>
              <option value="notebook-top">研究册俯视</option>
              <option value="review-desk">复习桌面</option>
            </select>
          </label>
          <button type="button" className="learning-room-page__primary" onClick={() => void load3d()} disabled={!canUse3d || is3d}>
            {mode === "3d-loading" ? "正在载入…" : mode === "3d-ready" ? "3D 已开启" : canUse3d ? "开启 3D 视图" : "窄窗使用 2D"}
          </button>
          {mode === "3d-ready" && <button type="button" className="learning-room-page__quiet" onClick={() => { cleanup(); window.localStorage.setItem("learning-room.view-mode", "2d"); setMode("2d-canonical"); setMessage("已回到默认 2D 工作区。\u200b"); }}>回到 2D</button>}
        </div>
      </header>

      <section className={`learning-room-stage learning-room-stage--${mode}`} ref={stageRef} aria-label="理解书房空间预览">
        <div className="learning-room-stage__fallback" style={{ backgroundImage: `url(${CANONICAL_BACKPLATE})` }} aria-hidden="true" />
        <canvas ref={canvasRef} className="learning-room-stage__canvas" aria-hidden="true" />
        <div className="learning-room-stage__caption">
          <span className="learning-room-stage__status" data-mode={mode} aria-hidden="true" />
          <span role="status" aria-live="polite">{message}</span>
        </div>
        <div className="learning-room-stage__actions" aria-label="学习任务入口">
          <a href="/today">继续学习</a>
          <a href="/review">今日复习</a>
          <a href="/search">搜索理解</a>
        </div>
      </section>
    </main>
  );
}
