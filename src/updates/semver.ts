/**
 * Parse a WordPress plugin version string into components.
 * Handles: "3.1.2", "3.1", "3", "3.1.2-beta", "3.1.2.1"
 */
export function parseVersion(version: string): { major: number; minor: number; patch: number } {
  // Strip pre-release suffixes
  const clean = version.replace(/[-+].*$/, '');
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0);
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
  };
}

/**
 * Classify the type of update between two version strings.
 * Returns 'major', 'minor', or 'patch'.
 */
export function classifyUpdate(
  currentVersion: string,
  newVersion: string
): 'major' | 'minor' | 'patch' {
  const current = parseVersion(currentVersion);
  const next = parseVersion(newVersion);

  if (next.major !== current.major) return 'major';
  if (next.minor !== current.minor) return 'minor';
  return 'patch';
}

/**
 * Check if a version is newer than another.
 */
export function isNewer(currentVersion: string, newVersion: string): boolean {
  const current = parseVersion(currentVersion);
  const next = parseVersion(newVersion);

  if (next.major !== current.major) return next.major > current.major;
  if (next.minor !== current.minor) return next.minor > current.minor;
  return next.patch > current.patch;
}
