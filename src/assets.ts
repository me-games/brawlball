import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { ASSETS } from "./config";

export type AssetBundle = {
  playerProto: THREE.Group;
  carProto: THREE.Group;
  ballProto: THREE.Group;
  grass: THREE.Texture;
  sky: THREE.Texture;
  env: THREE.Texture;
  sfx: { kick: AudioBuffer };
};

type FitOpts = {
  target: number;
  mode: "height" | "footprint" | "max";
  ground: boolean; // true → base sits at y=0; false → centered at origin
  faceYaw?: number; // one-time rotation so the model's front points +Z
};

// Scale + center a loaded GLB scene, wrap it in a Group we can move/rotate cleanly.
function fitModel(scene: THREE.Object3D, opts: FitOpts): THREE.Group {
  scene.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
  });

  const box0 = new THREE.Box3().setFromObject(scene);
  const size = box0.getSize(new THREE.Vector3());
  let scale = 1;
  if (opts.mode === "height") scale = opts.target / Math.max(1e-4, size.y);
  else if (opts.mode === "footprint")
    scale = opts.target / Math.max(1e-4, Math.max(size.x, size.z));
  else scale = opts.target / Math.max(1e-4, Math.max(size.x, size.y, size.z));
  scene.scale.setScalar(scale);
  scene.rotation.y = opts.faceYaw ?? 0;

  const wrap = new THREE.Group();
  wrap.add(scene);

  const box = new THREE.Box3().setFromObject(scene);
  const center = box.getCenter(new THREE.Vector3());
  if (opts.ground) {
    scene.position.x -= center.x;
    scene.position.z -= center.z;
    scene.position.y -= box.min.y;
  } else {
    scene.position.sub(center);
  }
  return wrap;
}

export async function loadAssets(renderer: THREE.WebGLRenderer): Promise<AssetBundle> {
  const gltf = new GLTFLoader();
  const tex = new THREE.TextureLoader();
  const audio = new THREE.AudioLoader();

  const [player, car, ball, grass, sky, kick] = await Promise.all([
    gltf.loadAsync(ASSETS.player),
    gltf.loadAsync(ASSETS.car),
    gltf.loadAsync(ASSETS.ball),
    tex.loadAsync(ASSETS.grass),
    tex.loadAsync(ASSETS.skybox),
    audio.loadAsync(ASSETS.sfxKick),
  ]);

  // ground texture
  grass.colorSpace = THREE.SRGBColorSpace;
  grass.wrapS = grass.wrapT = THREE.RepeatWrapping;
  grass.anisotropy = renderer.capabilities.getMaxAnisotropy();

  // skybox as background + image-based lighting
  sky.mapping = THREE.EquirectangularReflectionMapping;
  sky.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(sky).texture;
  pmrem.dispose();

  return {
    playerProto: fitModel(player.scene, { target: 1.8, mode: "height", ground: true }),
    carProto: fitModel(car.scene, {
      target: 4.4,
      mode: "footprint",
      ground: true,
      faceYaw: -Math.PI / 2, // hood points +X → turn to face +Z (travel dir)
    }),
    ballProto: fitModel(ball.scene, { target: 1.0, mode: "max", ground: false }),
    grass,
    sky,
    env,
    sfx: { kick },
  };
}
