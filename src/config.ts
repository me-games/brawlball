// ---------------------------------------------------------------------------
// Brawlball — tuning, asset paths, and networked-state shapes.
// (Networked state MUST be a `type`, not an `interface`, so it satisfies the
//  multiplayer SDK's `Record<string, unknown>` constraint.)
//
// World layout (XZ plane, Y up), a single rectangle x∈[-hx,hx]:
//   pitch  : z ∈ [-hz, finishZ]   (football, ball stays here)
//   track  : z ∈ [finishZ, startZ] (racing straight; cars start at startZ)
// ---------------------------------------------------------------------------

export const ASSETS = {
  player: "./assets/models/low-poly-stylized-human-character-athletic-soccer.glb",
  car: "./assets/models/small-compact-arena-car-clean-smooth-rounded-body.glb",
  ball: "./assets/models/soccer-ball-clean-white-with-subtle-grey-pentagon.glb",
  skybox: "./assets/skybox/clear-blue-daytime-sky-soft-scattered-white-clouds.jpg",
  grass: "./assets/textures/clean-mowed-green-grass-sports-field-seamless-tile/basecolor.png",
  sfxKick: "./assets/sfx/solid-football-kick-thump-punchy-short.mp3",
} as const;

export const FIELD = { hx: 20, hz: 25, wallH: 2.6 }; // pitch half-extents

export const TRACK = {
  finishZ: 25, // crossing south past this line finishes the race → football
  startZ: 145, // start grid / back wall of the track
  laneHalf: 16, // painted road half-width (start grid spread)
};

export const PLAYER = {
  radius: 0.7,
  height: 1.8,
  speed: 10,
};

export const CAR = {
  count: 8,
  radius: 1.9, // rough radius for walls / entering range
  accel: 28, // engine force
  maxFwd: 27,
  maxRev: 10,
  turn: 2.4, // rad / second at speed
  grip: 6, // how fast a driven car aligns its velocity to its facing
  drag: 0.7, // rolling resistance (velocity kept ≈ e^-drag*dt)
  restitution: 0.7, // bounciness of car-vs-car impacts
  wallLoss: 0.4, // velocity kept when hitting a wall
  collideR: 1.7, // car-vs-car separation radius
  halfL: 2.2, // collision box half-length (forward axis)
  halfW: 1.1, // collision box half-width (side axis)
};

export const BALL = {
  radius: 0.5,
  gravity: 24,
  restitution: 0.55,
  wallRestitution: 0.72,
  rollDrag: 0.9,
  kick: 17,
  kickUp: 4.5,
  dribbleAhead: 1.35,
  dribbleRange: 2.6,
  magnet: 11,
  stealBump: 5,
  carBounce: 0.6, // ball velocity kept when it bounces off a car body
  ramBoost: 1.2, // how much of a moving car's speed transfers to the ball
  maxSpeed: 42,
};

export const CAMERA = { back: 20, up: 21, lerp: 0.1, fov: 55 };
export const NET_TICK_MS = 66; // ~15 Hz publish rate
export const CAR_ENTER_RANGE = 3.6;

// --- networked state shapes (types, never interfaces) ---
export type PlayerNet = {
  x: number;
  z: number;
  q: number[]; // facing quaternion
  car: number; // index of car being driven, or -1 on foot
  fin: number; // 1 once this player has crossed the finish line
};

export type BallNet = { x: number; y: number; z: number };

export type CarNet = {
  x: number;
  y: number;
  z: number;
  q: number[];
  driver: string; // session id of driver, or "" when parked
  vx: number; // published velocity → lets everyone resolve knockback consistently
  vz: number;
};
