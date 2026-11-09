#!/bin/bash
# Bakes the five zombie kinds for vork. Needs Blender 4.x on PATH and the two CC0 model packs
# unpacked into <models dir> (see README). Writes the instancing meshes into horde/out/.
#   bake/bake.sh <models dir>
set -e
SRC=$(cd "$1" && pwd); HERE=$(cd "$(dirname "$0")" && pwd); OUT=$HERE/../horde/out
mkdir -p "$OUT/lo"
for k in zombie zombieWoman zombieFat zombieCop zombieWorker; do
  # full meshes: a 16-pose walk cycle plus launch and dead poses, about 2,900 triangles each
  FRAMES=16 TARGET_TRIS=2900 blender -b --factory-startup --python "$HERE/bake_horde.py" -- "$HERE/creatures" "$SRC" $k "$OUT"
  # low-poly copies (450 triangles) for the bodies in the air and on the ground in the nuke scene
  FRAMES=1 TARGET_TRIS=450 blender -b --factory-startup --python "$HERE/bake_horde.py" -- "$HERE/creatures" "$SRC" $k "$OUT/lo"
done
