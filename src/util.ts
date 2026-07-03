import * as THREE from "three";

// Guarded querySelector — throws early if the element is missing.
export function $<T extends Element>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error("missing element: " + sel);
  return el;
}

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// Deterministic bright color from a session id — gives every player a stable hue.
export function colorForId(id: string): THREE.Color {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  const hue = (h % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.62, 0.55);
}

const _yawQuat = new THREE.Quaternion();
const _yawAxis = new THREE.Vector3(0, 1, 0);
export function quatFromYaw(yaw: number): number[] {
  return _yawQuat.setFromAxisAngle(_yawAxis, yaw).toArray();
}

const _eul = new THREE.Euler(0, 0, 0, "YXZ");
const _q = new THREE.Quaternion();
export function yawFromQuat(q: number[] | undefined): number {
  if (!q || q.length < 4) return 0;
  _q.fromArray(q);
  _eul.setFromQuaternion(_q);
  return _eul.y;
}
