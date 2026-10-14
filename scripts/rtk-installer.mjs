#!/usr/bin/env node
// Package-local rtk installer (https://github.com/rtk-ai/rtk, MIT).
//
// Downloads the pinned rtk release archive for this platform, verifies its
// SHA-256 against the digest pinned below (copied from the release's
// checksums.txt), extracts the single `rtk` executable into
// `<package>/.rtk/<version>/`, and reports the binary path. Idempotent: an
// existing binary whose SHA-256 matches the recorded executable digest is kept
// (or, on platforms without a recorded digest yet, any non-empty binary).
//
// Run by `postinstall` (scripts/install-rtk.mjs) so every Nub-IA install ships
// rtk without a separate step; extensions/rtk-rewrite.ts prefers this copy
// over whatever `rtk` is on PATH. Bumping the pin: update RTK_VERSION and the
// archive digests from the new checksums.txt, run the installer once, and
// paste the printed executable digests into RTK_BINARY_SHA256.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import https from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const RTK_VERSION = "1.0.1";
export const RTK_RELEASE_BASE_URL = `https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/`;
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 30_000;

// Digest of the extracted executable per platform, computed from the pinned
// archives (run the installer once, paste the printed digest). An existing
// binary that does not match is replaced; `undefined` means not yet recorded
// for that platform, in which case the archive digest alone protects the
// download and a present binary is re-verified by size only.
export const RTK_BINARY_SHA256 = Object.freeze({
	"linux-x64": "2e7508fe33f5fa336df8784158fafffa9bca09d060de22f7b4c6246ede96c4c4",
	"linux-arm64": undefined,
	"darwin-x64": undefined,
	"darwin-arm64": undefined,
	"win32-x64": undefined,
});

// Archive digests from the release's checksums.txt (v1.0.1).
export const RTK_ASSETS = Object.freeze({
	"linux-x64": { file: "rtk-x86_64-unknown-linux-musl.tar.gz", sha256: "5b919c3bccb799b67a61866d0e617410a4fcdf173e2614440e59de2fa2003436" },
	"linux-arm64": { file: "rtk-aarch64-unknown-linux-gnu.tar.gz", sha256: "cd627c4091ad90b5e5aca83ca5af66ee4b8aa8537a736533fa90544f461f1c2b" },
	"darwin-x64": { file: "rtk-x86_64-apple-darwin.tar.gz", sha256: "4b716b2f45d677de41c99f77d9a71199ad060b98ec2f78ef712885312b3a6578" },
	"darwin-arm64": { file: "rtk-aarch64-apple-darwin.tar.gz", sha256: "4aae2f60cfc49c9e81b8c8c57020aa0cb824da608c78b4f0cf5c0988e19e824e" },
	"win32-x64": { file: "rtk-x86_64-pc-windows-msvc.zip", sha256: "64b4807c50b61dddf2ac1e86751dbda9117ab94ed02bf266e6584da571c39896" },
});

export class RtkInstallerError extends Error {
	constructor(code, message, cause) {
		super(message, cause === undefined ? undefined : { cause });
		this.code = code;
		this.name = "RtkInstallerError";
	}
}

export function platformKey(platform = process.platform, arch = process.arch) {
	return `${platform}-${arch}`;
}

export function packageRoot() {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function rtkExecutableName(platform = process.platform) {
	return platform === "win32" ? "rtk.exe" : "rtk";
}

/** Where this package keeps its rtk copy; the extension probes this path first. */
export function packageLocalRtkPath(root = packageRoot(), platform = process.platform) {
	return join(root, ".rtk", RTK_VERSION, rtkExecutableName(platform));
}

async function sha256File(path) {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

function download(url, destination, redirects = 0) {
	return new Promise((resolve, reject) => {
		const request = https.get(url, { headers: { "user-agent": "nub-ia-rtk-installer" }, timeout: REQUEST_TIMEOUT_MS }, (response) => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.resume();
				if (redirects >= MAX_REDIRECTS) return reject(new RtkInstallerError("RTK_TOO_MANY_REDIRECTS", `too many redirects fetching ${url}`));
				return resolve(download(new URL(response.headers.location, url).toString(), destination, redirects + 1));
			}
			if (status !== 200) {
				response.resume();
				return reject(new RtkInstallerError("RTK_DOWNLOAD_FAILED", `HTTP ${status} fetching ${url}`));
			}
			const chunks = [];
			let size = 0;
			response.on("data", (chunk) => {
				size += chunk.length;
				if (size > MAX_DOWNLOAD_BYTES) {
					response.destroy();
					reject(new RtkInstallerError("RTK_DOWNLOAD_TOO_LARGE", `${url} exceeded ${MAX_DOWNLOAD_BYTES} bytes`));
					return;
				}
				chunks.push(chunk);
			});
			response.on("error", (error) => reject(new RtkInstallerError("RTK_DOWNLOAD_FAILED", `network error fetching ${url}`, error)));
			response.on("end", async () => {
				try {
					const { writeFile } = await import("node:fs/promises");
					await writeFile(destination, Buffer.concat(chunks));
					resolve(undefined);
				} catch (error) {
					reject(error);
				}
			});
		});
		request.on("timeout", () => request.destroy(new RtkInstallerError("RTK_DOWNLOAD_TIMEOUT", `timed out fetching ${url}`)));
		request.on("error", (error) => reject(new RtkInstallerError("RTK_DOWNLOAD_FAILED", `network error fetching ${url}`, error)));
	});
}

// Both archive flavours hold a single top-level `rtk`/`rtk.exe`. Linux and
// macOS extract the .tar.gz with the system tar. Windows ships a .zip: the
// `tar` found first under Git Bash is GNU tar, which cannot read zip, so
// PowerShell's Expand-Archive (present on every supported Windows) is used.
async function extract(archive, into, platform) {
	if (platform === "win32") {
		const script = `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${into.replace(/'/g, "''")}' -Force`;
		await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 60_000 });
	} else {
		await execFileAsync("tar", ["-xf", archive, "-C", into], { timeout: 60_000 });
	}
	const binary = join(into, rtkExecutableName(platform));
	if (!existsSync(binary)) throw new RtkInstallerError("RTK_ARCHIVE_UNEXPECTED", `archive did not contain ${rtkExecutableName(platform)}`);
	return binary;
}

/**
 * Installs (or verifies) the pinned rtk for this platform. Returns
 * `{ installed, binaryPath, sha256 }`; throws RtkInstallerError with a stable
 * `code` on an unsupported platform, download, digest, or extraction failure.
 */
export async function installRtk({ root = packageRoot(), platform = process.platform, arch = process.arch, fetch = download } = {}) {
	const key = platformKey(platform, arch);
	const asset = RTK_ASSETS[key];
	if (!asset) throw new RtkInstallerError("RTK_UNSUPPORTED_PLATFORM", `no pinned rtk ${RTK_VERSION} build for ${key}`);
	const binaryPath = packageLocalRtkPath(root, platform);

	if (existsSync(binaryPath)) {
		const info = await stat(binaryPath);
		if (info.isFile() && info.size > 0) {
			const sha256 = await sha256File(binaryPath);
			const expected = RTK_BINARY_SHA256[key];
			// A recorded digest is authoritative: a mismatch (corruption, a
			// tampered or stale copy) falls through to a fresh verified download.
			if (expected === undefined || sha256 === expected) return { installed: false, binaryPath, sha256 };
			await rm(binaryPath, { force: true });
		}
	}

	const scratch = await mkdtemp(join(tmpdir(), "nub-ia-rtk-"));
	try {
		const archive = join(scratch, asset.file);
		await fetch(`${RTK_RELEASE_BASE_URL}${asset.file}`, archive);
		const actual = await sha256File(archive);
		if (actual !== asset.sha256) {
			throw new RtkInstallerError("RTK_DIGEST_MISMATCH", `${asset.file}: expected sha256 ${asset.sha256}, got ${actual}`);
		}
		const extracted = await extract(archive, scratch, platform);
		await mkdir(dirname(binaryPath), { recursive: true });
		const staged = `${binaryPath}.${process.pid}.tmp`;
		await rename(extracted, staged).catch(async () => {
			const { copyFile } = await import("node:fs/promises");
			await copyFile(extracted, staged);
		});
		if (platform !== "win32") await chmod(staged, 0o755);
		await rename(staged, binaryPath);
		return { installed: true, binaryPath, sha256: await sha256File(binaryPath) };
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}
