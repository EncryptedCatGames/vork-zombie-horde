# Windows version of render.sh:  .\render\render.ps1 horde\out\scene.json 144 431 horde.mp4
param([string]$Scene, [int]$From = 144, [int]$To, [string]$Out = "out.mp4")
$vork = "$env:LOCALAPPDATA\Programs\vork\vork.exe"
$frames = Join-Path (Split-Path $Scene) "frames"
Remove-Item -Recurse -Force $frames -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force $frames | Out-Null
$r = Measure-Command { & $vork render $Scene --profile std/final --frame-start $From --frame-end $To --out $frames | Out-Host }
"render: {0:N1} s" -f $r.TotalSeconds
ffmpeg -y -loglevel error -framerate 24 -start_number $From -i "$frames\%06d.png" -c:v libx264 -crf 17 -preset slow -pix_fmt yuv420p -movflags +faststart $Out
