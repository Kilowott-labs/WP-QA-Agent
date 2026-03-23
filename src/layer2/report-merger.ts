import fs from 'fs/promises';
import path from 'path';
import { Layer1Results, Issue } from '../types.js';
import { readJson, fmtMs, logger } from '../utils.js';
import { markdownToPdf } from '../pdf.js';

interface Layer2Findings {
  tested_at: string;
  investigations: Layer2InvestigationResult[];
  additional_findings?: string[];
}

interface Layer2InvestigationResult {
  id: string;
  status: 'pass' | 'fail' | 'warning';
  summary: string;
  details: string;
  screenshots: string[];
  issues: Layer2Issue[];
}

interface Layer2Issue {
  severity: 'blocker' | 'major' | 'minor';
  title: string;
  description: string;
  location?: string;
  how_to_fix?: string;
}

/**
 * Merge Layer 1 results + Layer 2 findings into a final combined report.
 */
export async function mergeReports(reportDir: string): Promise<string> {
  const l1Path = path.join(reportDir, 'layer1-results.json');
  const l2Path = path.join(reportDir, 'layer2-findings.json');

  const l1 = await readJson<Layer1Results>(l1Path);

  let l2: Layer2Findings | null = null;
  try {
    l2 = await readJson<Layer2Findings>(l2Path);
  } catch {
    logger.warn('No Layer 2 findings found — generating report from Layer 1 only');
  }

  const lines: string[] = [];
  const w = (...args: string[]) => lines.push(args.join(''));

  // ── Header ───────────────────────────────────────────────────────────
  w(`# QA Report — ${l1.site.name}`);
  w(`Generated: ${new Date().toISOString()}`);
  w(`Layer 1 Duration: ${fmtMs(l1.duration_ms)}`);
  w(`Mode: ${l1.tester_mode}`);
  w(`Layers: ${l2 ? 'L1 + L2 (full)' : 'L1 only'}`);
  w('');

  // ── Determine overall status ─────────────────────────────────────────
  const allIssues: (Layer2Issue & { source: string })[] = [];
  if (l2) {
    for (const inv of l2.investigations) {
      for (const issue of inv.issues) {
        allIssues.push({ ...issue, source: `L2:${inv.id}` });
      }
    }
  }

  const failedPages = l1.page_health.filter((p) => !p.ok);
  const hasCriticalReview = (l1.code_review?.summary.critical ?? 0) > 0;
  const hasBlockers = allIssues.some((i) => i.severity === 'blocker') || failedPages.length > 0 || hasCriticalReview;
  const hasMajor = allIssues.some((i) => i.severity === 'major');
  const overallStatus = hasBlockers ? 'CRITICAL' : hasMajor ? 'WARNING' : 'PASS';
  const statusIcon = { PASS: '✅', WARNING: '⚠️', CRITICAL: '🚨' }[overallStatus];

  w(`## ${statusIcon} Overall Status: ${overallStatus}`);
  w('');

  // Summary
  const blockers = allIssues.filter((i) => i.severity === 'blocker');
  const majors = allIssues.filter((i) => i.severity === 'major');
  const minors = allIssues.filter((i) => i.severity === 'minor');
  w(`**${blockers.length} blockers, ${majors.length} major issues, ${minors.length} minor issues**`);
  w('');

  // ── Blocker Issues ───────────────────────────────────────────────────
  if (blockers.length > 0) {
    w('## 🚨 Blocker Issues');
    w('');
    for (const issue of blockers) {
      w(`### ${issue.title}`);
      w(`**Source:** ${issue.source}`);
      if (issue.location) w(`**Location:** ${issue.location}`);
      w(issue.description);
      if (issue.how_to_fix) w(`**Fix:** ${issue.how_to_fix}`);
      w('');
    }
  }

  // ── Major Issues ─────────────────────────────────────────────────────
  if (majors.length > 0) {
    w('## ⚠️ Major Issues');
    w('');
    for (const issue of majors) {
      w(`### ${issue.title}`);
      w(`**Source:** ${issue.source}`);
      if (issue.location) w(`**Location:** ${issue.location}`);
      w(issue.description);
      if (issue.how_to_fix) w(`**Fix:** ${issue.how_to_fix}`);
      w('');
    }
  }

  // ── Minor Issues ─────────────────────────────────────────────────────
  if (minors.length > 0) {
    w('## 💡 Minor Issues');
    w('');
    for (const issue of minors) {
      w(`- **${issue.title}**${issue.location ? ` (${issue.location})` : ''}: ${issue.description}`);
    }
    w('');
  }

  // ── Layer 1 Checks Summary ───────────────────────────────────────────
  w('## Layer 1 — Automated Checks');
  w('');
  w('| Check | Status | Detail |');
  w('|-------|--------|--------|');
  for (const c of l1.checks) {
    const icon = { PASS: '✅', FAIL: '❌', WARN: '⚠️', ERROR: '🔴', SKIP: '⏭️' }[c.status];
    w(`| ${c.check} | ${icon} ${c.status} | ${c.detail || ''} |`);
  }
  w('');

  // ── Layer 2 Investigation Results ────────────────────────────────────
  if (l2) {
    w('## Layer 2 — Adaptive Testing');
    w('');
    for (const inv of l2.investigations) {
      const icon = { pass: '✅', fail: '❌', warning: '⚠️' }[inv.status];
      w(`### ${icon} ${inv.id}`);
      w(`**Summary:** ${inv.summary}`);
      w('');
      w(inv.details);
      w('');
    }

    if (l2.additional_findings && l2.additional_findings.length > 0) {
      w('### Additional Findings');
      w('');
      for (const finding of l2.additional_findings) {
        w(`- ${finding}`);
      }
      w('');
    }
  }

  // ── Lighthouse (from L1) ─────────────────────────────────────────────
  if (l1.lighthouse) {
    const lh = l1.lighthouse;
    w('## Performance');
    w('');
    w('| Metric | Mobile | Desktop |');
    w('|--------|--------|---------|');
    w(`| Performance | ${lh.mobile.performance} | ${lh.desktop.performance} |`);
    w(`| Accessibility | ${lh.mobile.accessibility} | ${lh.desktop.accessibility} |`);
    w(`| Best Practices | ${lh.mobile.best_practices} | ${lh.desktop.best_practices} |`);
    w(`| SEO | ${lh.mobile.seo} | ${lh.desktop.seo} |`);
    w('');
  }

  // ── WordPress Health (from L1) ───────────────────────────────────────
  const wp = l1.wordpress_health;
  if (wp.rest_api_accessible) {
    w('## WordPress Health');
    w('');
    w(`- WooCommerce: ${wp.woocommerce_detected ? `v${wp.wc_version || '?'}` : 'Not detected'}`);
    w(`- Plugins: ${wp.plugins.length} (${wp.plugins_needing_update.length} need updates, ${wp.inactive_plugins.length} inactive)`);
    if (wp.wc_template_overrides_outdated && wp.wc_template_overrides_outdated.length > 0) {
      w(`- ⚠️ ${wp.wc_template_overrides_outdated.length} outdated WC template overrides`);
    }
    w('');
  }

  // ── Code Review (from L1) ───────────────────────────────────────────
  if (l1.code_review && l1.code_review.total_findings > 0) {
    const cr = l1.code_review;
    w('## Code Review');
    w('');
    w(`Scanned ${cr.files_scanned} files against ${cr.checklists_applied.join(', ')} checklists.`);
    w(`Findings: ${cr.summary.critical} critical, ${cr.summary.high} high, ${cr.summary.medium} medium, ${cr.summary.low} low`);
    w('');
    const sevIcon: Record<string, string> = { critical: '🔴', high: '🟠', medium: '🟡', low: '🔵' };
    // Show critical and high findings in final report
    const important = cr.findings.filter(f => f.severity === 'critical' || f.severity === 'high');
    if (important.length > 0) {
      for (const f of important.slice(0, 15)) {
        w(`- ${sevIcon[f.severity]} **[${f.checklist}]** ${f.message} — \`${f.file}:${f.line}\``);
        w(`  Fix: ${f.fix}`);
      }
      if (important.length > 15) {
        w(`- ... and ${important.length - 15} more critical/high findings (see layer1-report.md)`);
      }
      w('');
    }
  }

  // ── Passed Checks ───────────────────────────────────────────────────
  const passed = l1.checks.filter((c) => c.status === 'PASS');
  if (passed.length > 0) {
    w('## ✅ Passed Checks');
    w('');
    for (const c of passed) {
      w(`- ${c.check}: ${c.detail || 'OK'}`);
    }
    w('');
  }

  // ── Write final report ───────────────────────────────────────────────
  const markdown = lines.join('\n');
  const reportPath = path.join(reportDir, 'final-report.md');
  await fs.writeFile(reportPath, markdown, 'utf-8');

  // Generate PDF version
  try {
    const pdfPath = await markdownToPdf(reportPath);
    logger.success(`Final report: ${reportPath}`);
    logger.success(`PDF version:  ${pdfPath}`);
  } catch {
    // PDF generation is best-effort
    logger.warn('PDF generation failed — Markdown report is still available');
  }

  return reportPath;
}
