// Horde simulation v3: zombie types, size variety, props as obstacles, time-controlled clock.
import fs from 'node:fs';
const common = fs.readFileSync(new URL('./common.slang', import.meta.url), 'utf8');

const noiseFn = `
float vnoise(float2 q) {
    float2 i0 = floor(q), f = q - i0; f = f * f * (3. - 2. * f);
    uint ix = uint(int(i0.x) + 100000), iz = uint(int(i0.y) + 100000);
    float a = rnd(ix * 73856093u ^ iz * 19349663u), b = rnd((ix + 1u) * 73856093u ^ iz * 19349663u);
    float c = rnd(ix * 73856093u ^ (iz + 1u) * 19349663u), d = rnd((ix + 1u) * 73856093u ^ (iz + 1u) * 19349663u);
    return lerp(lerp(a, b, f.x), lerp(c, d, f.x), f.y);
}`;
const heightFn = `
float groundAt(float x, float z) {
    float fx = clamp((x - GX0) / HCELL, 0., float(HW - 2)), fz = clamp((z - GZ0) / HCELL, 0., float(HH - 2));
    uint ix = uint(fx), iz = uint(fz); float tx = fx - float(ix), tz = fz - float(iz);
    float a = height_load(iz * HW + ix), b = height_load(iz * HW + ix + 1);
    float c = height_load((iz + 1) * HW + ix), d = height_load((iz + 1) * HW + ix + 1);
    return lerp(lerp(a, b, tx), lerp(c, d, tx), tz);
}`;

// o: { N, NEAR, P (poses), POSE_DT, SPEED, ZBAND, SLOTS: [{kind, rank}] (20), COUNTS, OBST: [[x, z, r]] }
export function programs(o) {
  const { N, NEAR, P, POSE_DT, SPEED, ZBAND, SLOTS, COUNTS, OBST, CAMLINE, IMPACTS, NUKE, AREA } = o;
  const S = SLOTS.length;
  const impacts = `
static const int NI = ${IMPACTS.length};
static const float4 IMP[${IMPACTS.length}] = { ${IMPACTS.map((m) => `float4(${m.map((v) => v.toFixed(3)).join(', ')})`).join(', ')} };
// a strike at (x, z) at sim time t throws everything within radius r outward and up
// the shockwave: a front expanding from ground zero; it throws what it passes, vaporises what is close
static const float3 NUKE = float3(${NUKE.x.toFixed(2)}, ${NUKE.z.toFixed(2)}, ${NUKE.t.toFixed(3)});
static const float NUKE_C = ${NUKE.c.toFixed(2)};
int shock(uint id, float3 p, float t, float dt, out float3 vel) {
    vel = float3(0.);
    if (t + dt < NUKE.z) return 0;
    float2 d = p.xz - NUKE.xy; float l = length(d);
    float r0 = NUKE_C * (t - NUKE.z), r1 = NUKE_C * (t + dt - NUKE.z);
    if (!(l > r0 && l <= r1)) return 0;
    if (l < ${NUKE.vapour.toFixed(1)}) return 2;
    float s = saturate(1. - l / ${NUKE.reach.toFixed(1)});
    float2 dir = d / max(l, .01);
    vel = float3(dir.x * (5. + 30. * s), 3. + 16. * s + rnd(id * 5u + 3u) * 5. * s, dir.y * (5. + 30. * s));
    return 1;
}
bool blast(uint id, float3 p, float t, float dt, out float3 vel) {
    vel = float3(0.);
    for (int k = 0; k < NI; k++) {
        float4 m = IMP[k];
        if (m.z > t - 1e-5 && m.z <= t + dt) {
            float2 d = p.xz - m.xy; float l = length(d);
            if (l < m.w) {
                float s = 1. - l / m.w;
                float2 dir = l > .05 ? d / l : float2(rnd(id) - .5, rnd(id + 7u) - .5);
                vel = float3(dir.x * (4. + 13. * s), 5. + 14. * s + rnd(id * 3u + 11u) * 4., dir.y * (4. + 13. * s));
                return true;
            }
        }
    }
    return false;
}`;
  const camLine = `static const float CAM_X = ${CAMLINE[0]}; static const float CAM_Z0 = ${CAMLINE[1]}; static const float CAM_Z1 = ${CAMLINE[2]};`;
  const obstacles = `
static const int NO = ${OBST.length};
static const float3 OBST[${Math.max(1, OBST.length)}] = { ${(OBST.length ? OBST : [[0, 0, 0]]).map((b) => `float3(${b.map((v) => v.toFixed(2)).join(', ')})`).join(', ')} };
float2 outOfProps(float2 q) {
    for (int k = 0; k < NO; k++) {
        float2 d = q - OBST[k].xy; float l = length(d);
        if (l < OBST[k].z) q = OBST[k].xy + (l > 1e-3 ? d / l : float2(1., 0.)) * OBST[k].z;
    }
    return q;
}`;
  const variantFns = `
static const uint SLOT_KIND[${S}] = { ${SLOTS.map((s) => `${s.kind}u`).join(', ')} };
static const uint SLOT_RANK[${S}] = { ${SLOTS.map((s) => `${s.rank}u`).join(', ')} };
static const uint COUNT[${COUNTS.length}] = { ${COUNTS.map((c) => `${c}u`).join(', ')} };
uint variantOf(uint id) { return SLOT_KIND[id % ${S}u]; }
uint variantRow(uint id) { return (id / ${S}u) * COUNT[variantOf(id)] + SLOT_RANK[id % ${S}u]; }
float sizeOf(uint id) { return .9 + rnd(id * 17u + 3u) * .2; }`;

  const progs = {
    tick: {
      bindings: ['clock'], dispatch: 1,
      source: `import vork;
struct Inputs {};
float simSpeed(float T) {
    const int K = ${SPEED.length};
    float ts[K] = { ${SPEED.map((k) => k[0].toFixed(4)).join(', ')} };
    float vs[K] = { ${SPEED.map((k) => k[1].toFixed(4)).join(', ')} };
    if (T <= ts[0]) return vs[0];
    for (int k = 0; k < K - 1; k++) if (T <= ts[k + 1]) { float u = (T - ts[k]) / (ts[k + 1] - ts[k]); u = u * u * (3. - 2. * u); return lerp(vs[k], vs[k + 1], u); }
    return vs[K - 1];
}
void compute(ComputeContext c, Inputs i) { float dt = c.dt * simSpeed(c.time); clock_store(0, clock_load(0) + dt); clock_store(1, dt); }`,
    },
    init: {
      bindings: ['p', 'v', 'aux', 'height', 'next_p', 'next_v', 'next_aux'], dispatch: N,
      source: `import vork;\n${common}\n${heightFn}\n${obstacles}\n${noiseFn}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    // packed pit with clumps and gaps: rejection-sample a low-frequency density field
    float x = 0., z = 0.;
    for (uint k = 0; k < 10; k++) {
        x = (rnd(id * 31 + k * 7 + 1) * 2. - 1.) * ${AREA[0]};
        z = ${AREA[1]} + rnd(id * 31 + k * 7 + 2) * ${AREA[2] - AREA[1]};
        float d = vnoise(float2(x, z) / 60.) * .5 + vnoise(float2(x, z) / 14. + 17.) * .5;
                if (d > .34 || k == 9) break;
    }
    float2 q = outOfProps(float2(x, z)); x = q.x; z = q.y;
    float y = groundAt(x, z);
    float yaw = -sign(x) * 1.5708 + (rnd(id * 7 + 5) - .5) * 2.4;
    p_store(id, float3(x, y, z)); v_store(id, float3(0.)); aux_store(id, float4(0., yaw, 0., 0.));
    next_p_store(id, float3(x, y, z)); next_v_store(id, float3(0.)); next_aux_store(id, float4(0., yaw, 0., 0.));
}`,
    },
    clear: { bindings: ['grid'], dispatch: 1400 * 1400 * 4, source: `import vork;\nstruct Inputs {};\nvoid compute(ComputeContext c, Inputs i) { grid_store(c.id.x, 0xffffffffu); }` },
    grid: {
      bindings: ['p', 'aux', 'grid'], dispatch: N,
      source: `import vork;\n${common}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    if (aux_load(id).x != 0.) return;
    float3 p = p_load(id);
    int cx = int(floor(p.x - GX0)), cz = int(floor(p.z - GZ0));
    if (cx < 0 || cz < 0 || cx >= int(GW) || cz >= int(GH)) return;
    uint base = (uint(cz) * GW + uint(cx)) * 4u;
    uint key = (hash(id + c.seed) & 0xfff00000u) | id;
    for (uint j = 0; j < 4 && key != 0xffffffffu; j++) { uint old = grid_atomic_min(base + j, key); key = max(key, old); }
}`,
    },
    advance: {
      bindings: ['p', 'v', 'aux', 'grid', 'height', 'next_p', 'next_v', 'next_aux', 'clock'], dispatch: N,
      source: `import vork;\n${common}\n${heightFn}\n${obstacles}\n${camLine}\n${impacts}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    float3 p = p_load(id), v = v_load(id); float4 a = aux_load(id);
    float t = clock_load(0), dt = clock_load(1);
    float cz = carZ(t);
    if (a.x == 0.) {
        float2 tgt = float2(0., cz + 30.);
        float2 toT = tgt - p.xz; float dT = length(toT);
        bool ahead = p.z > cz - 6.;
        float surge = ahead ? saturate(1.4 - dT / 200.) : 0.;
        float speed = lerp(.45 + rnd(id * 13 + 1) * .3, 1.5 + rnd(id * 13 + 2) * 1.3, surge);
        float2 to_road = float2(-sign(p.x) * min(1., abs(p.x) / 4.), .15 * sin(float(id) * .37 + t * .1));
        float2 desire = normalize(to_road + float2(1e-4, 0.));
        if (surge > 0. && dT > .5) { float2 mixd = lerp(desire, toT / dT, saturate(surge * 1.6)); if (dot(mixd, mixd) > 1e-6) desire = normalize(mixd); }
        float2 push = float2(0.);
        int gx = int(floor(p.x - GX0)), gz = int(floor(p.z - GZ0));
        for (int oz = -1; oz <= 1; oz++) for (int ox = -1; ox <= 1; ox++) {
            int nx = gx + ox, nz = gz + oz;
            if (nx < 0 || nz < 0 || nx >= int(GW) || nz >= int(GH)) continue;
            uint base = (uint(nz) * GW + uint(nx)) * 4u;
            for (uint j = 0; j < 4; j++) {
                uint key = grid_load(base + j); if (key == 0xffffffffu) break;
                uint o = key & 0xfffffu; if (o == id) continue;
                float2 d = p.xz - p_load(o).xz; float d2 = dot(d, d);
                if (d2 < .64 && d2 > 1e-6) push += d / d2 * (.64 - d2);
            }
        }
        float cx = p.x - CAM_X;
        if (abs(cx) < 1.3 && p.z > CAM_Z0 && p.z < CAM_Z1) push.x += sign(cx + 1e-3) * (1.3 - abs(cx)) * 3.;
        float2 vel = desire * speed + push * .9;
        float vl = length(vel); if (vl > 3.) vel *= 3. / vl;
        float2 nxz = outOfProps(p.xz + vel * dt);
        float yaw = a.y;
        float2 moved = nxz - p.xz;
        float2 face = dot(moved, moved) > 1e-8 ? moved : desire;
        if (length(face) > 1e-4) {
            float target = atan2(face.x, face.y);
            float dy = target - yaw; dy = dy - 6.2831853 * floor((dy + 3.14159265) / 6.2831853);
            yaw += clamp(dy, -3. * dt, 3. * dt);
        }
        float3 np = float3(nxz.x, groundAt(nxz.x, nxz.y), nxz.y);
        float3 bv;
        int sk = shock(id, np, t, dt, bv);
        if (sk == 2) { next_p_store(id, float3(np.x, -80., np.z)); next_v_store(id, float3(0.)); next_aux_store(id, float4(2., yaw, 0., 0.)); return; }
        if (sk == 1) { next_p_store(id, np + float3(0., .9, 0.)); next_v_store(id, bv); next_aux_store(id, float4(1., yaw, 0., (rnd(id * 5 + 9) - .5) * 22.)); return; }
        if (blast(id, np, t, dt, bv)) {
            next_p_store(id, np + float3(0., .9, 0.)); next_v_store(id, bv);
            next_aux_store(id, float4(1., yaw, 0., (rnd(id * 5 + 9) - .5) * 18.));
            return;
        }
        float rz = np.z - cz;
        if (id < ${NEAR}u && abs(np.x) < 1.25 && rz > -2.4 && rz < 3.2) {
            float side = abs(np.x) > .05 ? sign(np.x) : (rnd(id) < .5 ? -1. : 1.);
            float3 fling = float3(side * (1.5 + rnd(id * 3 + 1) * 7.5), 3.5 + rnd(id * 3 + 2) * 9., CAR_V * (.75 + rnd(id * 3 + 3) * .55));
            next_p_store(id, np + float3(0., .9, 0.)); next_v_store(id, fling);
            next_aux_store(id, float4(1., yaw, 0., (rnd(id * 5 + 9) - .5) * 15.));
            return;
        }
        next_p_store(id, np); next_v_store(id, float3(vel.x, 0., vel.y)); next_aux_store(id, float4(0., yaw, 0., 0.));
    } else if (a.x == 1.) {
        { float3 sv; int sk = shock(id, p, t, dt, sv); if (sk == 2) { next_p_store(id, float3(p.x, -80., p.z)); next_v_store(id, float3(0.)); next_aux_store(id, float4(2., a.y, 0., 0.)); return; } if (sk == 1) v += sv * .7; }
        v.y -= G * dt; v *= (1. - .08 * dt);
        float3 np = p + v * dt;
        float ground = groundAt(np.x, np.z) + .35;
        float4 na = float4(1., a.y, a.z + a.w * dt, a.w);
        if (np.y < ground && v.y < 0.) {
            np.y = ground;
            if (length(v) > 7.) { v = float3(v.x * .45, -v.y * .28, v.z * .45); na.w *= .5; }
            else { na = float4(2., atan2(v.x, v.z + 1e-4), 0., 0.); np.y = groundAt(np.x, np.z); v = float3(0.); }
        }
        next_p_store(id, np); next_v_store(id, v); next_aux_store(id, na);
    } else {
        float3 bv;
        int sk = shock(id, p, t, dt, bv);
        if (sk == 2) { next_p_store(id, float3(p.x, -80., p.z)); next_v_store(id, float3(0.)); next_aux_store(id, a); return; }
        if (sk == 1) { next_p_store(id, p + float3(0., .5, 0.)); next_v_store(id, bv); next_aux_store(id, float4(1., a.y, 0., (rnd(id * 5 + 9) - .5) * 22.)); return; }
        if (blast(id, p, t, dt, bv)) { next_p_store(id, p + float3(0., .5, 0.)); next_v_store(id, bv); next_aux_store(id, float4(1., a.y, 0., (rnd(id * 5 + 9) - .5) * 18.)); return; }
        next_p_store(id, p); next_v_store(id, v); next_aux_store(id, a);
    }
}`,
    },
    commit: {
      bindings: ['p', 'v', 'aux', 'next_p', 'next_v', 'next_aux'], dispatch: N,
      source: `import vork;
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    float3 p = next_p_load(id), v = next_v_load(id); float4 a = next_aux_load(id);
    if (any(isnan(p)) || any(isinf(p)) || any(isnan(v)) || any(isnan(a))) { p = float3(0., -50., 0.); v = float3(0.); a = float4(2., 0., 0., 0.); }
    p_store(id, p); v_store(id, v); aux_store(id, a);
}`,
    },
  };
  // one placement program per zombie type: P walk-pose meshes plus flung and dead
  COUNTS.forEach((_, vi) => {
    const pre = `v${vi}`;
    const walkB = Array.from({ length: P }, (_, k) => [`${pre}w${k}_t`, `${pre}w${k}_r`, `${pre}w${k}_s`]).flat();
    progs[`place${vi}`] = {
      bindings: ['next_p', 'next_aux', 'clock', ...walkB, `${pre}fly_t`, `${pre}fly_r`, `${pre}fly_s`, `${pre}dead_t`, `${pre}dead_r`, `${pre}dead_s`],
      dispatch: N,
      source: `import vork;\n${common}\n${variantFns}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    if (variantOf(id) != ${vi}u) return;
    float3 p = next_p_load(id); float4 a = next_aux_load(id);
    bool bad = any(isnan(p)) || any(isinf(p)) || any(isnan(a)) || any(isinf(a)) || abs(p.x) > 5000. || abs(p.y) > 5000. || abs(p.z) > 5000.;
    if (bad) p = float3(0., -100., 0.);
    float k = sizeOf(id);
    float3 zero = float3(0.), one = float3(k);
    float4 qy = qyaw(bad ? 0. : fmod(a.y, 6.2831853));
    uint row = variantRow(id);
    uint step = uint(max(clock_load(0), 0.) / ${POSE_DT});
    uint nrow = row / ${P}u;
    float3 ws = (a.x == 0. && !bad) ? one : zero;
    switch ((row % ${P}u + step) % ${P}u) {
${Array.from({ length: P }, (_, k) => `        case ${k}u: ${pre}w${k}_t_store(nrow, p); ${pre}w${k}_r_store(nrow, qy); ${pre}w${k}_s_store(nrow, ws); break;`).join('\n')}
        default: break;
    }
    if (id < ${NEAR}u) {
        float ang = rnd(id * 11 + 4) * 6.2831853;
        float3 axis = normalize(float3(cos(ang), .25, sin(ang)));
        float4 qf = qmul(qy, qaxis(axis, bad ? 0. : fmod(a.z, 6.2831853))); float ql = length(qf); qf = (ql > .5 && !any(isnan(qf))) ? qf / ql : float4(0., 0., 0., 1.);
        ${pre}fly_t_store(row, p); ${pre}fly_r_store(row, qf); ${pre}fly_s_store(row, (a.x == 1. && !bad) ? one : zero);
        ${pre}dead_t_store(row, p); ${pre}dead_r_store(row, qy); ${pre}dead_s_store(row, (a.x == 2. && !bad) ? one : zero);
    }
}`,
    };
  });
  return progs;
}
