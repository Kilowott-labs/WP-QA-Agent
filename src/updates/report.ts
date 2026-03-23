import fs from 'fs/promises';
import path from 'path';
import { UpdateRunResult } from '../types.js';
import { fmtMs } from '../utils.js';
import { markdownToPdf } from '../pdf.js';

/**
 * Generate a Markdown report for plugin update results.
 */
export async function generateUpdateReport(
  result: UpdateRunResult,
  outputDir: string
): Promise<string> {
  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  w(`# Plugin Update Report — ${result.site}`);
  w(`Generated: ${result.completed_at}`);
  w(`URL: ${result.url}`);
  w(`Duration: ${fmtMs(result.duration_ms)}`);
  w('');

  // ── Summary ──────────────────────────────────────────────────────────
  w('## Summary');
  w('');
  w(`| Metric | Count |`);
  w(`|--------|-------|`);
  w(`| Plugins with updates | ${result.total_plugins_with_updates} |`);
  w(`| Successfully updated | ${result.summary.updated} |`);
  w(`| Skipped (major version) | ${result.summary.skipped_major} |`);
  w(`| Failed | ${result.summary.failed} |`);
  w(`| Deactivated (regression) | ${result.summary.deactivated} |`);
  w('');

  if (result.halted_early) {
    w('> **UPDATE HALTED:** ' + result.halt_reason);
    w('');
  }

  // ── Successfully Updated ─────────────────────────────────────────────
  const updated = result.results.filter((r) => r.action === 'updated');
  if (updated.length > 0) {
    w('## Successfully Updated');
    w('');
    w('| Plugin | Old Version | New Version | Type | Regressions | Duration |');
    w('|--------|-------------|-------------|------|-------------|----------|');
    for (const r of updated) {
      const regCount = r.regressions.length;
      const regIcon = regCount === 0 ? '✅ None' : `⚠️ ${regCount}`;
      w(`| ${r.plugin.name} | ${r.old_version} | ${r.verified_version || r.new_version} | ${r.update_type} | ${regIcon} | ${fmtMs(r.duration_ms)} |`);
    }
    w('');

    // Detail regressions for updated plugins that had warnings/majors
    const withRegressions = updated.filter((r) => r.regressions.length > 0);
    if (withRegressions.length > 0) {
      w('### Regressions on Updated Plugins');
      w('');
      for (const r of withRegressions) {
        w(`**${r.plugin.name}** (${r.old_version} → ${r.verified_version || r.new_version}):`);
        for (const reg of r.regressions) {
          const icon = { blocker: '🚨', major: '⚠️', warning: '💡' }[reg.type];
          w(`- ${icon} [${reg.type}] ${reg.detail}`);
        }
        w('');
      }
    }
  }

  // ── Deactivated ──────────────────────────────────────────────────────
  const deactivated = result.results.filter((r) => r.action === 'deactivated');
  if (deactivated.length > 0) {
    w('## Deactivated Plugins (Blocker Regression)');
    w('');
    for (const r of deactivated) {
      w(`### ${r.plugin.name}`);
      w(`- **Version:** ${r.old_version} → ${r.verified_version || r.new_version}`);
      w(`- **Status:** DEACTIVATED — ${r.message}`);
      w(`- **Action Required:** Manual investigation needed. Either fix the issue and reactivate, or restore the previous version.`);
      w('');
      w('**Regressions detected:**');
      for (const reg of r.regressions) {
        const icon = { blocker: '🚨', major: '⚠️', warning: '💡' }[reg.type];
        w(`- ${icon} [${reg.type}] ${reg.detail}`);
      }
      w('');

      // Before/after comparison
      if (r.baseline && r.post_update) {
        w('**Health comparison (before → after):**');
        w('');
        w('| Page | Before | After |');
        w('|------|--------|-------|');
        for (const afterPage of r.post_update.page_health) {
          const beforePage = r.baseline.page_health.find((p) => p.url === afterPage.url);
          const beforeStatus = beforePage ? `${beforePage.status} (${fmtMs(beforePage.load_time_ms)})` : '?';
          const afterStatus = `${afterPage.status} (${fmtMs(afterPage.load_time_ms)})`;
          const changed = beforePage?.status !== afterPage.status ? ' ⚠️' : '';
          w(`| ${afterPage.page} | ${beforeStatus} | ${afterStatus}${changed} |`);
        }
        w('');
      }
    }
  }

  // ── Failed ───────────────────────────────────────────────────────────
  const failed = result.results.filter((r) => r.action === 'failed');
  if (failed.length > 0) {
    w('## Failed Updates');
    w('');
    for (const r of failed) {
      w(`- **${r.plugin.name}** (${r.old_version} → ${r.new_version}): ${r.message}`);
    }
    w('');
  }

  // ── Skipped Major ────────────────────────────────────────────────────
  const skipped = result.results.filter((r) => r.action === 'skipped-major');
  if (skipped.length > 0) {
    w('## Skipped — Major Version Updates (Manual Review Required)');
    w('');
    w('These plugins have major version updates that may contain breaking changes.');
    w('Review the changelog before updating manually.');
    w('');
    w('| Plugin | Current | Available | Type |');
    w('|--------|---------|-----------|------|');
    for (const r of skipped) {
      w(`| ${r.plugin.name} | ${r.old_version} | ${r.new_version} | ${r.update_type} |`);
    }
    w('');
  }

  // ── Write file ──────────────────────────────────────────────────────
  const markdown = lines.join('\n');
  const reportPath = path.join(outputDir, 'update-report.md');
  await fs.writeFile(reportPath, markdown, 'utf-8');

  try {
    await markdownToPdf(reportPath);
  } catch { /* best effort */ }

  return reportPath;
}
