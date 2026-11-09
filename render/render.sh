#!/bin/bash
# Renders a generated scene with vork, then encodes an MP4.
#   render/render.sh horde/out/scene.json 144 431 horde.mp4
# The first 6 s (frames 0-143) only warm up the simulation, so renders start at frame 144.
set -e
SCENE=$1; FROM=${2:-144}; TO=$3; OUT=${4:-out.mp4}
FRAMES=$(dirname "$SCENE")/frames
rm -rf "$FRAMES"; mkdir -p "$FRAMES"
time vork render "$SCENE" --profile std/final --frame-start "$FROM" --frame-end "$TO" --out "$FRAMES"
ffmpeg -y -loglevel error -framerate 24 -start_number "$FROM" -i "$FRAMES/%06d.png" \
  -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -movflags +faststart "$OUT"
