// Reusable tracing core: turns a logo PNG into terminal art. Needs Python 3 + Pillow.
//   traceLogo({ file, kind: "isologo"|"wordmark", rows, predicate })
// predicate: "alpha" (contract for new logos: a > 128) or a legacy
// Nubiral color predicate ("nubiral-isologo" | "nubiral-wordmark"), kept only
// for scripts/trace-brand.mjs.
// Braille (2x4 dots per cell) keeps the isologo's thin open cuts; quadrant
// blocks (2x2 per cell, width doubled to undo the 1:2 terminal cell aspect)
// keep the wordmark bold.
import { spawnSync } from "node:child_process";

const PY = `
import sys
from PIL import Image
file, kind, rows, pred = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
sys.stdout.reconfigure(encoding="utf-8")
PRED = {
    "alpha": lambda r, g, b, a: a > 128,
    "nubiral-isologo": lambda r, g, b, a: a > 128 and g > 150 and b < 120 and r > 150,
    "nubiral-wordmark": lambda r, g, b, a: a > 128 and r < 90 and g < 90 and b < 90,
}[pred]
im = Image.open(file).convert("RGBA")
px = im.load(); W, H = im.size
if pred == "alpha" and not any(px[x, y][3] < 128 for y in range(H) for x in range(W)):
    sys.stderr.write("PNG has no transparent pixels (no alpha channel or fully opaque): logos must have a transparent background\\n")
    sys.exit(3)
mask = Image.new("L", (W, H), 0); mp = mask.load(); xs = []; ys = []
for y in range(H):
    for x in range(W):
        if PRED(*px[x, y]):
            mp[x, y] = 255; xs.append(x); ys.append(y)
if not xs:
    sys.stderr.write("nothing to trace: no pixel matched\\n")
    sys.exit(4)
mask = mask.crop((min(xs), min(ys), max(xs) + 1, max(ys) + 1))
bw, bh = mask.size; th = 0.45 * 255
lines = []
if kind == "isologo":
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
print("\\n".join(l.ljust(w) for l in lines))
`;

/** Returns the traced art as equal-width lines. Throws Error on failure (message includes Pillow/Python output). */
export function traceLogo({ file, kind, rows = 7, predicate = "alpha" }) {
	const r = spawnSync("python3", ["-c", PY, file, kind, String(rows), predicate], { encoding: "utf8" });
	if (r.status !== 0) throw new Error(`cannot trace ${file}: ${(r.stderr || r.error?.message || "python3 failed").trim()}`);
	return r.stdout.replace(/\n$/, "").split("\n");
}

/**
 * One weight per letter: letters are runs of occupied columns separated by
 * empty columns; weight = the run's column span. No gaps => a single weight.
 */
export function letterWeights(wordmark) {
	const width = Math.max(...wordmark.map((l) => l.length));
	const weights = [];
	let run = 0;
	for (let c = 0; c <= width; c++) {
		if (c < width && wordmark.some((l) => (l[c] ?? " ") !== " ")) run++;
		else if (run) weights.push(run), (run = 0);
	}
	return weights;
}
