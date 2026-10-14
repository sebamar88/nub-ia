// TypeScript face of scripts/approved-packages.mjs for the extensions.
export { checkPackageSource, normalizePackageSource, parseApprovedPackages, unapprovedInSettings } from "../scripts/approved-packages.mjs";
export interface ApprovedPackages { sources: string[]; mode: "warn" | "enforce" }
