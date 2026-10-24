#!/bin/bash
# render.sh MODEL PNG VIEW [extra f3d args]
#   MODEL  an OBJ in STEP space (Z up) or a glb/gltf from glb.py (Y up); the axis follows the extension
#   VIEW   top | iso | iso2
# Renders headless with F3D (--no-config, so personal F3D settings never change the picture).
set -euo pipefail
[ $# -ge 3 ] || { sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
o=$1; p=$2; v=$3; shift 3
case "${o##*.}" in
  glb|gltf)
    up=+Y
    colour=()  # keep the file's own materials
    case $v in
      top) cam=(--camera-direction=0,-1,-0.001);;  # F3D ignores view-up parallel to --up; tilt a hair
      iso) cam=(--camera-direction=-1,-0.8,-1);;
      iso2) cam=(--camera-direction=1,-0.8,1);;
      *) echo "view: top | iso | iso2" >&2; exit 2;;
    esac;;
  *)
    up=+Z
    colour=(--color=#7a8ca0)  # OBJ has no usable colours in F3D
    case $v in
      top) cam=(--camera-direction=0,0.001,-1);;  # north (+Y) up, east (+X) right
      iso) cam=(--camera-direction=-1,1,-0.8);;
      iso2) cam=(--camera-direction=1,-1,-0.8);;
      *) echo "view: top | iso | iso2" >&2; exit 2;;
    esac;;
esac
f3d "$o" --no-config --output="$p" --resolution=1600,1200 --up="$up" "${cam[@]}" \
  --ambient-occlusion=false --background-color=#ffffff "${colour[@]}" \
  --grid=false --axis=false --filename=false "$@" >/dev/null  # F3D errors stay visible
