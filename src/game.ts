import * as THREE from "three";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { sentryCanvasSnapshot } from "@genex-ai/embed-sdk/sentry";
import type { Session } from "@genex-ai/multiplayer";

import type { World } from "./scene";
import type { AssetBundle } from "./assets";
import { $, clamp, lerp, colorForId, quatFromYaw, yawFromQuat } from "./util";
import {
  FIELD,
  TRACK,
  PLAYER,
  CAR,
  BALL,
  CAMERA,
  NET_TICK_MS,
  CAR_ENTER_RANGE,
} from "./config";
import type { PlayerNet, BallNet, CarNet } from "./config";

type PlayerMeshRec = { group: THREE.Group; tag: THREE.Sprite; lastX: number; lastZ: number };
type CarMeshRec = { group: THREE.Group; beacon: THREE.Mesh; lastX: number; lastZ: number };
type CarKin = { x: number; z: number; yaw: number; vx: number; vz: number; exists: boolean };
type LocalCar = { x: number; z: number; yaw: number; vx: number; vz: number; driver: string };

function makeNametag(name: string, color: THREE.Color): THREE.Sprite {
  const fs = 44;
  const text = name || "Player";
  const w = Math.ceil(text.length * fs * 0.58) + 40;
  const h = 72;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "rgba(10,13,20,0.55)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "#" + color.getHexString();
    ctx.fillRect(0, 0, 8, h);
    ctx.font = `700 ${fs}px Inter, system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, w / 2 + 4, h / 2 + 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  const scale = 0.012;
  sp.scale.set(w * scale, h * scale, 1);
  return sp;
}

export class Game {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private assets: AssetBundle;
  private listener = new THREE.AudioListener();
  private audioReady = false;

  private room: Session<PlayerNet> | null = null;

  private me = { x: 0, z: TRACK.startZ - 6, yaw: Math.PI, car: -1, fin: 0, name: "You" };
  private prevZ = TRACK.startZ - 6;
  private flashUntil = 0;
  private ball = { x: 0, y: BALL.radius, z: 0, vx: 0, vy: 0, vz: 0 };
  private localCars = new Map<number, LocalCar>();
  private cars: CarKin[] = []; // live car positions/velocities for collisions

  private down = new Set<string>();
  private playerMeshes = new Map<string, PlayerMeshRec>();
  private carMeshes: CarMeshRec[] = [];
  private ballMesh!: THREE.Object3D;
  private lastBall = new THREE.Vector3(0, BALL.radius, 0);

  private hud = {
    banner: $<HTMLElement>("#banner"),
    players: $<HTMLElement>("#playersChip"),
    winner: $<HTMLElement>("#winnerChip"),
    flash: $<HTMLElement>("#flash"),
  };

  private prevTime = performance.now();

  constructor(renderer: THREE.WebGLRenderer, world: World, assets: AssetBundle) {
    this.renderer = renderer;
    this.scene = world.scene;
    this.camera = world.camera;
    this.assets = assets;
    this.camera.add(this.listener);

    this.ballMesh = skeletonClone(this.assets.ballProto);
    this.ballMesh.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.castShadow = true;
    });
    this.ballMesh.visible = false;
    this.scene.add(this.ballMesh);

    for (let i = 0; i < CAR.count; i++) {
      const g = new THREE.Group();
      const car = skeletonClone(this.assets.carProto);
      g.add(car);
      const beacon = new THREE.Mesh(
        new THREE.SphereGeometry(0.26, 16, 16),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 1.6 }),
      );
      beacon.position.set(0, 1.75, 0);
      g.add(beacon);
      g.visible = false;
      this.scene.add(g);
      this.carMeshes.push({ group: g, beacon, lastX: 0, lastZ: 0 });
      this.cars.push({ x: 0, z: 0, yaw: 0, vx: 0, vz: 0, exists: false });
    }
  }

  // ---- lifecycle -------------------------------------------------------
  start(): void {
    addEventListener("resize", () => this.onResize());
    addEventListener("keydown", (e) => this.onKey(e, true));
    addEventListener("keyup", (e) => this.onKey(e, false));
    addEventListener("pointerdown", () => this.unlockAudio());
    this.loop();
  }

  attachRoom(room: Session<PlayerNet>, name: string): void {
    this.room = room;
    this.me.name = name;
    // spawn on the start grid, facing down the track (−Z, toward the pitch)
    this.me.x = (Math.random() * 2 - 1) * (TRACK.laneHalf - 2);
    this.me.z = TRACK.startZ - 6;
    this.me.yaw = Math.PI;
    this.prevZ = this.me.z;

    room.on("leave", (id: string) => this.removePlayer(id));
    room.on("finish", (p: unknown) => {
      if (room.isHost) this.onFinish((p as { name: string }).name);
    });

    setInterval(() => this.tick(), NET_TICK_MS);
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  private unlockAudio(): void {
    if (this.audioReady) return;
    const ctx = this.listener.context;
    if (ctx.state === "suspended") void ctx.resume();
    this.audioReady = true;
  }

  private onKey(e: KeyboardEvent, isDown: boolean): void {
    const code = e.code;
    if (isDown) {
      this.unlockAudio();
      if (this.down.has(code)) return; // ignore auto-repeat
      this.down.add(code);
      if (code === "Space") {
        e.preventDefault();
        if (this.me.car < 0) this.kick();
      } else if (code === "KeyE") {
        this.toggleCar();
      }
    } else {
      this.down.delete(code);
    }
  }

  private held(...codes: string[]): boolean {
    for (const c of codes) if (this.down.has(c)) return true;
    return false;
  }

  // ---- main loop -------------------------------------------------------
  private loop = (): void => {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.prevTime) / 1000);
    this.prevTime = now;
    this.update(dt, now);
    this.renderer.render(this.scene, this.camera);
    sentryCanvasSnapshot(this.renderer.domElement);
    requestAnimationFrame(this.loop);
  };

  private update(dt: number, now: number): void {
    if (this.room) {
      this.syncCars();
      this.simulateOwnedCars(dt);
      if (this.me.car < 0) this.moveOnFoot(dt);
      this.checkFinish();
      this.handleBall(dt);
      if (this.ownsBall()) {
        this.stepBall(dt);
        this.resolveBallVsCars();
      }
      this.renderEntities(now);
      this.refreshHud(now);
    }
    this.followCamera();
  }

  // ---- on-foot movement ------------------------------------------------
  private moveOnFoot(dt: number): void {
    let dx = 0;
    let dz = 0;
    if (this.held("KeyW", "ArrowUp")) dz -= 1;
    if (this.held("KeyS", "ArrowDown")) dz += 1;
    if (this.held("KeyA", "ArrowLeft")) dx -= 1;
    if (this.held("KeyD", "ArrowRight")) dx += 1;
    if (dx !== 0 || dz !== 0) {
      const len = Math.hypot(dx, dz);
      dx /= len;
      dz /= len;
      this.me.x += dx * PLAYER.speed * dt;
      this.me.z += dz * PLAYER.speed * dt;
      this.me.yaw = Math.atan2(dx, dz);
    }
    this.me.x = clamp(this.me.x, -FIELD.hx + PLAYER.radius, FIELD.hx - PLAYER.radius);
    this.me.z = clamp(this.me.z, -FIELD.hz + PLAYER.radius, TRACK.startZ - PLAYER.radius);
  }

  // ---- cars ------------------------------------------------------------
  private toggleCar(): void {
    if (!this.room) return;
    if (this.me.car >= 0) {
      this.exitCar();
      return;
    }
    let best = -1;
    let bestD = CAR_ENTER_RANGE;
    for (let i = 0; i < CAR.count; i++) {
      const v = this.room.objects.get<CarNet>("car:" + i);
      if (!v) continue;
      const drv = v.stateRaw.driver ?? "";
      if (drv !== "" && drv !== this.room.id) continue;
      const d = Math.hypot((v.stateRaw.x ?? 0) - this.me.x, (v.stateRaw.z ?? 0) - this.me.z);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best >= 0) this.enterCar(best);
  }

  private enterCar(i: number): void {
    if (!this.room) return;
    this.room.objects.claim("car:" + i);
    const v = this.room.objects.get<CarNet>("car:" + i);
    const x = v?.stateRaw.x ?? this.me.x;
    const z = v?.stateRaw.z ?? this.me.z;
    const yaw = yawFromQuat(v?.stateRaw.q);
    this.localCars.set(i, { x, z, yaw, vx: 0, vz: 0, driver: this.room.id });
    this.me.car = i;
    this.me.x = x;
    this.me.z = z;
    this.me.yaw = yaw;
  }

  private exitCar(): void {
    const i = this.me.car;
    const lc = this.localCars.get(i);
    if (lc) {
      lc.driver = "";
      lc.vx = 0;
      lc.vz = 0;
      this.me.x = lc.x + Math.cos(lc.yaw) * 2.6;
      this.me.z = lc.z - Math.sin(lc.yaw) * 2.6;
    }
    this.me.car = -1;
  }

  private carPub(i: number): CarNet {
    const lc = this.localCars.get(i)!;
    return { x: lc.x, y: 0, z: lc.z, q: quatFromYaw(lc.yaw), driver: lc.driver, vx: lc.vx, vz: lc.vz };
  }

  private gridSpot(i: number): LocalCar {
    const spread = (i - (CAR.count - 1) / 2) * ((TRACK.laneHalf - 2) * 2) / (CAR.count - 1);
    return { x: spread, z: TRACK.startZ - 10, yaw: Math.PI, vx: 0, vz: 0, driver: "" };
  }

  // snapshot every car's live position + velocity for collision reads
  private syncCars(): void {
    if (!this.room) return;
    for (let i = 0; i < CAR.count; i++) {
      const kin = this.cars[i];
      const v = this.room.objects.get<CarNet>("car:" + i);
      if (!v) {
        kin.exists = false;
        kin.vx = 0;
        kin.vz = 0;
        continue;
      }
      if (v.isMine && this.localCars.has(i)) {
        const lc = this.localCars.get(i)!;
        kin.x = lc.x;
        kin.z = lc.z;
        kin.yaw = lc.yaw;
        kin.vx = lc.vx;
        kin.vz = lc.vz;
      } else {
        kin.x = Number.isFinite(v.stateRaw.x) ? v.stateRaw.x : kin.x;
        kin.z = Number.isFinite(v.stateRaw.z) ? v.stateRaw.z : kin.z;
        kin.yaw = yawFromQuat(v.stateRaw.q);
        kin.vx = Number.isFinite(v.stateRaw.vx) ? v.stateRaw.vx : 0;
        kin.vz = Number.isFinite(v.stateRaw.vz) ? v.stateRaw.vz : 0;
      }
      kin.exists = true;
    }
  }

  // physics for every car I own (drive the one I'm in, coast the rest)
  private simulateOwnedCars(dt: number): void {
    if (!this.room) return;
    for (let i = 0; i < CAR.count; i++) {
      const v = this.room.objects.get<CarNet>("car:" + i);
      if (!v || !v.isMine || !this.localCars.has(i)) continue;
      const lc = this.localCars.get(i)!;
      const driving = this.me.car === i;

      if (driving) {
        let throttle = 0;
        let steer = 0;
        if (this.held("KeyW", "ArrowUp")) throttle += 1;
        if (this.held("KeyS", "ArrowDown")) throttle -= 1;
        if (this.held("KeyA", "ArrowLeft")) steer += 1;
        if (this.held("KeyD", "ArrowRight")) steer -= 1;

        const fs = Math.sin(lc.yaw);
        const fc = Math.cos(lc.yaw);
        if (throttle !== 0) {
          lc.vx += fs * CAR.accel * throttle * dt;
          lc.vz += fc * CAR.accel * throttle * dt;
        }
        const fwd = lc.vx * fs + lc.vz * fc;
        lc.yaw +=
          steer * CAR.turn * dt * clamp(Math.abs(fwd) / 5, 0, 1) * Math.sign(fwd || (throttle >= 0 ? 1 : -1));

        // grip: kill lateral slip so it drives like a car (regain control after a hit)
        const s2 = Math.sin(lc.yaw);
        const c2 = Math.cos(lc.yaw);
        const fwd2 = lc.vx * s2 + lc.vz * c2;
        const g = Math.min(1, CAR.grip * dt);
        lc.vx -= (lc.vx - fwd2 * s2) * g;
        lc.vz -= (lc.vz - fwd2 * c2) * g;
        const fwd3 = lc.vx * s2 + lc.vz * c2;
        const capped = clamp(fwd3, -CAR.maxRev, CAR.maxFwd);
        if (capped !== fwd3) {
          lc.vx += (capped - fwd3) * s2;
          lc.vz += (capped - fwd3) * c2;
        }
      }

      const drag = Math.exp(-CAR.drag * dt);
      lc.vx *= drag;
      lc.vz *= drag;
      lc.x += lc.vx * dt;
      lc.z += lc.vz * dt;

      this.resolveCarVsCars(lc, i);
      this.clampCar(lc);

      if (driving) {
        this.me.x = lc.x;
        this.me.z = lc.z;
        this.me.yaw = lc.yaw;
      }
      const kin = this.cars[i];
      kin.x = lc.x;
      kin.z = lc.z;
      kin.yaw = lc.yaw;
      kin.vx = lc.vx;
      kin.vz = lc.vz;
      kin.exists = true;
    }
  }

  // elastic car-vs-car: my car takes half the impulse; the other owner takes
  // the mirror half (using our published velocities) → both get knocked apart.
  private resolveCarVsCars(lc: LocalCar, i: number): void {
    const minD = CAR.collideR * 2;
    for (let j = 0; j < CAR.count; j++) {
      if (j === i) continue;
      const o = this.cars[j];
      if (!o.exists) continue;
      const dx = lc.x - o.x;
      const dz = lc.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d >= minD || d < 1e-4) continue;
      const nx = dx / d;
      const nz = dz / d;
      const push = (minD - d) * 0.5;
      lc.x += nx * push;
      lc.z += nz * push;
      const vn = (lc.vx - o.vx) * nx + (lc.vz - o.vz) * nz;
      if (vn < 0) {
        const jimp = -(1 + CAR.restitution) * vn * 0.5;
        lc.vx += jimp * nx;
        lc.vz += jimp * nz;
      }
    }
  }

  private clampCar(lc: LocalCar): void {
    const r = CAR.radius;
    const xl = FIELD.hx - r;
    if (lc.x > xl) {
      lc.x = xl;
      if (lc.vx > 0) lc.vx = -lc.vx * CAR.wallLoss;
    } else if (lc.x < -xl) {
      lc.x = -xl;
      if (lc.vx < 0) lc.vx = -lc.vx * CAR.wallLoss;
    }
    const zN = TRACK.startZ - r;
    const zS = -FIELD.hz + r;
    if (lc.z > zN) {
      lc.z = zN;
      if (lc.vz > 0) lc.vz = -lc.vz * CAR.wallLoss;
    } else if (lc.z < zS) {
      lc.z = zS;
      if (lc.vz < 0) lc.vz = -lc.vz * CAR.wallLoss;
    }
  }

  private checkFinish(): void {
    if (!this.room) return;
    if (!this.me.fin && this.prevZ > TRACK.finishZ && this.me.z <= TRACK.finishZ) {
      this.me.fin = 1;
      this.flashUntil = performance.now() + 2600;
      this.room.send("finish", { name: this.me.name });
      if (this.room.isHost) this.onFinish(this.me.name);
    }
    this.prevZ = this.me.z;
  }

  private onFinish(name: string): void {
    if (!this.room) return;
    if (this.room.shared.get("phase") !== "football") {
      this.room.shared.set("phase", "football");
      this.room.shared.set("winner", name);
    }
  }

  // ---- ball ------------------------------------------------------------
  private ownsBall(): boolean {
    return this.room?.objects.get("ball")?.isMine ?? false;
  }

  private stepBall(dt: number): void {
    const b = this.ball;
    b.vy -= BALL.gravity * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.y < BALL.radius) {
      b.y = BALL.radius;
      if (b.vy < 0) b.vy = -b.vy * BALL.restitution;
      const g = Math.exp(-BALL.rollDrag * dt * 1.6);
      b.vx *= g;
      b.vz *= g;
    } else {
      const a = Math.exp(-0.2 * dt);
      b.vx *= a;
      b.vz *= a;
    }
    // ball is contained to the pitch (z ∈ [-hz, finishZ]); cars pass through
    const bx = FIELD.hx - BALL.radius;
    if (b.x > bx) {
      b.x = bx;
      b.vx = -Math.abs(b.vx) * BALL.wallRestitution;
    } else if (b.x < -bx) {
      b.x = -bx;
      b.vx = Math.abs(b.vx) * BALL.wallRestitution;
    }
    const bzN = TRACK.finishZ - BALL.radius;
    const bzS = -FIELD.hz + BALL.radius;
    if (b.z > bzN) {
      b.z = bzN;
      b.vz = -Math.abs(b.vz) * BALL.wallRestitution;
    } else if (b.z < bzS) {
      b.z = bzS;
      b.vz = Math.abs(b.vz) * BALL.wallRestitution;
    }
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > BALL.maxSpeed) {
      const k = BALL.maxSpeed / sp;
      b.vx *= k;
      b.vz *= k;
    }
  }

  // owner bounces the ball off car bodies and lets a moving car launch it
  private resolveBallVsCars(): void {
    const b = this.ball;
    for (let i = 0; i < CAR.count; i++) {
      const c = this.cars[i];
      if (!c.exists) continue;
      const hit = this.circleVsOBB(b.x, b.z, BALL.radius + 0.05, c.x, c.z, c.yaw, CAR.halfL, CAR.halfW);
      if (!hit) continue;
      b.x += hit.nx * hit.depth;
      b.z += hit.nz * hit.depth;
      const vn = b.vx * hit.nx + b.vz * hit.nz;
      if (vn < 0) {
        b.vx -= (1 + BALL.carBounce) * vn * hit.nx;
        b.vz -= (1 + BALL.carBounce) * vn * hit.nz;
      }
      const cvn = c.vx * hit.nx + c.vz * hit.nz;
      if (cvn > 0) {
        b.vx += hit.nx * cvn * BALL.ramBoost;
        b.vz += hit.nz * cvn * BALL.ramBoost;
        b.vy += Math.min(3, cvn * 0.14);
      }
    }
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > BALL.maxSpeed) {
      const k = BALL.maxSpeed / sp;
      b.vx *= k;
      b.vz *= k;
    }
  }

  private circleVsOBB(
    px: number,
    pz: number,
    r: number,
    cx: number,
    cz: number,
    yaw: number,
    hl: number,
    hw: number,
  ): { nx: number; nz: number; depth: number } | null {
    const s = Math.sin(yaw);
    const co = Math.cos(yaw);
    const relx = px - cx;
    const relz = pz - cz;
    const lz = relx * s + relz * co;
    const lx = relx * co - relz * s;
    const clz = clamp(lz, -hl, hl);
    const clx = clamp(lx, -hw, hw);
    const ddx = lx - clx;
    const ddz = lz - clz;
    const dSq = ddx * ddx + ddz * ddz;
    if (dSq > r * r) return null;
    let nlx: number;
    let nlz: number;
    let depth: number;
    if (dSq > 1e-8) {
      const d = Math.sqrt(dSq);
      nlx = ddx / d;
      nlz = ddz / d;
      depth = r - d;
    } else {
      const ox = hw - Math.abs(lx);
      const oz = hl - Math.abs(lz);
      if (ox < oz) {
        nlx = lx >= 0 ? 1 : -1;
        nlz = 0;
        depth = r + ox;
      } else {
        nlx = 0;
        nlz = lz >= 0 ? 1 : -1;
        depth = r + oz;
      }
    }
    return { nx: nlx * co + nlz * s, nz: -nlx * s + nlz * co, depth };
  }

  private handleBall(dt: number): void {
    if (!this.room) return;
    const view = this.room.objects.get<BallNet>("ball");
    if (!view) return;
    const mine = view.isMine;
    const bx = mine ? this.ball.x : Number.isFinite(view.stateRaw.x) ? view.stateRaw.x : 0;
    const by = mine ? this.ball.y : Number.isFinite(view.stateRaw.y) ? view.stateRaw.y : BALL.radius;
    const bz = mine ? this.ball.z : Number.isFinite(view.stateRaw.z) ? view.stateRaw.z : 0;

    const inCar = this.me.car >= 0;
    const myR = inCar ? CAR.radius : PLAYER.radius;
    const dx = bx - this.me.x;
    const dz = bz - this.me.z;
    const d = Math.hypot(dx, dz);

    if (d < myR + BALL.radius + 0.12 && !mine) {
      this.room.objects.claim("ball");
      this.ball.x = bx;
      this.ball.y = Math.max(by, BALL.radius);
      this.ball.z = bz;
      this.ball.vx = 0;
      this.ball.vz = 0;
      if (this.ball.vy < 0) this.ball.vy = 0;
      if (!inCar) {
        const nx = d > 1e-3 ? dx / d : Math.sin(this.me.yaw);
        const nz = d > 1e-3 ? dz / d : Math.cos(this.me.yaw);
        this.ball.vx += nx * BALL.stealBump;
        this.ball.vz += nz * BALL.stealBump;
      }
    }

    if (mine && !inCar) {
      const tx = this.me.x + Math.sin(this.me.yaw) * BALL.dribbleAhead;
      const tz = this.me.z + Math.cos(this.me.yaw) * BALL.dribbleAhead;
      const md = Math.hypot(tx - this.ball.x, tz - this.ball.z);
      if (md < BALL.dribbleRange) {
        this.ball.vx += (tx - this.ball.x) * BALL.magnet * dt;
        this.ball.vz += (tz - this.ball.z) * BALL.magnet * dt;
        this.ball.vx *= 1 - 2 * dt;
        this.ball.vz *= 1 - 2 * dt;
      }
    }
  }

  private kick(): void {
    if (!this.room) return;
    const view = this.room.objects.get<BallNet>("ball");
    if (!view) return;
    const bx = view.isMine ? this.ball.x : Number.isFinite(view.stateRaw.x) ? view.stateRaw.x : 0;
    const bz = view.isMine ? this.ball.z : Number.isFinite(view.stateRaw.z) ? view.stateRaw.z : 0;
    const by = view.isMine ? this.ball.y : Number.isFinite(view.stateRaw.y) ? view.stateRaw.y : BALL.radius;
    if (Math.hypot(bx - this.me.x, bz - this.me.z) > PLAYER.radius + BALL.radius + 2.2) return;
    if (!view.isMine) {
      this.room.objects.claim("ball");
      this.ball.x = bx;
      this.ball.z = bz;
      this.ball.y = Math.max(by, BALL.radius);
      this.ball.vx = 0;
      this.ball.vz = 0;
    }
    this.ball.vx += Math.sin(this.me.yaw) * BALL.kick;
    this.ball.vz += Math.cos(this.me.yaw) * BALL.kick;
    this.ball.vy += BALL.kickUp;
    this.playKick();
  }

  // ---- network tick ----------------------------------------------------
  private tick(): void {
    const room = this.room;
    if (!room) return;

    room.me.set({
      x: this.me.x,
      z: this.me.z,
      q: quatFromYaw(this.me.yaw),
      car: this.me.car,
      fin: this.me.fin,
    });

    // ball only exists once football has started (a player crossed the finish)
    const football = room.shared.get("phase") === "football";
    const bview = room.objects.get<BallNet>("ball");
    if (!bview) {
      if (room.isHost && football) {
        this.ball.x = 0;
        this.ball.y = BALL.radius;
        this.ball.z = 0;
        this.ball.vx = this.ball.vy = this.ball.vz = 0;
        room.objects.claim("ball");
        room.objects.set("ball", { x: 0, y: BALL.radius, z: 0 });
      }
    } else if (bview.isMine) {
      room.objects.set("ball", { x: this.ball.x, y: this.ball.y, z: this.ball.z });
    }

    // cars: host seeds the start grid; each owner publishes its car
    for (let i = 0; i < CAR.count; i++) {
      const v = room.objects.get<CarNet>("car:" + i);
      if (!v) {
        if (room.isHost) {
          this.localCars.set(i, this.gridSpot(i));
          room.objects.claim("car:" + i);
          room.objects.set("car:" + i, this.carPub(i));
        }
      } else if (v.isMine) {
        if (!this.localCars.has(i)) {
          this.localCars.set(i, {
            x: v.stateRaw.x ?? 0,
            z: v.stateRaw.z ?? 0,
            yaw: yawFromQuat(v.stateRaw.q),
            vx: 0,
            vz: 0,
            driver: v.stateRaw.driver ?? "",
          });
        }
        room.objects.set("car:" + i, this.carPub(i));
      } else if (this.me.car !== i) {
        this.localCars.delete(i);
      }
    }
  }

  // ---- rendering -------------------------------------------------------
  private playerMesh(id: string, name: string): PlayerMeshRec {
    let rec = this.playerMeshes.get(id);
    if (rec) return rec;
    const color = colorForId(id);
    const group = new THREE.Group();
    group.add(skeletonClone(this.assets.playerProto));
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.82, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);
    const tag = makeNametag(name, color);
    tag.position.y = 2.35;
    group.add(tag);
    this.scene.add(group);
    rec = { group, tag, lastX: 0, lastZ: 0 };
    this.playerMeshes.set(id, rec);
    return rec;
  }

  private removePlayer(id: string): void {
    const rec = this.playerMeshes.get(id);
    if (!rec) return;
    this.scene.remove(rec.group);
    this.playerMeshes.delete(id);
  }

  private renderEntities(now: number): void {
    const room = this.room;
    if (!room) return;
    const live = new Set<string>();

    for (const [id, p] of room.players) {
      live.add(id);
      const isSelf = id === room.id;
      const rec = this.playerMesh(id, isSelf ? this.me.name : p.name);
      const inCar = isSelf ? this.me.car : p.stateRaw.car ?? -1;
      let px: number;
      let pz: number;
      if (isSelf) {
        px = this.me.x;
        pz = this.me.z;
      } else {
        px = Number.isFinite(p.state.x) ? p.state.x : Number.isFinite(p.stateRaw.x) ? p.stateRaw.x : rec.lastX;
        pz = Number.isFinite(p.state.z) ? p.state.z : Number.isFinite(p.stateRaw.z) ? p.stateRaw.z : rec.lastZ;
      }
      rec.lastX = px;
      rec.lastZ = pz;
      rec.group.visible = inCar < 0; // hidden while driving (the car represents them)
      if (inCar >= 0) continue;
      rec.group.position.set(px, Math.sin(now * 0.008 + id.length) * 0.03, pz);
      if (isSelf) rec.group.rotation.y = this.me.yaw;
      else if (p.state.q) rec.group.quaternion.fromArray(p.state.q);
    }

    for (const [id, rec] of this.playerMeshes) {
      if (!live.has(id)) {
        this.scene.remove(rec.group);
        this.playerMeshes.delete(id);
      }
    }

    for (let i = 0; i < CAR.count; i++) {
      const v = room.objects.get<CarNet>("car:" + i);
      const cm = this.carMeshes[i];
      if (!v) {
        cm.group.visible = false;
        continue;
      }
      cm.group.visible = true;
      let x: number;
      let z: number;
      let q: number[] | undefined;
      let driver: string;
      if (v.isMine && this.localCars.has(i)) {
        const lc = this.localCars.get(i)!;
        x = lc.x;
        z = lc.z;
        q = quatFromYaw(lc.yaw);
        driver = lc.driver;
      } else {
        x = Number.isFinite(v.state.x) ? v.state.x : Number.isFinite(v.stateRaw.x) ? v.stateRaw.x : cm.lastX;
        z = Number.isFinite(v.state.z) ? v.state.z : Number.isFinite(v.stateRaw.z) ? v.stateRaw.z : cm.lastZ;
        q = v.state.q;
        driver = v.stateRaw.driver ?? "";
      }
      cm.lastX = x;
      cm.lastZ = z;
      cm.group.position.set(x, 0, z);
      if (q) cm.group.quaternion.fromArray(q);
      const driven = driver !== "";
      cm.beacon.visible = driven;
      if (driven) {
        const mat = cm.beacon.material as THREE.MeshStandardMaterial;
        const c = colorForId(driver);
        mat.color.copy(c);
        mat.emissive.copy(c);
      }
    }

    const bv = room.objects.get<BallNet>("ball");
    if (bv) {
      this.ballMesh.visible = true;
      const bx = bv.isMine ? this.ball.x : Number.isFinite(bv.state.x) ? bv.state.x : this.lastBall.x;
      const by = bv.isMine ? this.ball.y : Number.isFinite(bv.state.y) ? bv.state.y : this.lastBall.y;
      const bz = bv.isMine ? this.ball.z : Number.isFinite(bv.state.z) ? bv.state.z : this.lastBall.z;
      this.rollBall(bx, by, bz);
      this.ballMesh.position.set(bx, by, bz);
    } else {
      this.ballMesh.visible = false;
    }
  }

  private rollBall(x: number, y: number, z: number): void {
    const dx = x - this.lastBall.x;
    const dz = z - this.lastBall.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 1e-4) {
      const axis = new THREE.Vector3(dz, 0, -dx).normalize();
      this.ballMesh.rotateOnWorldAxis(axis, dist / BALL.radius);
    }
    this.lastBall.set(x, y, z);
  }

  private followCamera(): void {
    const tx = this.me.x;
    const tz = this.me.z;
    this.camera.position.x = lerp(this.camera.position.x, tx, CAMERA.lerp);
    this.camera.position.z = lerp(this.camera.position.z, tz + CAMERA.back, CAMERA.lerp);
    this.camera.position.y = lerp(this.camera.position.y, CAMERA.up, CAMERA.lerp);
    this.camera.lookAt(tx, 1.2, tz);
  }

  // ---- audio & hud -----------------------------------------------------
  private playKick(): void {
    if (!this.audioReady) return;
    const audio = new THREE.Audio(this.listener);
    audio.setBuffer(this.assets.sfx.kick);
    audio.setVolume(0.9);
    audio.play();
  }

  private refreshHud(now: number): void {
    const room = this.room;
    if (!room) return;
    const football = room.shared.get("phase") === "football";
    this.hud.banner.textContent = football
      ? "⚽ FOOTBALL — grab the ball!"
      : "🏁 RACE — first to the finish line!";
    this.hud.players.textContent = "Players: " + room.players.size;
    const winner = room.shared.get("winner");
    if (typeof winner === "string" && winner) {
      this.hud.winner.classList.remove("hidden");
      this.hud.winner.textContent = "🏆 " + winner + " won the race";
    } else {
      this.hud.winner.classList.add("hidden");
    }
    this.hud.flash.classList.toggle("hidden", now >= this.flashUntil);
  }
}
