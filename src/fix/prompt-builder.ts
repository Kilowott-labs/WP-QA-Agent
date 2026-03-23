import fs from 'fs/promises';
import path from 'path';
import { FixableIssue, Layer1Results } from '../types.js';
import { readJson } from '../utils.js';

export interface FixPromptOptions {
  issueIds?: string[];        // Specific issue IDs to fix (e.g. FIX-001, FIX-003)
  categories?: string[];      // Fix all issues in these categories
  severities?: string[];      // Fix all issues at these severity levels
  fixTypes?: string[];        // Only issues of these fix types (code, config, server, plugin, content)
  maxIssues?: number;         // Cap to avoid overwhelming context
}

/**
 * Build a focused, token-efficient prompt for Claude Code to fix specific issues.
 *
 * This is NOT a report — it's an instruction set. It includes:
 * - Only the selected issues (no passing checks, no tables, no icons)
 * - Relevant code file contents (if project_path available)
 * - Specific, actionable fix instructions
 */
export async function buildFixPrompt(
  reportDir: string,
  options: FixPromptOptions = {}
): Promise<{ prompt: string; selectedIssues: FixableIssue[]; skippedCount: number }> {
  const issuesPath = path.join(reportDir, 'fixable-issues.json');
  const l1Path = path.join(reportDir, 'layer1-results.json');

  const allIssues = await readJson<FixableIssue[]>(issuesPath);
  const l1 = await readJson<Layer1Results>(l1Path);

  // Filter issues based on options
  let selected = filterIssues(allIssues, options);
  const maxIssues = options.maxIssues || 20;
  const skippedCount = Math.max(0, selected.length - maxIssues);
  selected = selected.slice(0, maxIssues);

  if (selected.length === 0) {
    return { prompt: 'No issues match the selected filters.', selectedIssues: [], skippedCount: 0 };
  }

  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  // ── Header — minimal, action-oriented ──────────────────────────────────
  w('# Fix These Issues');
  w('');
  w(`Site: ${l1.site.url}`);
  if (l1.site.project_path) {
    w(`Project: ${l1.site.project_path}`);
  }
  w(`Issues to fix: ${selected.length}${skippedCount > 0 ? ` (${skippedCount} more available)` : ''}`);
  w('');

  // ── Group by fix type for clarity ──────────────────────────────────────
  const byType = new Map<string, FixableIssue[]>();
  for (const issue of selected) {
    if (!byType.has(issue.fix_type)) byType.set(issue.fix_type, []);
    byType.get(issue.fix_type)!.push(issue);
  }

  const typeLabels: Record<string, string> = {
    code: 'Code Changes (edit files directly)',
    config: 'Configuration Changes (wp-config.php / settings)',
    server: 'Server Configuration (hosting / .htaccess)',
    plugin: 'Plugin Actions (install / update / configure)',
    content: 'Content Changes (WP admin editor)',
  };

  for (const [fixType, issues] of byType) {
    w(`## ${typeLabels[fixType] || fixType}`);
    w('');

    for (const issue of issues) {
      w(`### ${issue.id}: ${issue.title}`);
      w(`**Severity:** ${issue.severity} | **Category:** ${issue.category}`);
      w(`**Location:** ${issue.location}`);
      w(`**Problem:** ${issue.problem}`);
      w(`**Fix:** ${issue.fix}`);
      if (issue.code_files && issue.code_files.length > 0) {
        w(`**Files:** ${issue.code_files.join(', ')}`);
      }
      w('');
    }
  }

  // ── Code context for code-type fixes ───────────────────────────────────
  if (l1.site.project_path && byType.has('code')) {
    const codeIssues = byType.get('code')!;
    const uniqueFiles = [...new Set(codeIssues.flatMap((i) => i.code_files || []))];

    if (uniqueFiles.length > 0) {
      w('## Relevant Code Context');
      w('');
      w('Read these files to understand the code before making changes:');
      for (const file of uniqueFiles.slice(0, 10)) {
        const fullPath = path.join(l1.site.project_path, file);
        w(`- \`${fullPath}\``);
      }
      w('');
    }
  }

  // ── Instructions ───────────────────────────────────────────────────────
  w('---');
  w('');
  w('## Instructions');
  w('');
  w('For each issue above:');
  w('1. Read the relevant file(s) if it\'s a code fix');
  w('2. Make the fix described');
  w('3. Verify the fix doesn\'t break other functionality');
  w('');
  w('Do NOT:');
  w('- Add unnecessary comments or documentation');
  w('- Refactor surrounding code');
  w('- Make changes beyond what\'s needed for the fix');

  return {
    prompt: lines.join('\n'),
    selectedIssues: selected,
    skippedCount,
  };
}

function filterIssues(issues: FixableIssue[], options: FixPromptOptions): FixableIssue[] {
  let result = issues;

  if (options.issueIds && options.issueIds.length > 0) {
    const ids = new Set(options.issueIds.map((id) => id.toUpperCase()));
    result = result.filter((i) => ids.has(i.id.toUpperCase()));
  }

  if (options.categories && options.categories.length > 0) {
    const cats = new Set(options.categories.map((c) => c.toLowerCase()));
    result = result.filter((i) => cats.has(i.category));
  }

  if (options.severities && options.severities.length > 0) {
    const sevs = new Set(options.severities.map((s) => s.toLowerCase()));
    result = result.filter((i) => sevs.has(i.severity));
  }

  if (options.fixTypes && options.fixTypes.length > 0) {
    const types = new Set(options.fixTypes.map((t) => t.toLowerCase()));
    result = result.filter((i) => types.has(i.fix_type));
  }

  // Sort: blockers first, then major, then minor
  const sevOrder = { blocker: 0, major: 1, minor: 2 };
  result.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  return result;
}
