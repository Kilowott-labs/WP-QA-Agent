import {
  SiteConfig,
  UpdateRunResult,
  PluginUpdateResult,
  PluginInfo,
} from '../types.js';
import { logger, ensureDir, writeJson, slugify, elapsed, fmtMs } from '../utils.js';
import { launchBrowser } from '../layer1/browser.js';
import { getPluginsWithUpdates, updatePlugin, verifyPluginVersion, deactivatePlugin, rollbackPlugin, updateWordPressCore } from './plugin-api.js';
import { captureHealthSnapshot } from './health-snapshot.js';
import { compareSnapshots } from './compare.js';
import { classifyUpdate } from './semver.js';
import { generateUpdateReport } from './report.js';
import path from 'path';

export interface UpdateOptions {
  pluginSlug?: string; // Update specific plugin only
  includeWPCore?: boolean; // Also update WordPress core
  dryRun?: boolean;
  outputDir?: string;
}

/**
 * Run the plugin update workflow on a staging site.
 *
 * Flow: baseline → update one → verify → react → next
 * Uses staging_url if provided, otherwise falls back to config.url.
 */
export async function runPluginUpdates(
  config: SiteConfig,
  options: UpdateOptions = {}
): Promise<UpdateRunResult> {
  const startTime = Date.now();
  const startedAt = new Date().toISOString();

  if (!config.username || !config.app_password) {
    logger.error('WordPress credentials required for plugin updates.');
    logger.error('Provide username and app_password in your site config.');
    process.exit(1);
  }

  // Use staging_url if provided, otherwise fall back to the main url
  const targetUrl = config.staging_url || config.url;
  const datestamp = new Date().toISOString().slice(0, 10);
  const siteSlug = slugify(config.name);
  const outputDir = path.join(
    options.outputDir || './qa-reports',
    `${siteSlug}-updates-${datestamp}`
  );
  await ensureDir(outputDir);

  logger.section(`Plugin Update — ${config.name}`);
  logger.info(`URL: ${targetUrl}`);
  logger.info(`Mode: ${options.dryRun ? 'DRY RUN (no changes)' : 'LIVE UPDATE'}`);

  // ── Get plugins needing updates ─────────────────────────────────────
  logger.section('Checking for Updates');
  const pluginsWithUpdates = await getPluginsWithUpdates(config, targetUrl);

  if (pluginsWithUpdates.length === 0) {
    logger.success('All plugins are up to date.');
    const result: UpdateRunResult = {
      site: config.name,
      url: targetUrl,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: elapsed(startTime),
      total_plugins_with_updates: 0,
      results: [],
      halted_early: false,
      summary: { updated: 0, skipped_major: 0, failed: 0, deactivated: 0 },
    };
    await writeJson(path.join(outputDir, 'update-results.json'), result);
    return result;
  }

  // Classify and filter
  const classified = pluginsWithUpdates.map((p) => ({
    plugin: p,
    type: classifyUpdate(p.version, p.update_version!),
  }));

  // Filter by specific plugin if requested — fuzzy match on slug
  let targetPlugins = classified;
  if (options.pluginSlug) {
    const input = options.pluginSlug.toLowerCase().replace(/\.php$/, '');
    targetPlugins = classified.filter((c) => {
      const slug = c.plugin.slug.toLowerCase().replace(/\.php$/, '');
      // Exact match (without .php), or input matches the folder part
      return slug === input || slug.startsWith(input + '/') || slug === input + '/' + input.split('/').pop();
    });

    if (targetPlugins.length === 0) {
      // Try partial name match as fallback
      targetPlugins = classified.filter((c) =>
        c.plugin.name.toLowerCase().includes(input.replace(/[/-]/g, ' '))
      );
    }

    if (targetPlugins.length === 0) {
      logger.error(`Plugin "${options.pluginSlug}" not found in the update list.`);
      logger.info('Available plugins with updates:');
      for (const c of classified) {
        logger.info(`  --plugin "${c.plugin.slug}"  (${c.plugin.name})`);
      }
      process.exit(1);
    }
  }

  const autoUpdatable = targetPlugins.filter((c) => c.type !== 'major');
  const majorUpdates = targetPlugins.filter((c) => c.type === 'major');

  logger.info(`Total plugins with updates: ${pluginsWithUpdates.length}`);
  logger.info(`Auto-updatable (minor/patch): ${autoUpdatable.length}`);
  logger.info(`Major updates (manual review): ${majorUpdates.length}`);

  for (const m of majorUpdates) {
    logger.warn(`MAJOR: ${m.plugin.name} ${m.plugin.version} → ${m.plugin.update_version} (skipped)`);
    logger.dim(`    --plugin "${m.plugin.slug}"`);
  }

  // ── Build results array ─────────────────────────────────────────────
  const results: PluginUpdateResult[] = [];

  // Record skipped major updates
  for (const m of majorUpdates) {
    results.push({
      plugin: m.plugin,
      update_type: 'major',
      action: 'skipped-major',
      old_version: m.plugin.version,
      new_version: m.plugin.update_version!,
      baseline: { timestamp: '', page_health: [], console_errors: [], network_failures: [] },
      regressions: [],
      duration_ms: 0,
      message: 'Major version update — requires manual review',
    });
  }

  if (options.dryRun || autoUpdatable.length === 0) {
    if (options.dryRun) {
      logger.info('');
      logger.info('DRY RUN — no changes made. Plugins that would be updated:');
      for (const a of autoUpdatable) {
        logger.info(`  ${a.plugin.name}: ${a.plugin.version} → ${a.plugin.update_version} (${a.type})`);
        logger.dim(`    npx qa-agent update --config <config> --plugin "${a.plugin.slug}"`);
      }
    }

    const result: UpdateRunResult = {
      site: config.name,
      url: targetUrl,
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: elapsed(startTime),
      total_plugins_with_updates: pluginsWithUpdates.length,
      results,
      halted_early: false,
      summary: {
        updated: 0,
        skipped_major: majorUpdates.length,
        failed: 0,
        deactivated: 0,
      },
    };
    await writeJson(path.join(outputDir, 'update-results.json'), result);
    await generateUpdateReport(result, outputDir);
    return result;
  }

  // ── Launch browser for health checks ────────────────────────────────
  logger.section('Launching Browser for Health Verification');
  // Detect WooCommerce from the plugin list we already have — no need for a full health check
  const wcDetected = pluginsWithUpdates.some((p) =>
    p.slug.includes('woocommerce')
  ) || classified.some((c) => c.plugin.slug.includes('woocommerce'));
  const session = await launchBrowser(targetUrl);

  let halted = false;
  let haltReason: string | undefined;

  try {
    // ── WordPress core update (if requested) ────────────────────────────
    if (options.includeWPCore && !options.dryRun) {
      logger.section('WordPress Core Update');
      const coreResult = await updateWordPressCore(config, targetUrl, session.page);
      if (coreResult.success) {
        logger.success(`WordPress core: ${coreResult.message}`);
      } else {
        logger.warn(`WordPress core: ${coreResult.message}`);
      }
    }

    // ── Capture initial baseline ────────────────────────────────────────
    logger.info('Capturing baseline health snapshot...');
    let currentBaseline = await captureHealthSnapshot(
      session.page,
      config,
      session.consoleErrors,
      session.networkFailures,
      targetUrl,
      wcDetected
    );
    const baselineOkPages = currentBaseline.page_health.filter((p) => p.ok).length;
    logger.info(`Baseline: ${baselineOkPages}/${currentBaseline.page_health.length} pages OK, ${currentBaseline.console_errors.length} console errors`);

    // ── Update loop: one plugin at a time ───────────────────────────────
    for (const { plugin, type } of autoUpdatable) {
      const pluginStart = Date.now();
      logger.section(`Updating: ${plugin.name}`);
      logger.info(`${plugin.version} → ${plugin.update_version} (${type})`);

      // 1. Trigger update (pass browser page for wp-admin based updates)
      const updateResult = await updatePlugin(config, targetUrl, plugin.slug, session.page);

      if (!updateResult.success) {
        logger.error(`Update failed: ${updateResult.message}`);
        results.push({
          plugin,
          update_type: type,
          action: 'failed',
          old_version: plugin.version,
          new_version: plugin.update_version!,
          baseline: currentBaseline,
          regressions: [],
          duration_ms: elapsed(pluginStart),
          message: updateResult.message,
        });
        continue;
      }

      // 2. Verify version
      const verification = await verifyPluginVersion(
        config,
        targetUrl,
        plugin.slug,
        plugin.update_version!
      );
      logger.info(`Verified version: ${verification.version} (${verification.matches ? 'matches' : 'mismatch'})`);

      // 3. Capture post-update snapshot
      logger.info('Capturing post-update health snapshot...');
      const postUpdate = await captureHealthSnapshot(
        session.page,
        config,
        session.consoleErrors,
        session.networkFailures,
        targetUrl,
        wcDetected
      );

      // 4. Compare
      const regressions = compareSnapshots(currentBaseline, postUpdate);
      const blockers = regressions.filter((r) => r.type === 'blocker');
      const majors = regressions.filter((r) => r.type === 'major');
      const warnings = regressions.filter((r) => r.type === 'warning');

      if (blockers.length > 0) {
        logger.error(`BLOCKER REGRESSION after updating ${plugin.name}:`);
        for (const b of blockers) {
          logger.error(`  ${b.detail}`);
        }

        // 5. Roll back to previous version (use backup_id if available)
        logger.warn(`Rolling back ${plugin.name} to v${plugin.version}...`);
        const rollback = await rollbackPlugin(
          config, targetUrl, plugin.slug, plugin.version, session.page, updateResult.backup_id
        );

        if (rollback.success) {
          logger.success(`Rollback successful: ${rollback.message}`);
        } else {
          // Rollback failed — deactivate as fallback
          logger.warn(`Rollback failed: ${rollback.message}`);
          logger.warn(`Deactivating ${plugin.name} as fallback...`);
          const deactivation = await deactivatePlugin(config, targetUrl, plugin.slug);
          logger.warn(`Deactivation: ${deactivation.message}`);
        }

        results.push({
          plugin,
          update_type: type,
          action: 'deactivated',
          old_version: plugin.version,
          new_version: plugin.update_version!,
          verified_version: verification.version,
          baseline: currentBaseline,
          post_update: postUpdate,
          regressions,
          duration_ms: elapsed(pluginStart),
          message: rollback.success
            ? `Rolled back to v${plugin.version} due to blocker regression.`
            : `Deactivated due to blocker regression (rollback failed). ${rollback.message}`,
        });

        halted = true;
        haltReason = `Blocker regression after updating ${plugin.name}: ${blockers[0].detail}`;
        logger.error('Halting further updates.');
        break;
      }

      // Major or warning regressions — log but continue
      if (majors.length > 0) {
        logger.warn(`MAJOR regression after updating ${plugin.name}:`);
        for (const m of majors) logger.warn(`  ${m.detail}`);
      }
      if (warnings.length > 0) {
        for (const w of warnings) logger.dim(`  Warning: ${w.detail}`);
      }

      if (regressions.length === 0) {
        logger.success(`${plugin.name} updated successfully — no regressions detected`);
      }

      results.push({
        plugin,
        update_type: type,
        action: 'updated',
        old_version: plugin.version,
        new_version: plugin.update_version!,
        verified_version: verification.version,
        baseline: currentBaseline,
        post_update: postUpdate,
        regressions,
        duration_ms: elapsed(pluginStart),
      });

      // 6. Evolve baseline — the post-update state is the new normal
      currentBaseline = postUpdate;
    }
  } finally {
    await session.close();

    // Clean up: remove auto-installed helper mu-plugin if we created it
    if (config.project_path) {
      try {
        const { cleanupHelper } = await import('./mu-plugin.js');
        await cleanupHelper(config.project_path);
      } catch { /* non-critical */ }
    }
  }

  // ── Build final result ──────────────────────────────────────────────
  const finalResult: UpdateRunResult = {
    site: config.name,
    url: targetUrl,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    duration_ms: elapsed(startTime),
    total_plugins_with_updates: pluginsWithUpdates.length,
    results,
    halted_early: halted,
    halt_reason: haltReason,
    summary: {
      updated: results.filter((r) => r.action === 'updated').length,
      skipped_major: results.filter((r) => r.action === 'skipped-major').length,
      failed: results.filter((r) => r.action === 'failed').length,
      deactivated: results.filter((r) => r.action === 'deactivated').length,
    },
  };

  // Write results and report
  await writeJson(path.join(outputDir, 'update-results.json'), finalResult);
  const reportPath = await generateUpdateReport(finalResult, outputDir);

  // Print summary
  logger.section('Update Summary');
  logger.info(`Updated: ${finalResult.summary.updated}`);
  logger.info(`Skipped (major): ${finalResult.summary.skipped_major}`);
  logger.info(`Failed: ${finalResult.summary.failed}`);
  if (finalResult.summary.deactivated > 0) {
    logger.error(`Deactivated: ${finalResult.summary.deactivated}`);
  }
  if (halted) {
    logger.error(`HALTED: ${haltReason}`);
  }
  logger.info(`Report: ${reportPath}`);
  logger.info(`Duration: ${fmtMs(finalResult.duration_ms)}`);

  return finalResult;
}
