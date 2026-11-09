// Horde simulation v3: zombie types, size variety, props as obstacles, time-controlled clock.
import fs from 'node:fs';
const common = fs.readFileSync(new URL('./common.slang', import.meta.url), 'utf8');

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
  const { N, NEAR, P, POSE_DT, SPEED, ZBAND, SLOTS, COUNTS, OBST } = o;
  const S = SLOTS.length;
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
      source: `import vork;\n${common}\n${heightFn}\n${obstacles}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    float x, z;
    if (id < ${NEAR}u) {
        float u = rnd(id * 7 + 1) * 2. - 1.;
        x = u * 40.;
        if (abs(x) < 5. && rnd(id * 7 + 6) < .55) x = sign(u) * (5. + rnd(id * 7 + 8) * 35.);
        z = ${ZBAND[0]} + rnd(id * 7 + 2) * ${ZBAND[1] - ZBAND[0]};
    } else {
        x = (rnd(id * 7 + 3) * 2. - 1.) * 600.;
        z = -1060. + rnd(id * 7 + 4) * 1300.;
        if (abs(x) < 40.) x += sign(x + 1e-3) * 40.;
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
      source: `import vork;\n${common}\n${heightFn}\n${obstacles}
struct Inputs {};
void compute(ComputeContext c, Inputs i) {
    uint id = c.id.x; if (id >= ${N}u) return;
    float3 p = p_load(id), v = v_load(id); float4 a = aux_load(id);
    float t = clock_load(0), dt = clock_load(1);
    float cz = carZ(t);
    if (a.x == 0.) {
        float speed = .42 + rnd(id * 13 + 1) * .4;
        float2 to_road = float2(-sign(p.x) * min(1., abs(p.x) / 8.), .15 * sin(float(id) * .37 + t * .1));
        float2 desire = normalize(to_road + float2(1e-4, 0.));
        float dz = cz - p.z; float2 toCar = float2(-p.x, dz); float dc = length(toCar);
        if (dc < 90. && p.z > cz - 8.) {
            float2 mixd = lerp(desire, toCar / max(dc, .01), saturate(1.2 - dc / 90.));
            if (dot(mixd, mixd) > 1e-6) desire = normalize(mixd);
        }
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
        float2 vel = desire * speed + push * .9;
        float vl = length(vel); if (vl > 1.6) vel *= 1.6 / vl;
        float2 nxz = outOfProps(p.xz + vel * dt);
        float yaw = a.y;
        float2 moved = nxz - p.xz;
        float2 face = dot(moved, moved) > 1e-8 ? moved : desire;
        if (length(face) > 1e-4) {
            float target = atan2(face.x, face.y);
            float dy = target - yaw; dy = dy - 6.2831853 * floor((dy + 3.14159265) / 6.2831853);
            yaw += clamp(dy, -1.5 * dt, 1.5 * dt);
        }
        float3 np = float3(nxz.x, groundAt(nxz.x, nxz.y), nxz.y);
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
    bool bad = any(isnan(p)) || any(isinf(p)) || any(isnan(a));
    float k = sizeOf(id);
    float3 zero = float3(0.), one = float3(k);
    float4 qy = qyaw(bad ? 0. : a.y);
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
        ${pre}fly_t_store(row, p); ${pre}fly_r_store(row, qmul(qy, qaxis(axis, bad ? 0. : a.z))); ${pre}fly_s_store(row, (a.x == 1. && !bad) ? one : zero);
        ${pre}dead_t_store(row, p); ${pre}dead_r_store(row, qy); ${pre}dead_s_store(row, (a.x == 2. && !bad) ? one : zero);
    }
}`,
    };
  });
  return progs;
}
