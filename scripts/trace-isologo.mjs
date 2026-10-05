#!/usr/bin/env node
// Regenerates the braille isologo used by extensions/startup-banner.ts
// (ROSE_LARGE_RAW) from assets/brand/nubiral-isologo.png. Needs Python 3 with
// Pillow (`pip install pillow`). Usage: node scripts/trace-isologo.mjs [rows]
// Prints the TypeScript array literal; paste it over ROSE_LARGE_RAW.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rows = Number(process.argv[2] ?? 7);
const py = `
from PIL import Image
im = Image.open(${JSON.stringify(join(root, "assets", "brand", "nubiral-isologo.png"))}).convert("RGBA")
px = im.load(); W, H = im.size
mask = Image.new("L", (W, H), 0); mp = mask.load(); xs = []; ys = []
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if a > 128 and g > 150 and b < 120 and r > 150:
            mp[x, y] = 255; xs.append(x); ys.append(y)
mask = mask.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
rows = ${rows}; bw, bh = mask.size
dh = rows * 4; dw = round(dh * bw / bh); cols = (dw + 1) // 2; dw = cols * 2
sp = mask.resize((dw, dh), Image.BOX).load()
bits = [(0,0,1),(0,1,2),(0,2,4),(1,0,8),(1,1,16),(1,2,32),(0,3,64),(1,3,128)]
lines = []
for r in range(rows):
    line = ""
    for c in range(cols):
        v = 0
        for dx, dy, b in bits:
            if sp[c*2+dx, r*4+dy] >= 0.42 * 255: v |= b
        line += chr(0x2800 + v) if v else " "
    lines.append(" " + line.rstrip())
w = max(len(l) for l in lines)
print("const ROSE_LARGE_RAW = [")
for l in lines: print('  "' + l.ljust(w) + '",')
print("];")
`;
const result = spawnSync("python3", ["-c", py], { stdio: "inherit" });
process.exit(result.status ?? 1);
