#!/usr/bin/env node
// Regenerates the startup-banner artwork (extensions/startup-banner.ts) from
// the brand PNGs in assets/brand/. Needs Python 3 with Pillow.
//
//   node scripts/trace-brand.mjs isologo [rows=7]   → ROSE_LARGE_RAW (braille, from nubiral-isologo.png)
//   node scripts/trace-brand.mjs wordmark [rows=7]  → TEXT_LOGO (quadrant blocks, from the black text in nubiral-logo.png)
//
// Paste the printed array over the matching constant. Braille (2×4 dots per
// cell) keeps the isologo's thin open cuts; quadrant blocks (2×2 per cell,
// width doubled to undo the 1:2 terminal cell aspect) keep the wordmark bold.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const what = process.argv[2];
const rows = Number(process.argv[3] ?? 7);
if (what !== "isologo" && what !== "wordmark") {
	console.error("usage: node scripts/trace-brand.mjs <isologo|wordmark> [rows]");
	process.exit(2);
}
const file = what === "isologo" ? "nubiral-isologo.png" : "nubiral-logo.png";
const constant = what === "isologo" ? "ROSE_LARGE_RAW" : "TEXT_LOGO";
// isologo: the lime mark; wordmark: the black letters only (the PNG also carries the mark).
const predicate = what === "isologo" ? "a > 128 and g > 150 and b < 120 and r > 150" : "a > 128 and r < 90 and g < 90 and b < 90";
const py = `
from PIL import Image
im = Image.open(${JSON.stringify(join(root, "assets", "brand", file))}).convert("RGBA")
px = im.load(); W, H = im.size
mask = Image.new("L", (W, H), 0); mp = mask.load(); xs = []; ys = []
for y in range(H):
    for x in range(W):
        r, g, b, a = px[x, y]
        if ${predicate}:
            mp[x, y] = 255; xs.append(x); ys.append(y)
mask = mask.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
rows = ${rows}; bw, bh = mask.size; th = 0.45 * 255
lines = []
if ${JSON.stringify(what)} == "isologo":
    dh = rows * 4; dw = round(dh * bw / bh); cols = (dw + 1) // 2; dw = cols * 2
    sp = mask.resize((dw, dh), Image.BOX).load()
    bits = [(0,0,1),(0,1,2),(0,2,4),(1,0,8),(1,1,16),(1,2,32),(0,3,64),(1,3,128)]
    for r in range(rows):
        line = ""
        for c in range(cols):
            v = 0
            for dx, dy, b in bits:
                if sp[c*2+dx, r*4+dy] >= th: v |= b
            line += chr(0x2800 + v) if v else " "
        lines.append(" " + line.rstrip())
else:
    QUAD = " ▘▝▀▖▌▞▛▗▚▐▜▄▙▟█"
    dh = rows * 2; dw = round(dh * bw / bh * 2); cols = (dw + 1) // 2; dw = cols * 2
    sp = mask.resize((dw, dh), Image.BOX).load()
    for r in range(rows):
        line = ""
        for c in range(cols):
            v = 0
            for dx, dy, b in [(0,0,1),(1,0,2),(0,1,4),(1,1,8)]:
                if sp[c*2+dx, r*2+dy] >= th: v |= b
            line += QUAD[v]
        lines.append(line.rstrip())
w = max(len(l) for l in lines)
print("const ${constant} = [")
for l in lines: print('  "' + l.ljust(w) + '",')
print("];")
`;
const result = spawnSync("python3", ["-c", py], { stdio: "inherit" });
process.exit(result.status ?? 1);
