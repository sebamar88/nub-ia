// Derives the banner palette and Pi theme from the brand colors. Explicit
// colors.overrides always win over derived values.
import type { Brand } from "./brand.ts";

export type RGB = [number, number, number];
export interface BannerPalette { rose: RGB; label: RGB; value: RGB; logoFresh: RGB; logoDim: RGB }

const BANNER_BG: RGB = [10, 11, 8];
const MIN_CONTRAST = 4.5;

function parseHex(hex: string): RGB {
	const n = parseInt(hex.slice(1), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex(c: RGB): string {
	return `#${c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function luminance([r, g, b]: RGB): number {
	const [R, G, B] = [r, g, b].map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

export function contrastRatio(a: RGB, b: RGB): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function toHsl([r, g, b]: RGB): [number, number, number] {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const l = (max + min) / 2;
	if (max === min) return [0, 0, l];
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
	return [h / 6, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): RGB {
	const f = (n: number) => {
		const k = (n + h * 12) % 12;
		return (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
	};
	return [Math.round(f(0)), Math.round(f(8)), Math.round(f(4))];
}

function withLightness(c: RGB, factor: number): RGB {
	const [h, s, l] = toHsl(c);
	return fromHsl([h, s, Math.min(1, l * factor)]);
}

// Lightens until the color meets the minimum contrast against bg.
function ensureContrast(c: RGB, bg: RGB): RGB {
	let [h, s, l] = toHsl(c);
	let out = c;
	while (contrastRatio(out, bg) < MIN_CONTRAST && l < 1) {
		l = Math.min(1, l + 0.03);
		out = fromHsl([h, s, l]);
	}
	return out;
}

function mix(color: RGB, base: RGB, amount: number): RGB {
	return color.map((v, i) => v * amount + base[i] * (1 - amount)) as RGB;
}

export function deriveBannerPalette(colors: Brand["colors"]): BannerPalette {
	const rose = parseHex(colors.primary);
	const derived: BannerPalette = {
		rose,
		label: ensureContrast(withLightness(rose, 0.8), BANNER_BG),
		value: ensureContrast(withLightness(rose, 1.25), BANNER_BG),
		logoFresh: [240, 240, 240],
		logoDim: mix(rose, BANNER_BG, 0.4).map(Math.round) as RGB,
	};
	return { ...derived, ...colors.overrides?.banner };
}

export function deriveTheme(template: Record<string, unknown>, brand: Brand): Record<string, unknown> {
	const vars = template.vars as Record<string, string>;
	const bg = parseHex(vars.bg);
	const primary = parseHex(brand.colors.primary);
	const tint = (amount: number) => toHex(mix(primary, bg, amount));
	return {
		...template,
		name: brand.name,
		vars: {
			...vars,
			accent: brand.colors.primary,
			deepPink: toHex(withLightness(primary, 0.75)),
			activePink: brand.colors.accent,
			border: tint(0.25),
			borderSubtle: tint(0.12),
			bgPanel: tint(0.06),
			bgElement: tint(0.06),
			bgSubtle: tint(0.06),
			userMessageBg: tint(0.1),
			...brand.colors.overrides?.theme,
		},
	};
}
