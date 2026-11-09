// Shared layout: terrain shape, ramp, rock scatter and the car's timeline.
// World: Y up, the car drives toward -Z, straight at the low sun.

export const V = 36;                       // m/s on the ground
export const RAMP = { start: -138, lip: -150, height: 2.5 };
export const FPS = 24, DURATION = 13.5;

// cheap deterministic value noise
const hash = (i, j) => { const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453; return s - Math.floor(s); };
const smooth = (t) => t * t * (3 - 2 * t);
export function noise(x, z) {
  const i = Math.floor(x), j = Math.floor(z), fx = smooth(x - i), fz = smooth(z - j);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz;
}
const fbm = (x, z) => noise(x, z) * 0.5 + noise(x * 2.1, z * 2.1) * 0.25 + noise(x * 4.3, z * 4.3) * 0.125;
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return smooth(t); };

export function rampHeight(x, z) {
  const side = sstep(6, 4, Math.abs(x));
  if (side <= 0) return 0;
  const { start, lip, height } = RAMP;
  if (z <= start && z >= lip) return height * Math.pow((start - z) / (start - lip), 1.35) * side;
  if (z < lip && z > lip - 1.2) return height * (1 - (lip - z) / 1.2) * side;
  return 0;
}

export function terrainHeight(x, z) {
  const ax = Math.abs(x);
  let h = 0;
  // windrow berms either side of the haul road
  h += 1.3 * Math.exp(-((ax - 10.3) ** 2) / 2.2) * (0.75 + 0.5 * noise(z * 0.15, x > 0 ? 3 : 7));
  // quarry floor: gentle lumps
  h += sstep(12, 20, ax) * (fbm(x * 0.05, z * 0.05) * 1.6 + fbm(x * 0.4, z * 0.4) * 0.25);
  // benched walls: 9 m faces every 13 m from |x| = 70
  const wob = (fbm(z * 0.02, x > 0 ? 11 : 17) - 0.45) * 14;
  const u = ax - 70 - wob;
  if (u > 0) {
    const k = Math.min(5, Math.floor(u / 13)), lu = u - k * 13;
    h += 9 * k + (k < 5 ? 9 * sstep(0, 3.2, lu) : 0) + fbm(x * 0.3, z * 0.3) * 0.8;
  }
  // road surface: a touch of roughness only
  h = ax < 7 ? fbm(x * 0.7, z * 0.7) * 0.04 : h;
  return h + rampHeight(x, z);
}

// Rocks: on berms, on the floor, at the toe of each bench face; big boulders near the jump.
export const ROCKS = (() => {
  const out = []; let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let n = 0; n < 260; n++) {
    const sideSign = rnd() < 0.5 ? -1 : 1, kind = rnd();
    const z = 180 - rnd() * 640;
    let x, s;
    if (kind < 0.45) { x = sideSign * (9 + rnd() * 3.5); s = 0.6 + rnd() * 1.4; }
    else if (kind < 0.8) { x = sideSign * (14 + rnd() * 55); s = 1 + rnd() * 3.5; }
    else { const b = Math.floor(rnd() * 4); x = sideSign * (70 + b * 13 + 1 + rnd() * 3); s = 2 + rnd() * 4; }
    out.push({ x, z, s, sy: 0.7 + rnd() * 0.6, yaw: rnd() * 6.28, variant: Math.floor(rnd() * 8) });
  }
  // flank the ramp with two big boulders
  out.push({ x: -7.5, z: RAMP.lip + 3, s: 4.2, sy: 1, yaw: 0.4, variant: 0 });
  out.push({ x: 7.8, z: RAMP.lip + 5, s: 3.6, sy: 1.1, yaw: 2.1, variant: 2 });
  return out;
})();

// Time: screen time T, sim time s. Slow motion through the jump.
export function rate(T) {
  const k = [[0, 1], [7.33, 1], [7.75, 0.28], [9.5, 0.28], [10.3, 1], [99, 1]];
  for (let i = 0; i < k.length - 1; i++) if (T <= k[i + 1][0]) {
    const t = (T - k[i][0]) / (k[i + 1][0] - k[i][0]);
    return k[i][1] + (k[i + 1][1] - k[i][1]) * smooth(t);
  }
  return 1;
}
export function simTime(T) {
  let s = 0; const dt = 1 / 480;
  for (let t = 0; t < T; t += dt) s += rate(t) * dt;
  return s;
}

const G = 9.81;
const Z0 = RAMP.start + V * 7.0;           // ramp start reached at s = 7.0
const rampLen = RAMP.start - RAMP.lip;
const lipSlope = (RAMP.height * 1.35) / rampLen;
const launchAngle = Math.atan(lipSlope);
const vy0 = V * Math.sin(launchAngle), vz = V * Math.cos(launchAngle);
const sLip = 7.0 + rampLen / V;
const flight = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G * RAMP.height)) / G;
export const LAND = { s: sLip + flight, z: RAMP.lip - vz * flight };

// Car rig pose at sim time s: position of the contact centre, pitch (rad, + = nose up), body bounce.
export function carPose(s) {
  if (s < sLip) {
    const z = Z0 - V * s;
    const y = rampHeight(0, z);
    const e = 0.4, zf = Math.max(z - e, RAMP.lip + 0.01);
    const slope = (rampHeight(0, zf) - rampHeight(0, zf + 2 * e)) / (2 * e);
    const rumble = 0.012 * Math.sin(s * 47) + 0.008 * Math.sin(s * 83 + 1);
    return { z, y: y + rumble, pitch: Math.atan(slope) + 0.004 * Math.sin(s * 31), roll: 0.006 * Math.sin(s * 23), air: 0 };
  }
  if (s < LAND.s) {
    const t = s - sLip, f = t / flight;
    return {
      z: RAMP.lip - vz * t, y: RAMP.height + vy0 * t - 0.5 * G * t * t,
      pitch: launchAngle * (1 - f) + -0.13 * f * f, roll: 0.05 * Math.sin(f * Math.PI), air: Math.min(1, t / 0.15),
    };
  }
  const t = s - LAND.s, v = V * Math.max(0.82, 1 - t * 0.06);
  const decay = Math.exp(-t * 5.5);
  return {
    z: LAND.z - v * t, y: -0.16 * decay * Math.cos(t * 17) + 0.01 * Math.sin(t * 47),
    pitch: (-0.13 + 0.1 * (1 - Math.exp(-t * 9))) * decay * Math.cos(t * 13) + 0.004 * Math.sin(t * 31),
    roll: 0.03 * decay * Math.sin(t * 15), air: 0,
  };
}

export function wheelAngle(s) {
  // distance rolled / radius; in the air the wheels keep spinning at speed
  return -(V * s) / 0.335;
}

// Gravel thrown up where the car lands: velocities in m/s (sim time), relative to the landing point.
export const SPRAY = (() => {
  const out = []; let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let n = 0; n < 70; n++) {
    const side = rnd() < 0.5 ? -1 : 1, rear = rnd() < 0.5;
    out.push({
      x0: side * (0.6 + rnd() * 0.4), z0: rear ? 1.3 : -1.67,
      vx: side * (1.5 + rnd() * 7), vy: 2 + rnd() * 7, vz: -(4 + rnd() * 22),
      s: 0.06 + rnd() * 0.22, spin: (rnd() - 0.5) * 30, variant: Math.floor(rnd() * 8), delay: rear ? 0.05 : 0,
    });
  }
  return out;
})();
export function sprayPos(p, t) {
  // t: sim seconds since landing
  const tt = Math.max(0, t - p.delay);
  const tHit = (p.vy + Math.sqrt(p.vy * p.vy)) / G; // back to y=0
  const tc = Math.min(tt, tHit);
  const slide = Math.max(0, tt - tHit) * 0.0;
  return [p.x0 + p.vx * tc, Math.max(0, p.vy * tc - 0.5 * G * tc * tc) + p.s * 0.5, LAND.z + p.z0 + p.vz * tc + slide];
}
