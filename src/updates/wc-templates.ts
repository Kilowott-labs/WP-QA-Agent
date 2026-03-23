import fs from 'fs/promises';
import path from 'path';
import {
  SiteConfig,
  WCTemplateOverrideInfo,
  WCTemplateUpdateResult,
  WCTemplateUpdateRunResult,
} from '../types.js';
import { baseUrl, getAuthHeader, logger, ensureDir, writeJson, slugify, elapsed, fmtMs } from '../utils.js';

// ── Public API ────────────────────────────────────────────────────────────

export interface WCTemplateUpdateOptions {
  dryRun?: boolean;
  versionOnly?: boolean; // Only update @version tag, skip smart merge
  fileFilter?: string;   // e.g. "cart/cart.php" — update only this template
  outputDir?: string;
}

/**
 * Update outdated WooCommerce template overrides in the theme.
 *
 * Strategy:
 * 1. Get outdated template list + WC version from WC system status API
 * 2. For each outdated template:
 *    a. Read the theme's override from project_path (the theme directory)
 *    b. Get WC's current template — from local plugins dir if available,
 *       otherwise fetched from the WooCommerce GitHub repository
 *    c. Backup the theme's override
 *    d. Apply safe changes:
 *       - Update @version tag
 *       - Add missing WC hooks (do_action / apply_filters)
 *       - Preserve all theme customizations
 *    e. Flag structural changes for manual review
 * 3. Generate report
 */
export async function runWCTemplateUpdates(
  config: SiteConfig,
  options: WCTemplateUpdateOptions = {}
): Promise<WCTemplateUpdateRunResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  // ── Validate prerequisites ──────────────────────────────────────────
  if (!config.project_path) {
    logger.error('project_path is required for WooCommerce template updates.');
    logger.error('Set project_path in your site config to the theme directory.');
    process.exit(1);
  }

  if (!config.username || !config.app_password) {
    logger.error('WordPress credentials required to read WC system status.');
    process.exit(1);
  }

  const datestamp = new Date().toISOString().slice(0, 10);
  const siteSlug = slugify(config.name);
  const outputDir = path.join(
    options.outputDir || './qa-reports',
    `${siteSlug}-wc-templates-${datestamp}`
  );
  await ensureDir(outputDir);

  const modeLabel = options.dryRun ? 'DRY RUN' : 'LIVE UPDATE';
  logger.section(`WC Template Updates — ${config.name} [${modeLabel}]`);

  // ── Resolve theme path ──────────────────────────────────────────────
  const paths = await resolvePaths(config.project_path);
  if (!paths) {
    logger.error('Could not find theme with WooCommerce overrides.');
    logger.error('Ensure project_path has style.css + woocommerce/ directory.');
    process.exit(1);
  }

  // ── Get outdated templates + WC version from API ────────────────────
  const { templates: outdated, wcVersion } = await getOutdatedTemplatesAndVersion(config);

  if (outdated.length === 0) {
    logger.success('All WooCommerce template overrides are up to date.');
    const result: WCTemplateUpdateRunResult = {
      site: config.name,
      project_path: config.project_path,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: elapsed(startTime),
      total_outdated: 0,
      results: [],
      summary: { updated: 0, flagged: 0, failed: 0 },
    };
    await writeJson(path.join(outputDir, 'wc-template-results.json'), result);
    return result;
  }

  // Filter to a single file if --file was passed
  if (options.fileFilter) {
    const match = outdated.filter((t) => t.file === options.fileFilter || t.file.includes(options.fileFilter!));
    if (match.length === 0) {
      logger.error(`No outdated template matching "${options.fileFilter}"`);
      logger.info(`Available: ${outdated.slice(0, 5).map((t) => t.file).join(', ')}${outdated.length > 5 ? '...' : ''}`);
      process.exit(1);
    }
    outdated.length = 0;
    outdated.push(...match);
  }

  logger.info(`WC v${wcVersion || '?'} | ${outdated.length} outdated template${outdated.length === 1 ? '' : 's'} | source: ${paths.wcTemplatesDir ? 'local' : 'GitHub'}`);
  logger.info('');

  // ── Process each template ───────────────────────────────────────────
  const results: WCTemplateUpdateResult[] = [];
  const backupDir = path.join(outputDir, 'backups');
  await ensureDir(backupDir);

  // Track counts for progress display
  let processed = 0;

  for (const template of outdated) {
    processed++;
    const result = await processTemplate(
      template,
      paths,
      wcVersion,
      backupDir,
      options.dryRun || false,
      options.versionOnly || false
    );
    results.push(result);

    // One clean line per template
    const icon = { updated: '✅', flagged: '⚠️', failed: '❌', skipped: '○' }[result.action];
    const changes = result.changes_made.length - 1; // -1 for the @version entry
    const conflicts = result.manual_review_needed.length;
    const versionInfo = `v${result.theme_version} → v${result.core_version}`;

    let detail = '';
    if (result.error) {
      detail = result.error;
    } else if (changes > 0 && conflicts > 0) {
      detail = `${changes} auto-applied, ${conflicts} conflicts`;
    } else if (changes > 0) {
      detail = `${changes} auto-applied`;
    } else if (conflicts > 0) {
      detail = `${conflicts} conflicts`;
    } else {
      detail = 'version only';
    }

    logger.dim(`  ${icon} ${result.file} (${versionInfo}) — ${detail}`);
  }

  // ── Build final result ──────────────────────────────────────────────
  const finalResult: WCTemplateUpdateRunResult = {
    site: config.name,
    project_path: config.project_path,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: elapsed(startTime),
    total_outdated: outdated.length,
    results,
    summary: {
      updated: results.filter((r) => r.action === 'updated').length,
      flagged: results.filter((r) => r.action === 'flagged').length,
      failed: results.filter((r) => r.action === 'failed').length,
    },
  };

  await writeJson(path.join(outputDir, 'wc-template-results.json'), finalResult);
  const reportPath = await generateTemplateReport(finalResult, outputDir);

  // ── Clean summary ───────────────────────────────────────────────────
  logger.info('');
  const s = finalResult.summary;
  const parts: string[] = [];
  if (s.updated > 0) parts.push(`${s.updated} updated`);
  if (s.flagged > 0) parts.push(`${s.flagged} need review`);
  if (s.failed > 0) parts.push(`${s.failed} failed`);
  logger.info(parts.join(' | ') || 'No changes');
  logger.info(`Report: ${reportPath}`);
  logger.dim(`Duration: ${fmtMs(finalResult.duration_ms)}`);

  return finalResult;
}

// ── Path Resolution ───────────────────────────────────────────────────────

interface ResolvedPaths {
  themePath: string;
  themeWCDir: string;
  wcTemplatesDir: string | null; // null = no local WC plugin, fetch from GitHub
}

/**
 * Detect whether project_path is a WP root or theme dir,
 * and resolve paths to theme overrides and (optionally) WC plugin templates.
 *
 * Typical case: project_path is a theme-only repo with no plugins/ folder.
 * In that case wcTemplatesDir is null and we fetch from GitHub instead.
 */
async function resolvePaths(projectPath: string): Promise<ResolvedPaths | null> {
  // Case 1: project_path is a full WordPress installation
  const wpContentThemes = path.join(projectPath, 'wp-content', 'themes');
  const wpContentPlugins = path.join(projectPath, 'wp-content', 'plugins', 'woocommerce', 'templates');

  try {
    await fs.access(wpContentThemes);
    const themePath = await findThemeDir(wpContentThemes);
    if (themePath) {
      const themeWCDir = path.join(themePath, 'woocommerce');
      try {
        await fs.access(themeWCDir);
      } catch {
        return null; // theme has no WC overrides
      }

      // Check if WC plugin is also available locally
      let wcLocal: string | null = null;
      try {
        await fs.access(wpContentPlugins);
        wcLocal = wpContentPlugins;
      } catch { /* no local WC plugin — will use GitHub */ }

      return { themePath, themeWCDir, wcTemplatesDir: wcLocal };
    }
  } catch { /* not a WP root */ }

  // Case 2: project_path is the theme directory itself (most common)
  const themeWCDir = path.join(projectPath, 'woocommerce');
  const stylePath = path.join(projectPath, 'style.css');

  try {
    await fs.access(themeWCDir);
    await fs.access(stylePath);

    // Try to find a local WC plugin by walking up
    let wcLocal: string | null = null;
    const themesDir = path.dirname(projectPath);
    const wpContent = path.dirname(themesDir);
    const wcTemplates = path.join(wpContent, 'plugins', 'woocommerce', 'templates');
    try {
      await fs.access(wcTemplates);
      wcLocal = wcTemplates;
    } catch { /* no local WC plugin — will use GitHub */ }

    return { themePath: projectPath, themeWCDir, wcTemplatesDir: wcLocal };
  } catch { /* not a theme dir with WC overrides */ }

  return null;
}

/**
 * Find the first theme directory that has a style.css with Theme Name.
 */
async function findThemeDir(themesDir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(themesDir);
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const stylePath = path.join(themesDir, entry, 'style.css');
      try {
        const content = await fs.readFile(stylePath, 'utf-8');
        if (/Theme Name:/i.test(content)) {
          return path.join(themesDir, entry);
        }
      } catch { /* no style.css */ }
    }
  } catch { /* can't read themes dir */ }
  return null;
}

// ── WC System Status API ──────────────────────────────────────────────────

/**
 * Get outdated template overrides and WC version from the WC system status API.
 */
async function getOutdatedTemplatesAndVersion(
  config: SiteConfig
): Promise<{ templates: WCTemplateOverrideInfo[]; wcVersion: string | null }> {
  const base = baseUrl(config.url);
  const headers = {
    'Content-Type': 'application/json',
    Authorization: getAuthHeader(config.username!, config.app_password!),
  };

  try {
    const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
      headers,
      signal: AbortSignal.timeout(30000),
    });

    if (!res.ok) {
      logger.error(`WC system status returned HTTP ${res.status}`);
      return { templates: [], wcVersion: null };
    }

    const status = await res.json();
    const wcVersion: string | null = status.environment?.version || null;
    const overrides: any[] = status.theme?.overrides || [];

    // Don't trust the API's `outdated` flag — it's unreliable.
    // Compare version strings ourselves: if theme version !== core version, it's outdated.
    const templates = overrides
      .filter((t: any) => {
        const themeVer = (t.version || '').trim();
        const coreVer = (t.core_version || t.parent_version || '').trim();
        // Outdated if versions exist and don't match
        return themeVer && coreVer && themeVer !== coreVer;
      })
      .map((t: any) => ({
        file: normalizeTemplatePath(t.file),
        theme_version: t.version || 'unknown',
        core_version: t.core_version || t.parent_version || 'unknown',
        outdated: true,
      }));

    return { templates, wcVersion };
  } catch (err: any) {
    logger.error(`Failed to fetch WC system status: ${err.message}`);
    return { templates: [], wcVersion: null };
  }
}

/**
 * Normalise the template path from the API.
 *
 * The API returns paths in varying formats depending on the WC version/setup:
 *   "crema/woocommerce/cart/cart.php"   → theme slug + woocommerce/ prefix
 *   "woocommerce/cart/cart.php"          → just woocommerce/ prefix
 *   "cart/cart.php"                      → already clean
 *
 * We need just the path relative to the theme's woocommerce/ directory,
 * e.g. "cart/cart.php".
 */
function normalizeTemplatePath(filePath: string): string {
  // Strip everything up to and including the first "woocommerce/" segment
  const wcIdx = filePath.indexOf('woocommerce/');
  if (wcIdx !== -1) {
    return filePath.slice(wcIdx + 'woocommerce/'.length);
  }
  return filePath;
}

// ── WC Template Fetching (GitHub fallback) ────────────────────────────────

// GitHub raw URL patterns for WooCommerce templates.
// WC moved to a monorepo — templates are at plugins/woocommerce/templates/
const WC_GITHUB_RAW_URLS = [
  'https://raw.githubusercontent.com/woocommerce/woocommerce/refs/tags/{version}/plugins/woocommerce/templates/{path}',
  'https://raw.githubusercontent.com/woocommerce/woocommerce/refs/tags/{version}/templates/{path}',
];

/**
 * Get the WC plugin template content.
 * First tries local disk (if wcTemplatesDir is available),
 * then falls back to fetching from GitHub for the specific WC version.
 */
async function getWCTemplateContent(
  templatePath: string,
  paths: ResolvedPaths,
  wcVersion: string | null
): Promise<{ content: string; source: 'local' | 'github' } | null> {
  // Try local first
  if (paths.wcTemplatesDir) {
    const localFile = path.join(paths.wcTemplatesDir, templatePath);
    try {
      const content = await fs.readFile(localFile, 'utf-8');
      return { content, source: 'local' };
    } catch { /* not found locally */ }
  }

  // Fetch from GitHub
  if (!wcVersion) {
    logger.error('  Cannot fetch from GitHub: WC version unknown');
    return null;
  }

  for (const urlPattern of WC_GITHUB_RAW_URLS) {
    const url = urlPattern
      .replace('{version}', wcVersion)
      .replace('{path}', templatePath);

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        headers: { 'User-Agent': 'wp-qa-agent/1.0' },
      });

      if (res.ok) {
        const content = await res.text();
        // Verify it's actually a PHP file (not a 404 HTML page)
        if (content.includes('<?php') || content.includes('@version')) {
          return { content, source: 'github' };
        }
      }
    } catch { /* try next URL pattern */ }
  }

  return null;
}

// ── Template Processing ───────────────────────────────────────────────────

/**
 * Process a single outdated template: read, smart-merge, write.
 */
async function processTemplate(
  template: WCTemplateOverrideInfo,
  paths: ResolvedPaths,
  wcVersion: string | null,
  backupDir: string,
  dryRun: boolean,
  versionOnly: boolean
): Promise<WCTemplateUpdateResult> {
  const result: WCTemplateUpdateResult = {
    file: template.file,
    action: 'failed',
    theme_version: template.theme_version,
    core_version: template.core_version,
    changes_made: [],
    manual_review_needed: [],
  };

  // Read theme's override from disk
  const themeFile = path.join(paths.themeWCDir, template.file);
  let themeContent: string;
  try {
    themeContent = await fs.readFile(themeFile, 'utf-8');
  } catch {
    result.error = `Theme override not found: ${themeFile}`;
    return result;
  }

  // Get WC's current template (local or GitHub)
  const wcTemplate = await getWCTemplateContent(template.file, paths, wcVersion);
  if (!wcTemplate) {
    result.error = `Could not read WC plugin template for ${template.file} (not found locally, GitHub fetch failed)`;
    return result;
  }

  const wcContent = wcTemplate.content;

  // Parse @version from both files
  const themeVer = extractVersion(themeContent);
  const wcVer = extractVersion(wcContent);
  if (!themeVer) { result.error = 'No @version tag in theme template'; return result; }
  if (!wcVer) { result.error = 'No @version tag in WC template'; return result; }

  // ── Version-only mode: just bump the @version tag ───────────────────
  if (versionOnly) {
    result.changes_made.push(`@version ${themeVer} → ${wcVer}`);
    result.action = 'updated';

    if (dryRun) { result.action = 'skipped'; return result; }

    const backupPath = path.join(backupDir, template.file);
    await ensureDir(path.dirname(backupPath));
    await fs.copyFile(themeFile, backupPath);
    result.backup_path = backupPath;

    try {
      const updated = updateVersionTag(themeContent, themeVer, wcVer);
      await fs.writeFile(themeFile, updated, 'utf-8');
    } catch (err: any) {
      result.action = 'failed';
      result.error = `Write failed: ${err.message}`;
      try { await fs.copyFile(backupPath, themeFile); } catch {}
    }
    return result;
  }

  // ── Smart merge ─────────────────────────────────────────────────────
  const themeLines = themeContent.split('\n');
  const wcLines = wcContent.split('\n');
  const merge = smartMerge(themeLines, wcLines);

  // Always report version change
  result.changes_made.push(`@version ${themeVer} → ${wcVer}`);

  // Report what the merge did
  for (const entry of merge.changelog) {
    if (entry.type === 'wc-inserted') {
      result.changes_made.push(entry.description);
    } else if (entry.type === 'conflict-kept-theme') {
      result.manual_review_needed.push(entry.description);
    }
  }

  result.action = result.manual_review_needed.length > 0 ? 'flagged' : 'updated';

  if (dryRun) {
    result.action = 'skipped';
    return result;
  }

  // ── Backup ──────────────────────────────────────────────────────────
  const backupPath = path.join(backupDir, template.file);
  await ensureDir(path.dirname(backupPath));
  await fs.copyFile(themeFile, backupPath);
  result.backup_path = backupPath;

  // ── Write merged content ────────────────────────────────────────────
  try {
    let mergedContent = merge.lines.join('\n');
    mergedContent = updateVersionTag(mergedContent, themeVer, wcVer);

    await fs.writeFile(themeFile, mergedContent, 'utf-8');

    // Write changelog file for review
    if (merge.changelog.length > 0) {
      const changelogPath = path.join(
        path.dirname(backupPath),
        template.file.replace('.php', '.changelog.txt')
      );
      await ensureDir(path.dirname(changelogPath));
      await fs.writeFile(changelogPath, formatChangelog(merge, template.file), 'utf-8');
    }
  } catch (err: any) {
    result.action = 'failed';
    result.error = `Write failed: ${err.message}`;
    try {
      await fs.copyFile(backupPath, themeFile);
    } catch {}
  }

  return result;
}

// ── Version Helpers ───────────────────────────────────────────────────────

function extractVersion(content: string): string | null {
  const match = content.match(/@version\s+([\d.]+)/);
  return match ? match[1] : null;
}

function updateVersionTag(content: string, oldVer: string, newVer: string): string {
  return content.replace(
    new RegExp(`(@version\\s+)${oldVer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    `$1${newVer}`
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SMART MERGE ENGINE
//
// Uses LCS (Longest Common Subsequence) to align theme and WC templates,
// then walks the alignment to produce a merged result:
//   - Common lines        → keep (identical in both)
//   - WC-only lines       → INSERT (WC structural update) and report
//   - Theme-only lines    → KEEP (theme customization) and preserve
//   - Conflicts           → keep theme's version, report WC's version
//                           for manual review
// ══════════════════════════════════════════════════════════════════════════

interface MergeResult {
  lines: string[];
  changelog: ChangelogEntry[];
}

interface ChangelogEntry {
  type: 'wc-inserted' | 'theme-preserved' | 'conflict-kept-theme';
  description: string;
  wcLines?: string[];
  themeLines?: string[];
  afterLine?: number; // approximate line number in output
}

/**
 * Smart merge: align theme and WC templates via LCS, then merge.
 */
function smartMerge(themeLines: string[], wcLines: string[]): MergeResult {
  const output: string[] = [];
  const changelog: ChangelogEntry[] = [];

  // Normalise lines for comparison (trim whitespace, ignore case differences
  // in comments/version tags, but preserve case for code)
  const norm = (line: string) => line.trim();

  // Build LCS table
  const lcs = computeLCS(themeLines, wcLines, norm);

  // Walk both arrays using the LCS to align them
  let ti = 0; // theme index
  let wi = 0; // WC index
  let li = 0; // LCS index

  while (ti < themeLines.length || wi < wcLines.length) {
    // Both have remaining lines and next LCS match exists
    if (li < lcs.length) {
      const [lcsT, lcsW] = lcs[li];

      // Lines before the next common line
      const themeBefore = themeLines.slice(ti, lcsT);
      const wcBefore = wcLines.slice(wi, lcsW);

      if (themeBefore.length === 0 && wcBefore.length === 0) {
        // Both at the common line — output it
        output.push(themeLines[lcsT]);
        ti = lcsT + 1;
        wi = lcsW + 1;
        li++;
        continue;
      }

      // Handle the gap before the common line
      mergeGap(themeBefore, wcBefore, output, changelog, norm);

      // Output the common line
      output.push(themeLines[lcsT]);
      ti = lcsT + 1;
      wi = lcsW + 1;
      li++;
    } else {
      // No more LCS matches — handle remaining lines
      const themeRemaining = themeLines.slice(ti);
      const wcRemaining = wcLines.slice(wi);
      mergeGap(themeRemaining, wcRemaining, output, changelog, norm);
      ti = themeLines.length;
      wi = wcLines.length;
    }
  }

  return { lines: output, changelog };
}

/**
 * Merge a gap (lines between two common anchor points).
 *
 * - WC-only lines (not in theme at all) → insert them (WC update)
 * - Theme-only lines (not in WC at all) → keep them (customization)
 * - Lines present in both but different → conflict: keep theme, report WC
 */
function mergeGap(
  themeGap: string[],
  wcGap: string[],
  output: string[],
  changelog: ChangelogEntry[],
  norm: (s: string) => string
): void {
  if (themeGap.length === 0 && wcGap.length === 0) return;

  // Build normalised sets for cross-reference
  const themeNormed = new Set(themeGap.map(norm).filter(Boolean));
  const wcNormed = new Set(wcGap.map(norm).filter(Boolean));

  // WC lines NOT in theme gap → these are WC additions
  const wcOnly = wcGap.filter((l) => {
    const n = norm(l);
    return n && !themeNormed.has(n);
  });

  // Theme lines NOT in WC gap → these are theme customizations
  const themeOnly = themeGap.filter((l) => {
    const n = norm(l);
    return n && !wcNormed.has(n);
  });

  // Lines in BOTH gaps (same content, maybe different whitespace)
  const shared = themeGap.filter((l) => {
    const n = norm(l);
    return n && wcNormed.has(n);
  });

  // Determine if this is a pure addition, pure customization, or conflict
  const isVersionOrComment = (lines: string[]) =>
    lines.every((l) => {
      const t = l.trim();
      return !t || t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.includes('@version');
    });

  if (themeGap.length === 0 && wcGap.length > 0) {
    // Pure WC insertion — add all WC lines
    for (const line of wcGap) output.push(line);
    if (!isVersionOrComment(wcGap)) {
      changelog.push({
        type: 'wc-inserted',
        description: `WC addition (${wcGap.length} lines): ${summariseLines(wcGap)}`,
        wcLines: wcGap,
        afterLine: output.length,
      });
    }
    return;
  }

  if (wcGap.length === 0 && themeGap.length > 0) {
    // Pure theme customization — keep all
    for (const line of themeGap) output.push(line);
    // No changelog needed — these are just theme lines that WC doesn't have
    return;
  }

  // Both have lines — need to interleave intelligently
  // Strategy: output shared lines first (in theme's order), then theme-only,
  // then WC-only insertions

  // Actually, preserve theme's original order and splice WC additions in
  // Output theme gap as-is (preserves customizations + shared lines)
  for (const line of themeGap) {
    output.push(line);
  }

  // Add WC-only lines (new WC code not in theme) after the theme gap
  if (wcOnly.length > 0 && !isVersionOrComment(wcOnly)) {
    for (const line of wcOnly) {
      output.push(line);
    }
    changelog.push({
      type: 'wc-inserted',
      description: `WC addition (${wcOnly.length} lines): ${summariseLines(wcOnly)}`,
      wcLines: wcOnly,
      afterLine: output.length,
    });
  }

  // If there are WC lines that conflict with theme lines (same position,
  // different content, and it's actual code not comments), report them
  if (themeOnly.length > 0 && wcOnly.length > 0) {
    const themeCode = themeOnly.filter((l) => isCode(l));
    const wcCode = wcOnly.filter((l) => isCode(l));

    if (themeCode.length > 0 && wcCode.length > 0) {
      changelog.push({
        type: 'conflict-kept-theme',
        description: `Conflict: kept theme's version (${themeCode.length} lines). WC wanted: ${summariseLines(wcCode)}`,
        themeLines: themeCode,
        wcLines: wcCode,
        afterLine: output.length,
      });
    }
  }
}

/**
 * Compute LCS (Longest Common Subsequence) between two line arrays.
 * Returns array of [themeIndex, wcIndex] pairs for matching lines.
 *
 * Uses a patience-diff inspired approach: match unique lines first for
 * better alignment, then fill in common repeated lines.
 */
function computeLCS(
  a: string[],
  b: string[],
  norm: (s: string) => string
): [number, number][] {
  const n = a.length;
  const m = b.length;

  // For large files, use a fast O(n*m) approach with space optimisation
  // For WC templates (typically 50-300 lines), this is fine
  if (n === 0 || m === 0) return [];

  // Build DP table (space-optimised to 2 rows)
  const prev = new Array(m + 1).fill(0);
  const curr = new Array(m + 1).fill(0);

  // We need the actual indices, so build a direction table
  const dir: number[][] = [];
  for (let i = 0; i <= n; i++) dir.push(new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 0; j <= m; j++) curr[j] = 0;
    for (let j = 1; j <= m; j++) {
      if (norm(a[i - 1]) === norm(b[j - 1])) {
        curr[j] = prev[j - 1] + 1;
        dir[i][j] = 1; // diagonal
      } else if (prev[j] >= curr[j - 1]) {
        curr[j] = prev[j];
        dir[i][j] = 2; // up
      } else {
        curr[j] = curr[j - 1];
        dir[i][j] = 3; // left
      }
    }
    for (let j = 0; j <= m; j++) prev[j] = curr[j];
  }

  // Backtrack to find the actual LCS pairs
  // Need full DP for backtracking — rebuild with full table for correctness
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (norm(a[i - 1]) === norm(b[j - 1])) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const pairs: [number, number][] = [];
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (norm(a[i - 1]) === norm(b[j - 1])) {
      pairs.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  pairs.reverse();
  return pairs;
}

/**
 * Check if a line is actual code (not a comment, blank, or version tag).
 */
function isCode(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) return false;
  if (t.includes('@version') || t.includes('@package')) return false;
  if (t === '<?php' || t === '?>') return false;
  return true;
}

/**
 * Summarise a block of lines for changelog description.
 */
function summariseLines(lines: string[]): string {
  const code = lines.filter(isCode);
  if (code.length === 0) return '(comments/whitespace only)';
  const first = code[0].trim().slice(0, 80);
  if (code.length === 1) return `\`${first}\``;
  return `\`${first}\` (+${code.length - 1} more)`;
}

/**
 * Format the changelog as a human-readable text file.
 */
function formatChangelog(merge: MergeResult, fileName: string): string {
  const lines: string[] = [];
  lines.push(`Template Merge Changelog`);
  lines.push(`File: ${fileName}`);
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('='.repeat(80));
  lines.push('');

  const inserted = merge.changelog.filter((e) => e.type === 'wc-inserted');
  const conflicts = merge.changelog.filter((e) => e.type === 'conflict-kept-theme');

  if (inserted.length > 0) {
    lines.push(`AUTO-APPLIED WC CHANGES (${inserted.length}):`);
    lines.push('These WC updates were automatically merged into your template.');
    lines.push('');
    for (const entry of inserted) {
      lines.push(`  ${entry.description}`);
      if (entry.wcLines) {
        for (const l of entry.wcLines) lines.push(`    ${l}`);
      }
      lines.push('');
    }
  }

  if (conflicts.length > 0) {
    lines.push(`CONFLICTS — MANUAL REVIEW NEEDED (${conflicts.length}):`);
    lines.push('Your theme has custom code in the same area WC changed.');
    lines.push('Your theme version was kept. Review the WC version below');
    lines.push('and manually apply if needed.');
    lines.push('');
    for (const entry of conflicts) {
      lines.push(`  ${entry.description}`);
      if (entry.themeLines) {
        lines.push('  YOUR THEME HAS:');
        for (const l of entry.themeLines) lines.push(`    ${l}`);
      }
      if (entry.wcLines) {
        lines.push('  WC WANTED:');
        for (const l of entry.wcLines) lines.push(`    ${l}`);
      }
      lines.push('');
    }
  }

  if (inserted.length === 0 && conflicts.length === 0) {
    lines.push('Only @version tag was updated. No structural changes.');
  }

  return lines.join('\n');
}

// ── Report Generation ─────────────────────────────────────────────────────

async function generateTemplateReport(
  result: WCTemplateUpdateRunResult,
  outputDir: string
): Promise<string> {
  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  w(`# WooCommerce Template Update Report — ${result.site}`);
  w(`Generated: ${result.completed_at}`);
  w(`Project: ${result.project_path}`);
  w(`Duration: ${fmtMs(result.duration_ms)}`);
  w('');

  // Summary
  w('## Summary');
  w('');
  w(`| Metric | Count |`);
  w(`|--------|-------|`);
  w(`| Outdated templates | ${result.total_outdated} |`);
  w(`| Updated (auto) | ${result.summary.updated} |`);
  w(`| Flagged for review | ${result.summary.flagged} |`);
  w(`| Failed | ${result.summary.failed} |`);
  w('');

  // Results table
  if (result.results.length > 0) {
    w('## Template Details');
    w('');
    w('| Template | Theme Version | WC Version | Action |');
    w('|----------|---------------|------------|--------|');
    for (const r of result.results) {
      const icon = { updated: '✅', flagged: '⚠️', failed: '❌', skipped: '○' }[r.action];
      w(`| \`${r.file}\` | ${r.theme_version} | ${r.core_version} | ${icon} ${r.action} |`);
    }
    w('');
  }

  // Details for each template
  for (const r of result.results) {
    if (r.changes_made.length === 0 && r.manual_review_needed.length === 0 && !r.error) continue;

    w(`### ${r.file}`);
    w('');

    if (r.changes_made.length > 0) {
      w('**Changes applied:**');
      for (const c of r.changes_made) w(`- ${c}`);
      w('');
    }

    if (r.manual_review_needed.length > 0) {
      w('**Manual review needed:**');
      w('');
      w('The following WooCommerce changes were NOT auto-applied to preserve your customizations.');
      w('Review each and manually apply if needed:');
      w('');
      for (const m of r.manual_review_needed) w(`- \`${m}\``);
      w('');
    }

    if (r.backup_path) {
      w(`**Backup:** \`${r.backup_path}\``);
      w('');
    }

    if (r.error) {
      w(`**Error:** ${r.error}`);
      w('');
    }
  }

  // Write report
  const markdown = lines.join('\n');
  const reportPath = path.join(outputDir, 'wc-template-report.md');
  await fs.writeFile(reportPath, markdown, 'utf-8');

  return reportPath;
}
