#!/bin/sh
S=/tmp/claude-0/-home-user-MonsterGame/1102f6db-f16b-535a-a58c-b370676b9fdf/scratchpad/shots
U='http://localhost:5202/?webgl&quality=high'
Z='--size 960x540 --wait 6000'
L='mb.town.lights.slice(10).forEach(l=>l.visible=false);'
H="$L mb.basalt.object.visible=false;"
node scripts/shot.cjs "$U" $S/B2-default-rain.png $Z --eval "$L" > $S/l1.txt 2>&1
node scripts/shot.cjs "$U" $S/B2-default-dry.png $Z --eval "$L mb.config.weather.rain=0" > $S/l2.txt 2>&1
node scripts/shot.cjs "$U" $S/B2-terrace.png $Z --eval "$H mb.config.camera.distance=22; mb.config.camera.pitch=0.12; mb.config.camera.lookAtHeight=4" --keys ArrowRight:2200,KeyW:1500 > $S/l3.txt 2>&1
node scripts/shot.cjs "$U" $S/B2-townhall.png $Z --eval "$H mb.config.camera.distance=30; mb.config.camera.pitch=0.15; mb.config.camera.lookAtHeight=9" --keys KeyW:7000 > $S/l4.txt 2>&1
node scripts/shot.cjs "$U" $S/B2-overview.png $Z --eval "$L mb.config.camera.distance=150; mb.config.camera.pitch=0.9" > $S/l5.txt 2>&1
node scripts/shot.cjs "$U" $S/B2-church.png $Z --eval "$H mb.config.camera.distance=40; mb.config.camera.pitch=0.15; mb.config.camera.lookAtHeight=10" --keys ArrowLeft:3500,KeyW:4000 > $S/l6.txt 2>&1
echo done > $S/batch2.done
