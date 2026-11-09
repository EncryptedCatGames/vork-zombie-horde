"""Bakes a creature for vork instancing: walk cycle as per-vertex offsets, plus static poses.

blender -b --factory-startup --python bake_horde.py -- <tools dir> <src dir> <kind> <out dir>
Output (vork space: Y up, the creature faces +Z, feet at y = 0):
  <kind>.json  geometry/buffer/image definitions, walk period and speed
  <kind>_*.bin tightly packed little-endian arrays
"""
import json, math, os, shutil, sys
import numpy as np
import bpy

tools, src, kind, out = sys.argv[sys.argv.index("--") + 1:]
sys.path.insert(0, tools)
import render_creatures as rc  # noqa: E402

FRAMES = int(os.environ.get("FRAMES", "16"))
kinds = {k["kind"]: k for k in json.load(open(os.path.join(tools, "kinds.json")))["kinds"]}
cfg = kinds[kind]
if "base" in cfg:  # variants start from another kind's settings (same model and animations)
    merged = json.loads(json.dumps(kinds[cfg["base"]])); merged.update(cfg); cfg = merged
c = rc.Creature(cfg, src)
os.makedirs(out, exist_ok=True)
dg0 = bpy.context.evaluated_depsgraph_get()
tris0 = 0
for o in c.meshes:
    me0 = o.evaluated_get(dg0).to_mesh(); me0.calc_loop_triangles(); tris0 += len(me0.loop_triangles); o.evaluated_get(dg0).to_mesh_clear()
RATIO = min(1.0, float(os.environ.get("TARGET_TRIS", "1e9")) / max(tris0, 1))
print(f"{kind}: {tris0} source triangles, decimate ratio {RATIO:.3f}", flush=True)
if RATIO < 1:
    for o in c.meshes:
        d = o.modifiers.new("decimate", "DECIMATE")
        d.ratio = RATIO
        d.use_collapse_triangulate = True
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_move_to_index(modifier=d.name, index=0)
    bpy.context.view_layer.update()

# Topology: unique (vertex, uv) corners per mesh object, material per triangle.
dg = bpy.context.evaluated_depsgraph_get()
meshes = c.meshes
corner_keys, tri_corners, tri_mats, mat_names = [], [], [], []
for oi, o in enumerate(meshes):
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data if me.uv_layers.active else None
    index = {}
    for tri in me.loop_triangles:
        mname = o.material_slots[tri.material_index].material.name if o.material_slots else "auto"
        if mname not in mat_names:
            mat_names.append(mname)
        ids = []
        for li in tri.loops:
            vi = me.loops[li].vertex_index
            u = tuple(round(x, 5) for x in uv[li].uv) if uv else (0.0, 0.0)
            key = (oi, vi, u)
            if key not in index:
                index[key] = len(corner_keys)
                corner_keys.append(key)
            ids.append(index[key])
        tri_corners.append(ids)
        tri_mats.append(mat_names.index(mname))
    ev.to_mesh_clear()
print(f"{kind}: {len(corner_keys)} corners, {len(tri_corners)} triangles, materials {mat_names}", flush=True)

def to_vork(p):
    # Blender Z up, facing -Y  ->  vork Y up, facing +Z
    return np.stack([p[:, 0], p[:, 2], -p[:, 1]], axis=1)

def sample():
    """World positions and normals of every corner in the current pose (vork space)."""
    dg = bpy.context.evaluated_depsgraph_get()
    P = np.zeros((len(corner_keys), 3), np.float32)
    N = np.zeros((len(corner_keys), 3), np.float32)
    per_obj = {}
    for oi, o in enumerate(meshes):
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        n = len(me.vertices)
        co = np.empty(n * 3, np.float32); me.vertices.foreach_get("co", co)
        no = np.empty(n * 3, np.float32); me.vertices.foreach_get("normal", no)
        m = np.array(ev.matrix_world)
        co = co.reshape(-1, 3) @ m[:3, :3].T + m[:3, 3]
        no = no.reshape(-1, 3) @ m[:3, :3].T
        no /= np.linalg.norm(no, axis=1, keepdims=True) + 1e-9
        per_obj[oi] = (co, no)
        ev.to_mesh_clear()
    for k, (oi, vi, _) in enumerate(corner_keys):
        P[k], N[k] = per_obj[oi][0][vi], per_obj[oi][1][vi]
    return to_vork(P), to_vork(N)

UV = np.array([[u, 1 - v] for (_, _, (u, v)) in corner_keys], np.float32)  # glTF: v=0 at image top
order = np.argsort(tri_mats, kind="stable")
IDX = np.array(tri_corners, np.uint32)[order]
ranges, start = [], 0
for mi in range(len(mat_names)):
    cnt = int((np.array(tri_mats)[order] == mi).sum())
    ranges.append({"start": start * 3, "count": cnt, "material_index": mi}); start += cnt

def write(name, arr):
    arr = np.ascontiguousarray(arr)
    arr.tofile(os.path.join(out, f"{kind}_{name}.bin"))
    return {"type": {1: "f32", 2: "vec2", 3: "vec3"}[arr.shape[1]] if arr.dtype == np.float32 else "u32",
            "file": f"{kind}_{name}.bin", "count": int(arr.shape[0] if arr.ndim > 1 and arr.dtype == np.float32 else arr.size)}

buffers = {f"{kind}_uv": write("uv", UV), f"{kind}_idx": write("idx", IDX.reshape(-1))}

# Walk cycle
walk_cols = [i for i, k in enumerate(rc.COLUMNS) if k == "walk"]
frames = []
for f in range(FRAMES):
    c.place(walk_cols[0], f / FRAMES)
    frames.append(sample())
P0, N0 = frames[0]
buffers[f"{kind}_walk_pos"] = write("walk_pos", P0)
buffers[f"{kind}_walk_nrm"] = write("walk_nrm", N0)
attrs = {"POSITION": f"{kind}_walk_pos", "NORMAL": f"{kind}_walk_nrm", "TEXCOORD_0": f"{kind}_uv"}
geometry = {f"{kind}_walk": {"attributes": attrs, "indices": f"{kind}_idx", "material_ranges": ranges}}
for f in range(FRAMES):  # every walk pose as its own static mesh
    buffers[f"{kind}_f{f}_pos"] = write(f"f{f}_pos", frames[f][0])
    buffers[f"{kind}_f{f}_nrm"] = write(f"f{f}_nrm", frames[f][1])
    geometry[f"{kind}_f{f}"] = {"attributes": {"POSITION": f"{kind}_f{f}_pos", "NORMAL": f"{kind}_f{f}_nrm", "TEXCOORD_0": f"{kind}_uv"},
                                "indices": f"{kind}_idx", "material_ranges": ranges}

# Static poses: launch (box-centred, for tumbling) and dead (lying on the ground).
for pose in ("launch", "dead"):
    c.place(rc.COLUMNS.index(pose), 0)
    P, N = sample()
    if pose == "launch":
        P = P - (P.max(0) + P.min(0)) / 2
    buffers[f"{kind}_{pose}_pos"] = write(f"{pose}_pos", P)
    buffers[f"{kind}_{pose}_nrm"] = write(f"{pose}_nrm", N)
    geometry[f"{kind}_{pose}"] = {"attributes": {"POSITION": f"{kind}_{pose}_pos", "NORMAL": f"{kind}_{pose}_nrm", "TEXCOORD_0": f"{kind}_uv"},
                                  "indices": f"{kind}_idx", "material_ranges": ranges}
    print(f"{pose}: extent {np.round(P.max(0) - P.min(0), 2)}", flush=True)

# Walk timing: the clip's length and the distance one cycle covers.
spec = cfg["poses"]["walk"]
fps = bpy.context.scene.render.fps / bpy.context.scene.render.fps_base
a, b = spec.get("frames", [1, 120])
period = (b - a) / fps
c.unturn(); c.root.location = (0, 0, 0)
c.set_pose("walk", 0); h0 = c.hips_xy()
c.set_pose("walk", 1); h1 = c.hips_xy()
metres = float(np.linalg.norm(h1 - h0))  # root travel over the whole clip
print(f"hips drift {h1 - h0}, foot-spread cycle {c.walk_cycle_metres():.2f}", flush=True)
# Textures: copy the configured colour/normal files per material.
images, materials = {}, []
for mname in mat_names:
    tex = next((t for key, t in cfg.get("textures", {}).items() if key in mname), {})
    entry = {"name": mname}
    bm = bpy.data.materials.get(mname)
    if bm and bm.use_nodes:
        pr = next((n for n in bm.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if pr: entry["rgb"] = list(pr.inputs["Base Color"].default_value)[:3]
    for slot in ("color", "normal"):
        if slot in tex:
            fn = os.path.basename(tex[slot]); shutil.copy(os.path.join(src, tex[slot]), os.path.join(out, fn))
            images[f"{kind}_{mname}_{slot}"] = {"file": fn, **({"color_space": "Non-Color"} if slot == "normal" else {})}
            entry[slot] = f"{kind}_{mname}_{slot}"
    materials.append(entry)
P0span = P0.max(0) - P0.min(0)
info = {"kind": kind, "frames": FRAMES, "period": period, "cycle_metres": metres, "speed": metres / period,
        "extent": P0span.tolist(), "buffers": buffers, "geometry": geometry, "images": images, "materials": materials}
json.dump(info, open(os.path.join(out, f"{kind}.json"), "w"), indent=1)
print(f"{kind}: walk period {period:.2f} s, {metres:.2f} m per cycle, {metres / period:.2f} m/s, extent {np.round(P0span, 2)}", flush=True)
