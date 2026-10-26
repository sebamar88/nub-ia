// Imported first by bin/nub-ia.mjs, synchronously (a top-level await here
// would not hold back the sibling imports). An invalid brand.json is reported
// as one clean line instead of an uncaught module error with a stack trace.
// The brand is unreadable at this point, so the binary name is a literal.
import { createRequire } from "node:module";

try {
	createRequire(import.meta.url)("../runtime/brand.mjs");
} catch (error) {
	if (error?.name !== "BrandError") throw error;
	process.stderr.write(`nub-ia: ${error.message}\n`);
	process.exit(2);
}
