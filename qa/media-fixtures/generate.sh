#!/usr/bin/env bash
# SPDX-License-Identifier: FSL-1.1-ALv2
#
# Regenerate the neutral media fixtures the media-analysis e2e scenarios use
# (apps/api/src/tests/e2e/media-analysis*.scenario.test.ts). Every file is
# synthetic: coloured shapes drawn by ffmpeg, no photo or recording of anything.
# One fixture per input path the analyzer handles:
#
#   grid.heic           HEIC still   -> heic-convert to JPEG
#   shapes.png          PNG still    -> pass-through
#   moving-square.mp4   H.264 MP4    -> pass-through (the longest clip)
#   colour-cycle.mov    H.264 MOV    -> pass-through
#   moving-square-hevc.mov  HEVC MOV -> ffmpeg transcode to H.264
#
# Needs ffmpeg with libx264 and libx265, and macOS `sips` for the HEIC encode.
# The scenarios read `manifest.json` beside the files; a different fixture set
# (same manifest ids) can be pointed at with LIAISON_MEDIA_FIXTURES_DIR.
#
#   bash qa/media-fixtures/generate.sh
set -euo pipefail
cd "$(dirname "$0")"
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }

# A 4x4 grid of coloured squares on a dark panel, one square outlined in green.
grid_filter="color=c=0x202020:s=800x800:d=1"
colours=(red orange yellow white blue cyan magenta purple red orange yellow white blue cyan magenta purple)
i=0
chain=""
for row in 0 1 2 3; do
  for col in 0 1 2 3; do
    x=$((60 + col * 180)); y=$((60 + row * 180))
    chain+=",drawbox=x=${x}:y=${y}:w=140:h=140:color=${colours[$i]}:t=fill"
    i=$((i + 1))
  done
done
chain+=",drawbox=x=410:y=230:w=160:h=160:color=lime:t=12"
ff -f lavfi -i "${grid_filter}${chain}" -frames:v 1 grid-src.png
sips -s format heic grid-src.png --out grid.heic >/dev/null
rm grid-src.png

# A blue background with a large yellow rectangle and a smaller red one.
ff -f lavfi -i "color=c=blue:s=1280x800:d=1,drawbox=x=120:y=160:w=620:h=420:color=yellow:t=fill,drawbox=x=860:y=300:w=280:h=200:color=red:t=fill" \
  -frames:v 1 shapes.png

# 12 s: a white square sliding left to right across a navy background (H.264 MP4).
ff -f lavfi -i "color=c=navy:s=640x360:d=12:r=24" -f lavfi -i "color=c=white:s=90x90:d=12:r=24" \
  -filter_complex "[0][1]overlay=x='t*45':y=135:shortest=1,format=yuv420p" \
  -c:v libx264 -preset veryslow -crf 30 -movflags +faststart moving-square.mp4

# 6 s: the whole frame red, then green, then blue, 2 s each (H.264 MOV).
ff -f lavfi -i "color=c=red:s=640x360:d=2:r=24" -f lavfi -i "color=c=lime:s=640x360:d=2:r=24" \
  -f lavfi -i "color=c=blue:s=640x360:d=2:r=24" \
  -filter_complex "[0][1][2]concat=n=3:v=1:a=0,format=yuv420p" \
  -c:v libx264 -preset veryslow -crf 30 colour-cycle.mov

# 4 s: a black square sliding across a yellow background (HEVC MOV, tagged hvc1).
ff -f lavfi -i "color=c=yellow:s=640x360:d=4:r=24" -f lavfi -i "color=c=black:s=90x90:d=4:r=24" \
  -filter_complex "[0][1]overlay=x='t*120':y=135:shortest=1,format=yuv420p" \
  -c:v libx265 -x265-params log-level=error -crf 30 -tag:v hvc1 moving-square-hevc.mov

ls -l grid.heic shapes.png moving-square.mp4 colour-cycle.mov moving-square-hevc.mov
