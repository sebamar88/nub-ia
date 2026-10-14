// Secret redaction (roadmap T7.5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { containsSecret, describeRedactions, redactSecrets } from "../lib/secret-redaction.ts";

test("redactSecrets: known credential shapes are replaced and reported", () => {
	const cases: Array<[string, RegExp, string]> = [
		["accessKeyId: AKIAIOSFODNN7EXAMPLE", /AKIA…\[redacted aws key\]/, "aws-access-key"],
		["aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", /aws_secret_access_key = \[redacted\]/, "aws-secret"],
		["token ghp_abcdefghijklmnopqrstuvwxyz0123456789", /\[redacted github token\]/, "github-token"],
		["github_pat_11ABCDEFG0123456789abcdefghijklmnopqrstuvwxyz", /\[redacted github token\]/, "github-token"],
		["OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123", /sk-…\[redacted api key\]/, "openai-key"],
		["xoxb-123456789012-abcdefghij", /xox…\[redacted slack token\]/, "slack-token"],
		["AIzaSyA1234567890abcdefghijklmnopqrstuv", /AIza…\[redacted google key\]/, "google-api-key"],
		["sk_live_abcdefghijklmnop1234", /\[redacted stripe key\]/, "stripe-key"],
		["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", /eyJ…\[redacted jwt\]/, "jwt"],
		["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nABC\n-----END RSA PRIVATE KEY-----", /BEGIN PRIVATE KEY-----\[redacted\]-----END/, "private-key"],
		["postgres://user:S3cr3tP%40ss@db.internal:5432/app", /postgres:\/\/user:\[redacted\]@db\.internal/, "url-credentials"],
		["Authorization: Bearer abcdefghijklmnopqrstuvwxyz", /Authorization: Bearer \[redacted\]/, "bearer"],
		["DATABASE_PASSWORD=hunter2hunter2", /DATABASE_PASSWORD=\[redacted\]/, "env-secret"],
		["export CLIENT_SECRET='abcdefgh12345678'", /CLIENT_SECRET='\[redacted\]'/, "env-secret"],
	];
	for (const [input, expected, kind] of cases) {
		const result = redactSecrets(input);
		assert.match(result.text, expected, input);
		assert.ok(result.redactions.some((entry) => entry.kind === kind), `${input} → ${describeRedactions(result.redactions)}`);
	}
});

test("redactSecrets: ordinary code, hashes, UUIDs and paths are left alone", () => {
	const clean = [
		"commit 41e114fd9c2b3a7e8f0d1c2b3a4e5f60718293a4 (HEAD -> main)",
		"id: 123e4567-e89b-12d3-a456-426614174000",
		"const token = await getToken();",
		"PASSWORD_MIN_LENGTH=8",
		"export PATH=/usr/local/bin:$PATH",
		"https://github.com/sebamar88/nub-ia.git",
		"sha256-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF=",
		"skills/nubia/SKILL.md",
		"The task is to add tests.",
	];
	for (const text of clean) {
		assert.deepEqual(redactSecrets(text), { text, redactions: [] }, text);
		assert.equal(containsSecret(text), false, text);
	}
});

test("redactSecrets: several secrets in one blob are all caught and counted", () => {
	const blob = "AKIAIOSFODNN7EXAMPLE then ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAI44QH8DHBEXAMPLE";
	const result = redactSecrets(blob);
	assert.doesNotMatch(result.text, /AKIAI|ghp_a/);
	assert.equal(describeRedactions(result.redactions), "2 aws-access-key, 1 github-token");
});
