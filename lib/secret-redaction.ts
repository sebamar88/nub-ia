// Secret redaction (roadmap T7.5): replaces credential-shaped tokens before
// text reaches the model (bash/read tool output), a review report on disk, the
// local metrics, or the prompt history. Pattern based and deliberately narrow:
// a missed secret is bad, but so is mangling a git hash, a UUID or a base64
// image; each pattern targets a known credential shape.

export interface Redaction {
	kind: string;
	count: number;
}

interface Rule {
	kind: string;
	pattern: RegExp;
	/** Replacement; `$1` keeps a prefix so the reader still knows what was there. */
	replace: string;
}

const RULES: Rule[] = [
	{ kind: "aws-access-key", pattern: /\b((?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[A-Z0-9]{16})\b/g, replace: "AKIA…[redacted aws key]" },
	{ kind: "aws-secret", pattern: /\b(aws_secret_access_key|secretAccessKey|AWS_SECRET_ACCESS_KEY)\b(\s*[:=]\s*["']?)([A-Za-z0-9/+=]{40})\b/g, replace: "$1$2[redacted]" },
	{ kind: "github-token", pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, replace: "[redacted github token]" },
	{ kind: "openai-key", pattern: /\b(sk-(?:proj-|ant-|or-)?[A-Za-z0-9_-]{20,})\b/g, replace: "sk-…[redacted api key]" },
	{ kind: "slack-token", pattern: /\b(xox[abprs]-[A-Za-z0-9-]{10,})\b/g, replace: "xox…[redacted slack token]" },
	{ kind: "google-api-key", pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g, replace: "AIza…[redacted google key]" },
	{ kind: "stripe-key", pattern: /\b((?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,})\b/g, replace: "[redacted stripe key]" },
	{ kind: "npm-token", pattern: /\b(npm_[A-Za-z0-9]{36})\b/g, replace: "npm_…[redacted npm token]" },
	{ kind: "jwt", pattern: /\b(eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g, replace: "eyJ…[redacted jwt]" },
	{ kind: "private-key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/g, replace: "-----BEGIN PRIVATE KEY-----[redacted]-----END PRIVATE KEY-----" },
	{ kind: "url-credentials", pattern: /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi, replace: "$1$2:[redacted]@" },
	{ kind: "bearer", pattern: /\b(Authorization\s*[:=]\s*["']?Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, replace: "$1[redacted]" },
	{ kind: "env-secret", pattern: /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*=\s*)(["']?)(?!\[redacted)\S{8,}\2\s*$/gim, replace: "$1$2[redacted]$2" },
];

/** Redacts known credential shapes; returns the text and what was found. */
export function redactSecrets(text: string): { text: string; redactions: Redaction[] } {
	if (text.length === 0) return { text, redactions: [] };
	let out = text;
	const redactions: Redaction[] = [];
	for (const rule of RULES) {
		let count = 0;
		out = out.replace(rule.pattern, (...args) => {
			count += 1;
			return rule.replace.replace(/\$(\d)/g, (_, index) => String(args[Number(index)] ?? ""));
		});
		if (count) redactions.push({ kind: rule.kind, count });
	}
	return { text: out, redactions };
}

/** True when the text carries anything redactSecrets would touch. */
export function containsSecret(text: string): boolean {
	return redactSecrets(text).redactions.length > 0;
}

export function describeRedactions(redactions: readonly Redaction[]): string {
	return redactions.map((entry) => `${entry.count} ${entry.kind}`).join(", ");
}
