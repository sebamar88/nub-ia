// Git routing/configuration overrides that must not leak from a parent process
// into a child that operates on a different clone.
const UNSAFE_GIT_ENVIRONMENT = new Set([
	"GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_QUARANTINE_PATH", "GIT_PREFIX", "GIT_SUPER_PREFIX", "GIT_CEILING_DIRECTORIES", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT", "GIT_REPLACE_REF_BASE", "GIT_NO_REPLACE_OBJECTS", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE",
]);

const UNSAFE_PUBLICATION_GIT_ENVIRONMENT = new Set([
	...UNSAFE_GIT_ENVIRONMENT,
	"GIT_EXEC_PATH", "GIT_TEMPLATE_DIR", "GIT_CONFIG_PARAMETERS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_PROXY_COMMAND",
]);

export function inheritedUnsafeGitEnvironmentKeys(
	environment: NodeJS.ProcessEnv = process.env,
): string[] {
	return Object.keys(environment)
		.filter((key) => {
			const normalizedKey = key.toUpperCase();
			return UNSAFE_PUBLICATION_GIT_ENVIRONMENT.has(normalizedKey) || /^GIT_CONFIG_(?:KEY|VALUE)_/.test(normalizedKey);
		})
		.toSorted();
}
