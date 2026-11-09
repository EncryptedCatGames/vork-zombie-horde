"""Renders creature sprite cells (albedo + normals) from rigged, animated models.

    blender -b --factory-startup --disable-autoexec -P render_creatures.py -- \
        --config kinds.json --src <models dir> --out <out dir> \
        [--kinds zombie,cow] [--size 256] [--dirs 16] [--preview]

For every kind in the config: imports the model and its animation files, swaps in the
textures, applies the look tweaks (recolours, extra pieces, a fatter belly, smoother
low-poly shapes), then renders each pose from `--dirs` directions around the creature
with an orthographic camera pitched like the game's sprite camera (20° down). Two
images per cell, both with a transparent background:

  <out>/<kind>/albedo/<column>_<dir>.png  base colour with baked ambient occlusion (sRGB)
  <out>/<kind>/normal/<column>_<dir>.png  world-space normals, 0.5 + 0.5 * n (linear);
                                          pack_atlas.py turns them into cell space

and <out>/<kind>/meta.json (metres per cell, baseline, walk cycle length). Columns:
0-7 walk cycle, 8 idle, 9 react (startled), 10 launched (hit, flailing), 11 dead body,
12-15 tumble: the hit pose and three phases of a whole-body tumble (the config's
"tumble": humanoids pitch backwards head over heels, animals roll over their long axis),
each turned by TUMBLE_ANGLES and centred on its bounding box at the cell's middle so the
game can spin through them in 3D (creatureCrowd.ts).

Blender space: +Z up, the creature faces -Y, feet on z = 0. Direction 0 looks at the
creature's face and directions step towards its left side (+X), matching the game's
directionIndex(). --preview renders a few cells only, for checking a look quickly.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils
import numpy as np

PITCH = math.radians(20)
WALK_FRAMES = 8
COLUMNS = ["walk"] * WALK_FRAMES + ["idle", "react", "launch", "dead"] + [
    f"tumble{i}" for i in range(4)
]
# Whole-body turn (degrees) of each tumble column; the game's TUMBLE_PHASE_ANGLES match.
TUMBLE_ANGLES = [20, 100, 190, 280]


def log(*a):
    print("[creatures]", *a, flush=True)


# ---------------------------------------------------------------- import


def import_file(path):
    """Imports a model file; returns the new objects and actions."""
    before_o = set(bpy.data.objects)
    before_a = set(bpy.data.actions)
    low = path.lower()
    if low.endswith(".blend"):
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = src.objects
            dst.actions = src.actions
        for o in dst.objects:
            if o is not None and o.type in {"MESH", "ARMATURE", "EMPTY"}:
                bpy.context.scene.collection.objects.link(o)
    elif low.endswith(".fbx"):
        bpy.ops.import_scene.fbx(filepath=path, use_anim=True, ignore_leaf_bones=True)
    elif low.endswith(".obj"):
        bpy.ops.wm.obj_import(filepath=path)
    elif low.endswith((".glb", ".gltf")):
        bpy.ops.import_scene.gltf(filepath=path)
    else:
        raise ValueError(path)
    objs = [o for o in bpy.data.objects if o not in before_o and o.users_scene]
    acts = [a for a in bpy.data.actions if a not in before_a]
    return objs, acts


def rename_bones(arm, prefixes):
    for b in arm.data.bones:
        for p in prefixes:
            if b.name.startswith(p):
                b.name = "mixamorig:" + b.name[len(p) :]


def find_armature(objs):
    arms = [o for o in objs if o.type == "ARMATURE"]
    return arms[0] if arms else None


def assign_action(arm, action):
    ad = arm.animation_data or arm.animation_data_create()
    ad.action = action
    if getattr(ad, "action_slot", None) is None and hasattr(action, "slots") and action.slots:
        ad.action_slot = action.slots[0]


# ---------------------------------------------------------------- materials


def image(path):
    return bpy.data.images.load(path, check_existing=True)


def principled(mat):
    if not mat or not mat.use_nodes:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


def ensure_principled(mat):
    """Old .blend materials (Blender Internal) may have no nodes: build a Principled BSDF."""
    p = principled(mat)
    if p:
        return p
    colour = tuple(mat.diffuse_color)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    p = nt.nodes.new("ShaderNodeBsdfPrincipled")
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    nt.links.new(p.outputs[0], out.inputs[0])
    p.inputs["Base Color"].default_value = colour
    return p


def apply_textures(mats, spec, src):
    """spec: {material name substring: {"color": file, "normal": file, "alpha": bool}}."""
    for mat in mats:
        for key, tex in spec.items():
            if key not in mat.name:
                continue
            p = ensure_principled(mat)
            nt = mat.node_tree
            if "color" in tex:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = image(os.path.join(src, tex["color"]))
                nt.links.new(t.outputs["Color"], p.inputs["Base Color"])
                if tex.get("alpha"):
                    nt.links.new(t.outputs["Alpha"], p.inputs["Alpha"])
            if "normal" in tex:
                t = nt.nodes.new("ShaderNodeTexImage")
                t.image = image(os.path.join(src, tex["normal"]))
                t.image.colorspace_settings.name = "Non-Color"
                nm = nt.nodes.new("ShaderNodeNormalMap")
                nm.inputs["Strength"].default_value = tex.get("normalStrength", 1.0)
                nt.links.new(t.outputs["Color"], nm.inputs["Color"])
                nt.links.new(nm.outputs["Normal"], p.inputs["Normal"])


def socket_source(nt, sock):
    """(output socket or None, default value) feeding an input socket."""
    if sock.is_linked:
        return sock.links[0].from_socket, None
    return None, tuple(sock.default_value) if hasattr(sock.default_value, "__len__") else sock.default_value


def add_noise_variation(nt, colour_out, strength, scale, x, y):
    """Multiplies a colour by low-frequency noise (blotchy skin, dirty wool)."""
    noise = nt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = scale
    noise.inputs["Detail"].default_value = 6
    noise.location = (x, y)
    ramp = nt.nodes.new("ShaderNodeMapRange")
    ramp.inputs["To Min"].default_value = 1 - strength
    ramp.inputs["To Max"].default_value = 1 + strength * 0.5
    nt.links.new(noise.outputs["Fac"], ramp.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1
    nt.links.new(colour_out, mul.inputs[6])
    nt.links.new(ramp.outputs["Result"], mul.inputs[7])
    return mul.outputs[2]


def lin(rgb):
    """sRGB colour (as picked in an image editor) to linear."""
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]


def math_node(nt, op, a, b=None, clamp=False):
    n = nt.nodes.new("ShaderNodeMath")
    n.operation = op
    n.use_clamp = clamp
    for i, v in enumerate((a, b)):
        if v is None:
            continue
        if isinstance(v, (int, float)):
            n.inputs[i].default_value = v
        else:
            nt.links.new(v, n.inputs[i])
    return n.outputs[0]


def mix_rgb(nt, fac, a, b, blend="MIX"):
    m = nt.nodes.new("ShaderNodeMix")
    m.data_type = "RGBA"
    m.blend_type = blend
    for sock, v in ((m.inputs["Factor"], fac), (m.inputs[6], a), (m.inputs[7], b)):
        if isinstance(v, (int, float)):
            sock.default_value = v
        elif isinstance(v, (tuple, list)):
            sock.default_value = (*v[:3], 1)
        else:
            nt.links.new(v, sock)
    return m.outputs[2]


def hue_replace(nt, src, spec):
    """Recolours one hue band (blood red -> dirt/goo green): [centre, width, satMin, r, g, b].

    The new colour keeps the old brightness pattern."""
    centre, width, sat_min, *rgb = spec
    rgb = lin(rgb)
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.mode = "HSV"
    nt.links.new(src, sep.inputs[0])
    h, s, v = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    # Circular hue distance.
    d = math_node(nt, "ABSOLUTE", math_node(nt, "SUBTRACT", h, centre))
    d = math_node(nt, "MINIMUM", d, math_node(nt, "SUBTRACT", 1.0, d))
    hue_ok = math_node(nt, "SUBTRACT", 1.0, math_node(nt, "DIVIDE", d, width), clamp=True)
    sat_ok = math_node(nt, "DIVIDE", math_node(nt, "SUBTRACT", s, sat_min), 0.15)
    sat_ok = math_node(nt, "MINIMUM", math_node(nt, "MAXIMUM", sat_ok, 0.0), 1.0)
    mask = math_node(nt, "MULTIPLY", hue_ok, sat_ok)
    mask = math_node(nt, "MINIMUM", math_node(nt, "MULTIPLY", mask, 2.0), 1.0)
    shade = math_node(nt, "MULTIPLY", v, 1.6)
    comb = nt.nodes.new("ShaderNodeCombineColor")
    for i, c in enumerate(rgb):
        nt.links.new(math_node(nt, "MULTIPLY", shade, c), comb.inputs[i])
    return mix_rgb(nt, mask, src, comb.outputs[0])


UP = [2, False]


def soft_range(nt, value, lo, hi, soft=0.05):
    """1 inside [lo, hi], fading to 0 over `soft` outside."""
    a = math_node(nt, "DIVIDE", math_node(nt, "SUBTRACT", value, lo - soft), soft)
    b = math_node(nt, "DIVIDE", math_node(nt, "SUBTRACT", hi + soft, value), soft)
    a = math_node(nt, "MINIMUM", math_node(nt, "MAXIMUM", a, 0.0), 1.0)
    b = math_node(nt, "MINIMUM", math_node(nt, "MAXIMUM", b, 0.0), 1.0)
    return math_node(nt, "MULTIPLY", a, b)


def recolor(nt, src, spec):
    """Repaints pixels picked by saturation / brightness ranges (a white T-shirt, faded
    jeans) in a new colour, keeping their light/dark pattern.

    spec: {"sat": [lo, hi], "val": [lo, hi], "hue": [lo, hi] (optional), "to": [r, g, b],
    "valAverage": typical brightness of the picked pixels}"""
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    sep.mode = "HSV"
    nt.links.new(src, sep.inputs[0])
    h, s, v = sep.outputs[0], sep.outputs[1], sep.outputs[2]
    mask = math_node(nt, "MULTIPLY", soft_range(nt, s, *spec.get("sat", [0, 1])),
                     soft_range(nt, v, *spec.get("val", [0, 1])))
    if "hue" in spec:
        mask = math_node(nt, "MULTIPLY", mask, soft_range(nt, h, *spec["hue"], soft=0.02))
    shade = math_node(nt, "DIVIDE", v, spec.get("valAverage", 0.7))
    shade = math_node(nt, "MINIMUM", shade, 1.3)
    to = lin(spec["to"])
    comb = nt.nodes.new("ShaderNodeCombineColor")
    for i, c in enumerate(to):
        nt.links.new(math_node(nt, "MULTIPLY", shade, c), comb.inputs[i])
    return mix_rgb(nt, mask, src, comb.outputs[0])


def uv_regions(nt, src, tw):
    """Repaints UV rectangles of a texture (the chicken's body feathers) in a new colour,
    keeping the texture's light/dark pattern; the rest of the texture is untouched.

    tw["uvRegions"]: [[u0, v0, u1, v1, [r, g, b]], ...]."""
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(src, bw.inputs[0])
    detail = math_node(nt, "DIVIDE", bw.outputs[0], tw.get("detailAverage", 0.2))
    detail = math_node(nt, "MINIMUM", math_node(nt, "MAXIMUM", detail, 0.4), 1.5)
    k = tw.get("detail", 0.5)
    detail = math_node(nt, "ADD", math_node(nt, "MULTIPLY", detail, k), 1 - k)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["UV"], sep.inputs[0])
    u, v = sep.outputs[0], sep.outputs[1]
    out = src
    for u0, v0, u1, v1, rgb in tw["uvRegions"]:
        inside = math_node(nt, "MULTIPLY", soft_range(nt, u, u0, u1, 0.01),
                           soft_range(nt, v, v0, v1, 0.01))
        painted = mix_rgb(nt, 1.0, lin(rgb), math_node(nt, "MULTIPLY", detail, 1.0), "MULTIPLY")
        out = mix_rgb(nt, inside, out, painted)
    return out


def regions(nt, src, tw):
    """Repaints a material by height bands of the rest-pose mesh (shirt / trousers /
    hi-vis stripes), keeping the source texture's brightness pattern as cloth detail.

    tw["regions"]: [[z_from, z_to, [r, g, b]], ...] in 0..1 of the mesh height (later
    entries win); tw["detail"]: how much of the texture's light/dark pattern to keep."""
    bw = nt.nodes.new("ShaderNodeRGBToBW")
    nt.links.new(src, bw.inputs[0])
    avg = tw.get("detailAverage", 0.2)
    detail = math_node(nt, "DIVIDE", bw.outputs[0], avg)
    detail = math_node(nt, "MINIMUM", math_node(nt, "MAXIMUM", detail, 0.35), 1.7)
    k = tw.get("detail", 0.5)
    detail = math_node(nt, "ADD", math_node(nt, "MULTIPLY", detail, k), 1 - k)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sepz = nt.nodes.new("ShaderNodeSeparateXYZ")
    nt.links.new(tc.outputs["Generated"], sepz.inputs[0])
    z = sepz.outputs[UP[0]]
    if UP[1]:
        z = math_node(nt, "SUBTRACT", 1.0, z)
    colour = None
    for z0, z1, rgb in tw["regions"]:
        rgb = lin(rgb)
        inside = math_node(
            nt,
            "MULTIPLY",
            math_node(nt, "GREATER_THAN", z, z0),
            math_node(nt, "LESS_THAN", z, z1),
        )
        colour = mix_rgb(nt, inside, colour if colour is not None else rgb, rgb)
    return mix_rgb(nt, 1.0, colour, math_node(nt, "MULTIPLY", detail, 1.0), "MULTIPLY")


def build_bake_material(mat, look):
    """Adds the two sprite outputs to a material: albedo×AO emission and world normal.

    Returns (albedo shader socket, normal shader socket, output node)."""
    p = ensure_principled(mat)
    nt = mat.node_tree
    # The shader Cycles actually uses: the active Cycles output, else the active one.
    outs = [n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"]
    used = (
        next((n for n in outs if n.target == "CYCLES" and n.is_active_output), None)
        or next((n for n in outs if n.is_active_output), None)
        or (outs[0] if outs else None)
    )
    shader = used.inputs["Surface"].links[0].from_node if used and used.inputs["Surface"].is_linked else p
    if shader.type in {"BSDF_DIFFUSE", "BSDF_PRINCIPLED"}:
        p = shader
    for n in outs:
        if n != used:
            nt.nodes.remove(n)
    out = used or nt.nodes.new("ShaderNodeOutputMaterial")
    out.is_active_output = True
    out.target = "ALL"
    colour_in = p.inputs["Base Color"] if "Base Color" in p.inputs else p.inputs["Color"]

    src, val = socket_source(nt, colour_in)
    if src is None:
        rgb = nt.nodes.new("ShaderNodeRGB")
        rgb.outputs[0].default_value = val
        src = rgb.outputs[0]

    # Look tweaks for this material: {"match": substr, "hsv": [h, s, v], "tint": [r,g,b],
    # "gray": 0..1 (desaturate first), "noise": [strength, scale]}
    for tw in look.get("materials", []):
        if tw["match"] not in mat.name and tw["match"] != "*":
            continue
        if "gray" in tw:
            bw = nt.nodes.new("ShaderNodeRGBToBW")
            nt.links.new(src, bw.inputs[0])
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.inputs["Factor"].default_value = tw["gray"]
            nt.links.new(src, mix.inputs[6])
            nt.links.new(bw.outputs[0], mix.inputs[7])
            src = mix.outputs[2]
        if "hsv" in tw:
            hsv = nt.nodes.new("ShaderNodeHueSaturation")
            hsv.inputs["Hue"].default_value = tw["hsv"][0]
            hsv.inputs["Saturation"].default_value = tw["hsv"][1]
            hsv.inputs["Value"].default_value = tw["hsv"][2]
            nt.links.new(src, hsv.inputs["Color"])
            src = hsv.outputs[0]
        if "tint" in tw:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1
            nt.links.new(src, mix.inputs[6])
            mix.inputs[7].default_value = (*lin(tw["tint"]), 1)
            src = mix.outputs[2]
        if "replace" in tw:
            rgb = nt.nodes.new("ShaderNodeRGB")
            rgb.outputs[0].default_value = (*lin(tw["replace"]), 1)
            src = rgb.outputs[0]
        if "hueReplace" in tw:
            src = hue_replace(nt, src, tw["hueReplace"])
        for spec in tw.get("recolor", []):
            src = recolor(nt, src, spec)
        if "uvRegions" in tw:
            src = uv_regions(nt, src, tw)
        if "regions" in tw:
            src = regions(nt, src, tw)
        if "noise" in tw:
            src = add_noise_variation(nt, src, tw["noise"][0], tw["noise"][1], -600, 0)

    ao = nt.nodes.new("ShaderNodeAmbientOcclusion")
    ao.samples = 16
    ao.inputs["Distance"].default_value = look.get("aoDistance", 0.25)
    aomix = nt.nodes.new("ShaderNodeMapRange")
    strength = look.get("ao", 0.65)
    aomix.inputs["To Min"].default_value = 1 - strength
    aomix.inputs["To Max"].default_value = 1
    nt.links.new(ao.outputs["AO"], aomix.inputs["Value"])
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1
    nt.links.new(src, mul.inputs[6])
    nt.links.new(aomix.outputs["Result"], mul.inputs[7])
    emit_albedo = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(mul.outputs[2], emit_albedo.inputs["Color"])

    nsrc, _ = socket_source(nt, p.inputs["Normal"])
    if nsrc is None:
        geo = nt.nodes.new("ShaderNodeNewGeometry")
        nsrc = geo.outputs["Normal"]
    # 0.5 + 0.5 * n
    vm = nt.nodes.new("ShaderNodeVectorMath")
    vm.operation = "MULTIPLY_ADD"
    vm.inputs[1].default_value = (0.5, 0.5, 0.5)
    vm.inputs[2].default_value = (0.5, 0.5, 0.5)
    nt.links.new(nsrc, vm.inputs[0])
    emit_normal = nt.nodes.new("ShaderNodeEmission")
    nt.links.new(vm.outputs[0], emit_normal.inputs["Color"])

    # Cut-out alpha (hair cards, eyelashes).
    asrc, aval = socket_source(nt, p.inputs["Alpha"]) if "Alpha" in p.inputs else (None, 1.0)
    shaders = []
    for emit in (emit_albedo, emit_normal):
        if asrc is not None:
            tr = nt.nodes.new("ShaderNodeBsdfTransparent")
            mix = nt.nodes.new("ShaderNodeMixShader")
            if asrc is not None:
                # Hard cut-out keeps sprite edges clean.
                step = nt.nodes.new("ShaderNodeMath")
                step.operation = "GREATER_THAN"
                step.inputs[1].default_value = 0.5
                nt.links.new(asrc, step.inputs[0])
                nt.links.new(step.outputs[0], mix.inputs[0])
            else:
                mix.inputs[0].default_value = aval
            nt.links.new(tr.outputs[0], mix.inputs[1])
            nt.links.new(emit.outputs[0], mix.inputs[2])
            shaders.append(mix.outputs[0])
        else:
            shaders.append(emit.outputs[0])
    return shaders[0], shaders[1], out


# ---------------------------------------------------------------- geometry helpers


def mesh_objects(root_objs):
    return [o for o in root_objs if o.type == "MESH" and o.visible_get()]


def world_verts(meshes):
    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for o in meshes:
        ev = o.evaluated_get(dg)
        me = ev.to_mesh()
        n = len(me.vertices)
        if n:
            co = np.empty(n * 3, dtype=np.float32)
            me.vertices.foreach_get("co", co)
            co = co.reshape(-1, 3)
            m = np.array(ev.matrix_world)
            co = co @ m[:3, :3].T + m[:3, 3]
            pts.append(co)
        ev.to_mesh_clear()
    return np.concatenate(pts) if pts else np.zeros((0, 3))


def fatten(mesh_obj, spec):
    """Pushes torso vertices outward (rest pose) for the fat zombie: a belly and wider waist."""
    me = mesh_obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    # Work in world space (rest pose), then map back.
    m = np.array(mesh_obj.matrix_world)
    inv = np.linalg.inv(m)
    w = co @ m[:3, :3].T + m[:3, 3]
    z = w[:, 2]
    zmin, zmax = z.min(), z.max()
    h = (z - zmin) / (zmax - zmin)
    c, r = spec.get("centre", 0.55), spec.get("radius", 0.2)
    k = np.clip(1 - ((h - c) / r) ** 2, 0, 1) ** 1.5
    # Don't inflate arms: only verts near the body axis.
    lateral = np.abs(w[:, 0])
    k *= np.clip(1 - (lateral - 0.18) / 0.1, 0, 1)
    cx = 0.0
    cy = np.median(w[(h > c - 0.05) & (h < c + 0.05), 1]) if np.any(k > 0) else 0
    dx = w[:, 0] - cx
    dy = w[:, 1] - cy
    w[:, 0] += dx * k * spec.get("wide", 0.35)
    front = np.where(dy < 0, spec.get("belly", 0.6), spec.get("back", 0.15))
    w[:, 1] += dy * k * front
    co = w @ inv[:3, :3].T + inv[:3, 3]
    me.vertices.foreach_set("co", co.ravel())
    me.update()


def slim(mesh_obj, spec):
    """Narrows shoulders / widens hips a little (not used on real female models)."""
    me = mesh_obj.data
    n = len(me.vertices)
    co = np.empty(n * 3, dtype=np.float32)
    me.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    m = np.array(mesh_obj.matrix_world)
    inv = np.linalg.inv(m)
    w = co @ m[:3, :3].T + m[:3, 3]
    z = w[:, 2]
    h = (z - z.min()) / (z.max() - z.min())
    for c, r, sx in spec:
        k = np.clip(1 - ((h - c) / r) ** 2, 0, 1)
        w[:, 0] *= 1 + (sx - 1) * k
    co = w @ inv[:3, :3].T + inv[:3, 3]
    me.vertices.foreach_set("co", co.ravel())
    me.update()


def add_piece(piece, arm):
    """A simple extra piece (cap, hard hat, badge) following a bone.

    Placed in the rest pose: `offset` (m, world axes: +Z up, -Y forward) from the bone's
    head, `size` (m) half-extents for dome/cylinder radius and full size for boxes."""
    kind = piece["shape"]
    mat = bpy.data.materials.new(piece["name"])
    mat.use_nodes = True
    p = principled(mat)
    p.inputs["Base Color"].default_value = (*lin(piece["color"]), 1)
    if kind == "dome":
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=12, radius=1)
        o = bpy.context.active_object
        for v in o.data.vertices:
            if v.co.z < 0:
                v.co.z = 0
    elif kind == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=1, depth=1)
        o = bpy.context.active_object
    else:
        bpy.ops.mesh.primitive_cube_add(size=1)
        o = bpy.context.active_object
    o.name = piece["name"]
    o.data.materials.append(mat)
    for poly in o.data.polygons:
        poly.use_smooth = kind != "box"
    bone = arm.data.bones[piece["bone"]]
    head_w = arm.matrix_world @ bone.head_local
    target = mathutils.Matrix.LocRotScale(
        head_w + mathutils.Vector(piece["offset"]),
        mathutils.Euler([math.radians(a) for a in piece.get("rotation", [0, 0, 0])]),
        mathutils.Vector(piece["size"]),
    )
    o.parent = arm
    o.parent_type = "BONE"
    o.parent_bone = piece["bone"]
    bpy.context.view_layer.update()
    o.matrix_world = target
    return o


# ---------------------------------------------------------------- retargeting


def retarget(target_arm, source_arm, bone_map=None):
    """Drives target bones from a source armature (world-space rotations, hips location)."""
    for pb in target_arm.pose.bones:
        name = (bone_map or {}).get(pb.name, pb.name)
        if name not in source_arm.pose.bones:
            continue
        c = pb.constraints.new("COPY_ROTATION")
        c.target = source_arm
        c.subtarget = name
        c.target_space = "WORLD"
        c.owner_space = "WORLD"
        if name.endswith("Hips"):
            cl = pb.constraints.new("COPY_LOCATION")
            cl.target = source_arm
            cl.subtarget = name
            cl.target_space = "WORLD"
            cl.owner_space = "WORLD"


# ---------------------------------------------------------------- per kind setup


class Creature:
    def __init__(self, cfg, src_dir):
        self.cfg = cfg
        self.src = src_dir
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        self.root = bpy.data.objects.new("root", None)
        scene.collection.objects.link(self.root)

        base = os.path.join(src_dir, cfg["model"])
        objs, acts = import_file(base)
        keep = [o for o in objs if o.type in {"MESH", "ARMATURE"}]
        for o in objs:
            if o.type not in {"MESH", "ARMATURE"}:
                bpy.data.objects.remove(o)
        objs = keep
        for name in cfg.get("hide", []):
            for o in objs:
                if name in o.name:
                    o.hide_render = True
                    o.hide_set(True)
        self.arm = find_armature(objs)
        self.objs = objs
        self.actions = {a.name: a for a in acts}
        if self.arm and cfg.get("renameBones"):
            rename_bones(self.arm, cfg["renameBones"])

        # Animation files (Mixamo style: one action per file, same skeleton).
        self.source_arm = None
        self.sources = {}
        for key, f in cfg.get("animations", {}).items():
            # Unique names first: the FBX importer reuses actions with the same name.
            for a in bpy.data.actions:
                if not a.name.startswith("keep:"):
                    a.name = "keep:" + a.name
            aobjs, aacts = import_file(os.path.join(src_dir, f))
            aarm = find_armature(aobjs)
            if aarm and cfg.get("renameBones"):
                rename_bones(aarm, cfg["renameBones"])
            act = aarm.animation_data.action if aarm and aarm.animation_data else None
            act = act or (aacts[-1] if aacts else None)
            if act:
                act.name = key
                act.use_fake_user = True
                self.actions[key] = act
            if aarm:
                # Each animation file keeps its own skeleton (FBX rest poses differ per
                # file, so actions can't be moved between them); the model follows
                # whichever one plays, through world-space constraints.
                self.sources[key] = aarm
                for o in aobjs:
                    if o != aarm:
                        bpy.data.objects.remove(o)
                aarm.hide_render = True
            else:
                for o in aobjs:
                    bpy.data.objects.remove(o)
        if self.sources:
            self.source_arm = next(iter(self.sources.values()))
            retarget(self.arm, self.source_arm)

        # Parent the top-level objects to the root for scale/turn/offset.
        tops = [o for o in self.objs if o.parent is None]
        tops.extend(self.sources.values())
        for o in tops:
            o.parent = self.root
        self.root.rotation_euler = (0, 0, math.radians(cfg.get("yaw", 0)))
        self.base_rotation = self.root.rotation_euler.to_quaternion()
        self.cell_centre = 0.0
        self.meshes = [o for o in self.objs if o.type == "MESH" and not o.hide_render]

        apply_textures(
            [m for o in self.meshes for m in o.data.materials if m], cfg.get("textures", {}), src_dir
        )
        for o in self.meshes:
            for m in o.modifiers:
                if m.type == "MULTIRES":
                    m.levels = m.render_levels = 0

        # Scale to the real-world size measured in the rest pose (or the idle pose).
        if self.arm and cfg.get("measure", "rest") == "rest":
            self.arm.data.pose_position = "REST"
        else:
            self.set_pose("idle", 0)
        bpy.context.view_layer.update()
        pts = world_verts(self.meshes)
        if self.arm:
            self.arm.data.pose_position = "POSE"
        size = pts.max(0) - pts.min(0)
        axis = cfg.get("sizeAxis", "z")
        measured = size[{"x": 0, "y": 1, "z": 2}[axis]]
        self.scale = cfg["size"] / measured
        self.root.scale = (self.scale,) * 3
        bpy.context.view_layer.update()
        self.set_pose("idle", 0)
        pts = world_verts(self.meshes)
        self.ground = float(pts[:, 2].min())
        log(f"{cfg['kind']}: measured {measured:.3f} -> scale {self.scale:.4f}, ground {self.ground:.3f}")

        # Shape tweaks in rest pose (before the armature deforms them).
        if "fatten" in cfg or "slim" in cfg:
            if self.arm:
                self.arm.data.pose_position = "REST"
            bpy.context.view_layer.update()
            for o in self.meshes:
                if "fatten" in cfg and cfg.get("fattenMesh", o.name) in o.name:
                    fatten(o, cfg["fatten"])
                if "slim" in cfg:
                    slim(o, cfg["slim"])
            if self.arm:
                self.arm.data.pose_position = "POSE"

        for piece in cfg.get("pieces", []):
            self.arm.data.pose_position = "REST"
            bpy.context.view_layer.update()
            o = add_piece(piece, self.arm)
            self.arm.data.pose_position = "POSE"
            self.meshes.append(o)

        # Smooth low-poly models (subdivision after the armature) and wool/fur bumps.
        for o in self.meshes:
            if cfg.get("subdivide"):
                sub = o.modifiers.new("smooth", "SUBSURF")
                sub.levels = sub.render_levels = cfg["subdivide"]
                for poly in o.data.polygons:
                    poly.use_smooth = True
            if cfg.get("autoSmooth"):
                for poly in o.data.polygons:
                    poly.use_smooth = True
            for d in cfg.get("displace", []):
                if d.get("mesh", o.name) not in o.name:
                    continue
                vg = None
                if "material" in d:
                    vg = o.vertex_groups.new(name="disp_" + d["material"])
                    idx = [i for i, m in enumerate(o.data.materials) if m and d["material"] in m.name]
                    verts = {v for p in o.data.polygons if p.material_index in idx for v in p.vertices}
                    vg.add(list(verts), 1.0, "REPLACE")
                tex = bpy.data.textures.new("disp", "CLOUDS")
                tex.noise_scale = d.get("scale", 0.08) / self.scale
                tex.noise_depth = 2
                mod = o.modifiers.new("disp", "DISPLACE")
                mod.texture = tex
                mod.texture_coords = "LOCAL"
                mod.strength = d.get("strength", 0.03) / self.scale
                mod.mid_level = 0.5
                if vg:
                    mod.vertex_group = vg.name

        self.look = cfg.get("look", {})
        self.mat_outputs = []
        done = set()
        for o in self.meshes:
            # Which local axis points up (Generated coordinates follow the mesh axes).
            m3 = o.matrix_world.to_3x3()
            ups = [m3.col[i].normalized().z for i in range(3)]
            i = max(range(3), key=lambda k: abs(ups[k]))
            UP[0], UP[1] = i, ups[i] < 0
            for m in o.data.materials:
                if m and m.name not in done:
                    done.add(m.name)
                    self.mat_outputs.append((m, *build_bake_material(m, self.look)))
            if not o.data.materials:
                m = bpy.data.materials.new("auto")
                o.data.materials.append(m)
                done.add(m.name)
                self.mat_outputs.append((m, *build_bake_material(m, self.look)))

    # ------------------------------------------------------------ poses

    def pose_spec(self, column):
        return self.cfg["poses"][column]

    def set_pose(self, name, t):
        """name: a pose key from the config ('idle', 'walk', ...); t in 0..1 along it."""
        spec = self.cfg["poses"].get(name) or self.cfg["poses"]["idle"]
        act = self.actions.get(spec["action"])
        target = self.arm
        if spec["action"] in self.sources:
            self.use_source(self.sources[spec["action"]])
            target = None
        if target and act:
            assign_action(target, act)
        if act:
            a, b = spec.get("frames", list(act.frame_range))
            f = a + (b - a) * t
            fi = math.floor(f)
            bpy.context.scene.frame_set(fi, subframe=f - fi)
        else:
            bpy.context.scene.frame_set(0)
        bpy.context.view_layer.update()

    def use_source(self, src):
        if src is self.source_arm:
            return
        self.source_arm = src
        for pb in self.arm.pose.bones:
            for c in pb.constraints:
                if c.type in {"COPY_ROTATION", "COPY_LOCATION"}:
                    c.target = src

    def hips_xy(self):
        arm = self.source_arm or self.arm
        if arm is None:
            pts = world_verts(self.meshes)
            return (pts.max(0)[:2] + pts.min(0)[:2]) / 2
        names = [b.name for b in arm.pose.bones]
        hip = next((n for n in names if n.lower().endswith("hips")), None) or next(
            (n for n in names if n.lower() in ("body", "hip", "main", "root")), names[0]
        )
        pb = arm.pose.bones[hip]
        p = arm.matrix_world @ pb.head
        return np.array([p.x, p.y])

    def place(self, column, t):
        """Poses for an atlas column and centres the creature on the origin."""
        kind = COLUMNS[column]
        self.unturn()
        self.root.location = (0, 0, 0)
        spec = self.cfg["poses"].get(kind) or self.cfg["poses"]["idle"]
        if kind == "walk":
            # Cancel root motion: subtract the linear drift of the hips over the cycle.
            self.set_pose("walk", 0)
            p0 = self.hips_xy()
            self.set_pose("walk", 1)
            p1 = self.hips_xy()
            if not hasattr(self, "walk_ground"):
                # One ground height for the whole cycle (the lowest foot over it), so
                # the body bob stays in the frames.
                lows = []
                for i in range(WALK_FRAMES):
                    self.set_pose("walk", i / WALK_FRAMES)
                    lows.append(world_verts(self.meshes)[:, 2].min())
                self.walk_ground = float(min(lows))
                # Animals: centre the body's box, not the (rear) hips bone.
                self.walk_centre = np.zeros(2)
                if spec.get("centre") == "bbox":
                    self.set_pose("walk", 0)
                    pts = world_verts(self.meshes)
                    self.walk_centre = (pts.max(0)[:2] + pts.min(0)[:2]) / 2 - p0
            self.set_pose("walk", t)
            drift = p0 + (p1 - p0) * t
            off = -drift - self.walk_centre
            self.root.location = (off[0] + spec.get("dx", 0), off[1], -self.walk_ground)
        elif kind.startswith("tumble"):
            self.place_tumble(int(kind[-1]))
            return
        else:
            self.set_pose(kind, spec.get("t", 0))
            pts = world_verts(self.meshes)
            if kind == "dead" or spec.get("centre") == "bbox":
                c = (pts.max(0)[:2] + pts.min(0)[:2]) / 2
                z = -pts[:, 2].min()
            else:
                c = self.hips_xy()
                z = -pts[:, 2].min() + spec.get("lift", 0)
            self.root.location = (-c[0], -c[1], z)
        bpy.context.view_layer.update()

    def place_tumble(self, phase):
        """A tumble column: a clip pose, the whole body turned (pitched back for humanoids,
        rolled onto its side for animals) and its box centred on the cell's middle."""
        spec = self.cfg["tumble"]
        pose = spec["impact"] if phase == 0 else spec["pose"]
        self.cfg["poses"]["_tumble"] = pose
        self.root.location = (0, 0, 0)
        self.set_pose("_tumble", pose.get("t", 0))
        angle = math.radians(TUMBLE_ANGLES[phase])
        # Blender: the creature faces -Y. Pitch back = head towards +Y (about -X); roll =
        # top towards the creature's right, -X in Blender (about -Y).
        axis = (-1, 0, 0) if spec["axis"] == "pitch" else (0, -1, 0)
        turn = mathutils.Quaternion(axis, angle)
        self.root.rotation_mode = "QUATERNION"
        self.root.rotation_quaternion = turn @ self.base_rotation
        bpy.context.view_layer.update()
        pts = world_verts(self.meshes)
        c = (pts.max(0) + pts.min(0)) / 2
        self.root.location = (-c[0], -c[1], self.cell_centre - c[2])
        bpy.context.view_layer.update()
        ext = pts.max(0) - pts.min(0)
        log(f"{self.cfg['kind']}: tumble{phase} extent x {ext[0]:.2f} y {ext[1]:.2f} z {ext[2]:.2f} m")

    def unturn(self):
        self.root.rotation_mode = "QUATERNION"
        self.root.rotation_quaternion = self.base_rotation

    def walk_cycle_metres(self):
        """Distance one walk cycle covers: twice the largest front/back foot spread."""
        bpy.context.view_layer.update()
        arm = self.arm
        if not arm:
            return self.cfg.get("cycleMetres", 1.0)
        feet = [
            b.name for b in arm.pose.bones
            if any(k in b.name.lower() for k in ("foot", "toe")) and "end" not in b.name.lower()
        ]
        if "cycleMetres" in self.cfg:
            return self.cfg["cycleMetres"]
        best = 0
        for i in range(24):
            self.set_pose("walk", i / 24)
            ys = [(arm.matrix_world @ arm.pose.bones[f].head).y for f in feet]
            if ys:
                best = max(best, max(ys) - min(ys))
        return 2 * best


# ---------------------------------------------------------------- rendering


def setup_render(size):
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "OPTIX"
    prefs.get_devices()
    for d in prefs.devices:
        d.use = d.type == "OPTIX"
    scene.cycles.device = "GPU"
    scene.cycles.use_denoising = False
    scene.cycles.max_bounces = 0
    scene.cycles.filter_width = 1.2
    scene.render.use_persistent_data = True
    scene.render.resolution_x = scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.view_settings.look = "None"
    scene.world = bpy.data.worlds.new("w")
    cam = bpy.data.objects.new("cam", bpy.data.cameras.new("cam"))
    scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.clip_start = 0.01
    cam.data.clip_end = 100
    scene.camera = cam
    return cam


def place_camera(cam, direction, dirs, cell_m, baseline_m):
    theta = direction / dirs * math.tau
    c = mathutils.Vector((math.sin(theta) * math.cos(PITCH), -math.cos(theta) * math.cos(PITCH), math.sin(PITCH)))
    right = mathutils.Vector((math.cos(theta), math.sin(theta), 0))
    up = c.cross(right).normalized()
    cam.data.ortho_scale = cell_m
    cam.location = c * 20 + up * (cell_m / 2 - baseline_m)
    cam.rotation_euler = (-c).to_track_quat("-Z", "Y").to_euler()


def set_pass(creature, which):
    scene = bpy.context.scene
    for mat, albedo, normal, out in creature.mat_outputs:
        mat.node_tree.links.new(albedo if which == "albedo" else normal, out.inputs["Surface"])
    if which == "albedo":
        scene.view_settings.view_transform = "Standard"
        scene.cycles.samples = 48
    else:
        scene.view_settings.view_transform = "Raw"
        scene.cycles.samples = 12


def main():
    argv = sys.argv[sys.argv.index("--") + 1 :]
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--kinds", default="")
    ap.add_argument("--size", type=int, default=256)
    ap.add_argument("--dirs", type=int, default=16)
    ap.add_argument("--preview", action="store_true")
    ap.add_argument("--columns", default="", help="only these columns, e.g. 12,13,14,15")
    args = ap.parse_args(argv)
    with open(args.config) as f:
        config = json.load(f)
    wanted = [k for k in args.kinds.split(",") if k]
    by_kind = {c["kind"]: c for c in config["kinds"]}
    for cfg in config["kinds"]:
        if "base" in cfg:
            # Variants start from another kind's settings (same model and animations).
            merged = json.loads(json.dumps(by_kind[cfg["base"]]))
            merged.update(cfg)
            cfg = merged
        if wanted and cfg["kind"] not in wanted:
            continue
        render_kind(cfg, args)


def render_kind(cfg, args):
    kind = cfg["kind"]
    creature = Creature(cfg, args.src)
    cam = setup_render(args.size)
    cell_m = cfg["cellMetres"]
    baseline_px = cfg.get("baselinePx", 6) * args.size / 128
    baseline_m = baseline_px / args.size * cell_m
    # Tumble columns: the body's box centred on the cell's middle (world z of that point).
    creature.cell_centre = cell_m / 2 - baseline_m
    out = os.path.join(args.out, kind)
    os.makedirs(os.path.join(out, "albedo"), exist_ok=True)
    os.makedirs(os.path.join(out, "normal"), exist_ok=True)
    cycle = creature.walk_cycle_metres()
    meta = {
        "kind": kind,
        "cellMetres": cell_m,
        "baselinePx128": cfg.get("baselinePx", 6),
        "cycleMetres": cycle,
        "displayScale": cfg.get("displayScale", 1.0),
        "dirs": args.dirs,
        "columns": COLUMNS,
    }
    with open(os.path.join(out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=1)
    log(f"{kind}: walk cycle {cycle:.2f} m")

    if args.preview:
        cells = [(c, d) for c in (0, 4, 8, 9, 10, 11, 12, 13, 14, 15) for d in (0, args.dirs // 8, args.dirs // 4, args.dirs * 3 // 8, args.dirs // 2)]
    else:
        cells = [(c, d) for c in range(len(COLUMNS)) for d in range(args.dirs)]
    if args.columns:
        keep = {int(c) for c in args.columns.split(",")}
        cells = [(c, d) for c, d in cells if c in keep]
    for which in ("albedo", "normal"):
        set_pass(creature, which)
        last = None
        for column, d in cells:
            if column != last:
                t = column / WALK_FRAMES if COLUMNS[column] == "walk" else 0
                creature.place(column, t)
                last = column
            place_camera(cam, d, args.dirs, cell_m, baseline_m)
            bpy.context.scene.render.filepath = os.path.join(out, which, f"{column:02d}_{d:02d}.png")
            bpy.ops.render.render(write_still=True)
    log(f"{kind}: done ({len(cells)} cells)")


if __name__ == "__main__":
    main()
