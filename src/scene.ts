import * as THREE from "three";
import { FIELD, TRACK, CAMERA } from "./config";
import type { AssetBundle } from "./assets";

export function makeRenderer(canvas: HTMLCanvasElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  return renderer;
}

export type World = { scene: THREE.Scene; camera: THREE.PerspectiveCamera };

const OUT_N = TRACK.startZ; // north (track start) boundary
const OUT_S = -FIELD.hz; // south (pitch) boundary

// thin flat white line on the pitch
function line(w: number, d: number, x: number, z: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7, emissive: 0x2a2a2a });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.02, z);
  m.receiveShadow = true;
  return m;
}

// checkered banner texture (black/white)
function checkerTexture(cols: number, rows: number): THREE.CanvasTexture {
  const cell = 32;
  const canvas = document.createElement("canvas");
  canvas.width = cols * cell;
  canvas.height = rows * cell;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        ctx.fillStyle = (x + y) % 2 === 0 ? "#f4f4f4" : "#101014";
        ctx.fillRect(x * cell, y * cell, cell, cell);
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildWorld(assets: AssetBundle): World {
  const scene = new THREE.Scene();
  scene.background = assets.sky;
  scene.environment = assets.env;
  scene.fog = new THREE.Fog(0xbcd3e6, 160, 420);

  const camera = new THREE.PerspectiveCamera(
    CAMERA.fov,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.position.set(0, CAMERA.up, TRACK.startZ + CAMERA.back);
  camera.lookAt(0, 0, TRACK.startZ);

  // --- lighting ---
  scene.add(new THREE.HemisphereLight(0xdff0ff, 0x516b3a, 0.6));
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.1);
  const midZ = (OUT_N + OUT_S) / 2;
  sun.position.set(60, 90, midZ + 40);
  sun.target.position.set(0, 0, midZ);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 320;
  sun.shadow.camera.left = -45;
  sun.shadow.camera.right = 45;
  sun.shadow.camera.top = 110;
  sun.shadow.camera.bottom = -110;
  sun.shadow.bias = -0.0004;
  scene.add(sun);
  scene.add(sun.target);

  // --- ground (tiled grass, large) ---
  const groundSize = 460;
  const grass = assets.grass.clone();
  grass.needsUpdate = true;
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.repeat.set(groundSize / 6, groundSize / 6);
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(groundSize, groundSize),
    new THREE.MeshStandardMaterial({ map: grass, roughness: 0.95, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = midZ;
  ground.receiveShadow = true;
  scene.add(ground);

  // --- football pitch markings (z ∈ [-hz, finishZ]) ---
  const marks = new THREE.Group();
  const t = 0.18;
  marks.add(line(FIELD.hx * 2, t, 0, -FIELD.hz)); // south goal line
  marks.add(line(t, FIELD.hz + TRACK.finishZ, -FIELD.hx, (TRACK.finishZ - FIELD.hz) / 2)); // west
  marks.add(line(t, FIELD.hz + TRACK.finishZ, FIELD.hx, (TRACK.finishZ - FIELD.hz) / 2)); // east
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(5.6, 5.9, 48),
    new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0x2a2a2a, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 0.02, 0);
  marks.add(ring);
  scene.add(marks);

  // --- racing track (z ∈ [finishZ, startZ]) ---
  const roadHalf = TRACK.laneHalf;
  const roadLen = TRACK.startZ - TRACK.finishZ;
  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(roadHalf * 2, roadLen),
    new THREE.MeshStandardMaterial({ color: 0x2b2d33, roughness: 0.95, metalness: 0 }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.set(0, 0.015, (TRACK.finishZ + TRACK.startZ) / 2);
  road.receiveShadow = true;
  scene.add(road);

  // dashed centre line
  const dashMat = new THREE.MeshStandardMaterial({ color: 0xf2d64a, emissive: 0x3a3410 });
  for (let z = TRACK.finishZ + 4; z < TRACK.startZ - 2; z += 8) {
    const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3.5), dashMat);
    dash.rotation.x = -Math.PI / 2;
    dash.position.set(0, 0.03, z);
    scene.add(dash);
  }

  // red/white kerbs along both edges of the road
  const kerbMat = [
    new THREE.MeshStandardMaterial({ color: 0xd23b3b, roughness: 0.7 }),
    new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.7 }),
  ];
  for (let z = TRACK.finishZ; z < TRACK.startZ; z += 3) {
    const mat = kerbMat[(Math.round(z / 3) % 2 + 2) % 2];
    for (const sx of [-1, 1]) {
      const kerb = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 3), mat);
      kerb.position.set(sx * (roadHalf + 0.5), 0.09, z + 1.5);
      kerb.receiveShadow = true;
      scene.add(kerb);
    }
  }

  // start + finish checkered banners
  const startBand = new THREE.Mesh(
    new THREE.PlaneGeometry(roadHalf * 2, 3),
    new THREE.MeshStandardMaterial({ map: checkerTexture(16, 2), roughness: 0.7 }),
  );
  startBand.rotation.x = -Math.PI / 2;
  startBand.position.set(0, 0.04, TRACK.startZ - 3);
  scene.add(startBand);

  const finishBand = new THREE.Mesh(
    new THREE.PlaneGeometry(roadHalf * 2, 3),
    new THREE.MeshStandardMaterial({ map: checkerTexture(16, 2), roughness: 0.7 }),
  );
  finishBand.rotation.x = -Math.PI / 2;
  finishBand.position.set(0, 0.04, TRACK.finishZ + 0.2);
  scene.add(finishBand);

  // finish gantry posts
  const postMat = new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.5, metalness: 0.1 });
  for (const sx of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5, 0.6), postMat);
    post.position.set(sx * (roadHalf + 0.6), 2.5, TRACK.finishZ);
    post.castShadow = true;
    scene.add(post);
  }
  const beam = new THREE.Mesh(
    new THREE.BoxGeometry(roadHalf * 2 + 1.2, 0.8, 0.6),
    new THREE.MeshStandardMaterial({ map: checkerTexture(24, 1), roughness: 0.6 }),
  );
  beam.position.set(0, 5, TRACK.finishZ);
  beam.castShadow = true;
  scene.add(beam);

  // --- outer perimeter walls (one big rectangle) ---
  const wallMat = new THREE.MeshStandardMaterial({ color: 0xeef1f5, roughness: 0.55, metalness: 0.05 });
  const wallT = 0.5;
  const totalLen = OUT_N - OUT_S;
  const midWallZ = (OUT_N + OUT_S) / 2;
  const mkWall = (w: number, d: number, x: number, z: number) => {
    const wall = new THREE.Mesh(new THREE.BoxGeometry(w, FIELD.wallH, d), wallMat);
    wall.position.set(x, FIELD.wallH / 2, z);
    wall.castShadow = true;
    wall.receiveShadow = true;
    scene.add(wall);
  };
  mkWall(FIELD.hx * 2 + wallT * 2, wallT, 0, OUT_S - wallT / 2); // south
  mkWall(FIELD.hx * 2 + wallT * 2, wallT, 0, OUT_N + wallT / 2); // north
  mkWall(wallT, totalLen, -FIELD.hx - wallT / 2, midWallZ); // west
  mkWall(wallT, totalLen, FIELD.hx + wallT / 2, midWallZ); // east

  return { scene, camera };
}
