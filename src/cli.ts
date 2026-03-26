#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import { loadConfig, configFromCLI } from './config.js';
import { runLayer1 } from './layer1/runner.js';
import { generateLayer1Report } from './layer1/report.js';
import { buildLayer2Prompt, buildAgentContextFiles } from './layer2/prompt-builder.js';
import { mergeReports } from './layer2/report-merger.js';
import { runPluginUpdates } from './updates/runner.js';
import { checkForUpdates } from './updates/check-updates.js';
import { runWCTemplateUpdates } from './updates/wc-templates.js';
import { buildFixPrompt } from './fix/prompt-builder.js';
import { installHelperLocally, isHelperInstalled, getHelperCode } from './updates/mu-plugin.js';
import { logger, writeJson, readJson } from './utils.js';
import { FixableIssue } from './types.js';
import path from 'path';
import fs from 'fs/promises';
import yaml from 'js-yaml';

const program = new Command();

program
  .name('qa-agent')
  .description('WordPress/WooCommerce QA Agent')
  .version('1.0.0');

// ── run: The main command ─────────────────────────────────────────────────
// Runs all Layer 1 checks + auto-generates the Layer 2 prompt.
// This is the only command most users need.

program
  .command('run')
  .description('Run QA checks on a WordPress site')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL (quick run, no config file needed)')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--project <path>', 'Local WordPress project path for code analysis')
  .option('--skip-browser', 'Skip browser checks (API + Lighthouse only)')
  .option('--skip-lighthouse', 'Skip Lighthouse performance audit')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    const config = await resolveConfig(options);

    // Run all Layer 1 checks
    const { results, outputDir } = await runLayer1(config, {
      skipBrowser: options.skipBrowser,
      skipLighthouse: options.skipLighthouse,
      outputDir: options.output,
    });

    // Generate detailed Layer 1 data report (for debugging / reference)
    await generateLayer1Report(results, outputDir);

    // Generate the final report (this is what the user reads)
    const finalReportPath = await mergeReports(outputDir);

    // Generate Layer 2 prompt (always — it's free, just writes a file)
    const prompt = await buildLayer2Prompt(results, outputDir);
    const promptPath = path.join(outputDir, 'layer2-prompt.md');
    await fs.writeFile(promptPath, prompt, 'utf-8');

    // Generate per-agent context files (for subagent-based flow)
    await buildAgentContextFiles(results, outputDir);

    // Print what was produced
    logger.info('');
    logger.success(`Final report: ${finalReportPath}`);
    logger.dim(`  Raw data:      ${path.join(outputDir, 'layer1-results.json')}`);
    logger.dim(`  Detailed data: ${path.join(outputDir, 'layer1-report.md')}`);

    if (results.layer2_queue.length > 0) {
      logger.info('');
      logger.info('Want deeper testing? (optional)');
      logger.info('  1. Open Claude Code and ask it to read:');
      logger.info(`     ${promptPath}`);
      logger.info('  2. After Claude finishes, re-merge the report:');
      logger.info(`     npx qa-agent merge --report ${outputDir}`);
    }
  });

// ── merge: Combine L1 + L2 into final report ─────────────────────────────
// Run this after Claude has completed Layer 2 and written layer2-findings.json.

program
  .command('merge')
  .description('Merge Layer 1 + Layer 2 findings into final report')
  .requiredOption('--report <path>', 'Path to report directory')
  .action(async (options) => {
    try {
      const finalPath = await mergeReports(options.report);
      logger.success(`Final report: ${finalPath}`);
    } catch (err: any) {
      logger.error(`Merge failed: ${err.message}`);
      process.exit(1);
    }
  });

// ── init: Create a new site config ────────────────────────────────────────

program
  .command('init')
  .description('Create a site config file')
  .option('--url <url>', 'Site URL')
  .option('--name <name>', 'Site name')
  .option('-o, --output <path>', 'Output path', './configs/site.yml')
  .action(async (options) => {
    const yaml = [
      `name: "${options.name || 'My WordPress Site'}"`,
      `url: "${options.url || 'https://example.com'}"`,
      `# username: "qa-agent"`,
      `# app_password: "your-application-password"`,
      ``,
      `# Optional: path to local WordPress project for code analysis`,
      `# project_path: "/path/to/wordpress/project"`,
      ``,
      `description: |`,
      `  WordPress/WooCommerce site.`,
      ``,
      `# Pages are auto-discovered from site navigation.`,
      `# Add key_pages only if you want to force-include specific paths:`,
      `# key_pages:`,
      `#   - name: "Custom Page"`,
      `#     path: "/my-custom-page/"`,
      `#     must_contain: ["Expected text"]`,
      ``,
      `# known_issues:`,
      `#   - "Homepage hero image is intentionally large"`,
      ``,
      `max_links_to_crawl: 30`,
      `timeout_ms: 30000`,
    ].join('\n');

    await fs.mkdir(path.dirname(options.output), { recursive: true });
    await fs.writeFile(options.output, yaml, 'utf-8');
    logger.success(`Config created: ${options.output}`);
    logger.info('Edit the file and add your site URL, then run:');
    logger.info(`  npx qa-agent run --config ${options.output}`);
  });

// ── update: Update plugins on staging with verification ──────────────────

program
  .command('update')
  .description('Update plugins (and optionally WordPress core) with automated verification')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--wp-admin-password <password>', 'WP admin login password (if different from app password)')
  .option('--plugin <slug>', 'Update a specific plugin only (e.g. woocommerce/woocommerce.php)')
  .option('--wp-core', 'Also update WordPress core (via browser automation)')
  .option('--dry-run', 'Show what would be updated without making changes')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    const config = await resolveConfig(options);

    if (options.wpAdminPassword) {
      config.wp_admin_password = options.wpAdminPassword;
    }

    const result = await runPluginUpdates(config, {
      pluginSlug: options.plugin,
      includeWPCore: options.wpCore,
      dryRun: options.dryRun,
      outputDir: options.output,
    });

    // Exit with error code if there were blockers
    if (result.summary.deactivated > 0) {
      process.exit(2);
    }
    if (result.summary.failed > 0) {
      process.exit(1);
    }
  });

// ── check-updates: List available updates (read-only) ────────────────────

program
  .command('check-updates')
  .description('Check for available plugin updates (no changes made)')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    const config = await resolveConfig(options);
    const result = await checkForUpdates(config);

    // Write results to file
    const outputDir = options.output || './qa-reports';
    await fs.mkdir(outputDir, { recursive: true });
    await writeJson(path.join(outputDir, 'check-updates.json'), result);

    logger.info('');
    logger.info(`Results saved to: ${path.join(outputDir, 'check-updates.json')}`);
  });

// ── update-templates: Update outdated WooCommerce template overrides ─────

program
  .command('update-templates')
  .description('Update outdated WooCommerce template overrides in the theme')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--project <path>', 'Local WordPress project path')
  .option('--file <path>', 'Update a single template only (e.g. cart/cart.php)')
  .option('--version-only', 'Only update @version tag, skip PHP/HTML merge')
  .option('--dry-run', 'Show what would be updated without making changes')
  .option('--output <path>', 'Output directory for reports', './qa-reports')
  .action(async (options) => {
    const config = await resolveConfig(options);

    // Allow --project to override config
    if (options.project) {
      config.project_path = options.project;
    }

    const result = await runWCTemplateUpdates(config, {
      dryRun: options.dryRun,
      versionOnly: options.versionOnly,
      fileFilter: options.file,
      outputDir: options.output,
    });

    if (result.summary.failed > 0) {
      process.exit(1);
    }
  });

// ── setup: Install the wp-qa helper mu-plugin ─────────────────────────────

program
  .command('setup')
  .description('Install the wp-qa helper plugin for plugin updates (required on non-Elementor hosts)')
  .option('-c, --config <path>', 'Path to site config YAML file')
  .option('-u, --url <url>', 'Site URL')
  .option('--username <username>', 'WordPress username')
  .option('--password <password>', 'WordPress application password')
  .option('--project <path>', 'Local WordPress project path')
  .option('--print', 'Just print the PHP code to copy manually')
  .action(async (options) => {
    if (options.print) {
      console.log(getHelperCode());
      logger.info('');
      logger.info('Copy the code above into: wp-content/mu-plugins/site-qa-updater.php');
      return;
    }

    const config = await resolveConfig(options);

    // Check if already installed on the remote site
    if (config.username && config.app_password) {
      const installed = await isHelperInstalled(config, config.url);
      if (installed) {
        logger.success('wp-qa helper plugin is already installed and active on the site.');
        return;
      }
    }

    // Install locally
    if (config.project_path) {
      const result = await installHelperLocally(config.project_path);
      if (result.success) {
        logger.success(result.message);
        logger.info('');
        logger.info('The mu-plugin is auto-loaded by WordPress — no activation needed.');
        logger.info('Once deployed to the server, plugin updates will work via REST API.');
      } else {
        logger.error(result.message);
        logger.info('');
        logger.info('Alternatively, run with --print to get the PHP code and copy it manually:');
        logger.info('  npx qa-agent setup --print');
      }
    } else {
      logger.warn('No project_path configured — cannot install automatically.');
      logger.info('');
      logger.info('Options:');
      logger.info('  1. Add project_path to your config YAML and run this command again');
      logger.info('  2. Run with --print and manually copy the file to wp-content/mu-plugins/');
      logger.info('     npx qa-agent setup --print > site-qa-updater.php');
    }
  });

// ── fix: Generate AI-ready fix prompt from report ─────────────────────────

program
  .command('fix')
  .description('Generate a fix prompt from QA report for Claude Code to act on')
  .requiredOption('--report <path>', 'Path to report directory (from a previous run)')
  .option('--id <ids...>', 'Fix specific issues by ID (e.g. FIX-001 FIX-003)')
  .option('--category <categories...>', 'Fix all issues in category (security, performance, code, woocommerce, plugins, accessibility, wordpress, functionality, content)')
  .option('--severity <levels...>', 'Fix issues at severity level (blocker, major, minor)')
  .option('--type <types...>', 'Fix issues of type (code, config, server, plugin, content)')
  .option('--list', 'Just list available issues without generating a prompt')
  .option('--max <n>', 'Maximum issues to include in prompt', '20')
  .action(async (options) => {
    const reportDir = options.report;

    // Check report exists
    const issuesPath = path.join(reportDir, 'fixable-issues.json');
    try {
      await fs.access(issuesPath);
    } catch {
      logger.error(`No fixable-issues.json found in ${reportDir}`);
      logger.error('Run a QA check first: npx qa-agent run --url <site>');
      process.exit(1);
    }

    // List mode — just show available issues
    if (options.list) {
      const issues = await readJson<FixableIssue[]>(issuesPath);
      if (issues.length === 0) {
        logger.success('No fixable issues found — the site looks good!');
        return;
      }

      logger.section(`${issues.length} Fixable Issues`);
      logger.info('');

      const sevIcon = { blocker: '🚨', major: '⚠️', minor: '💡' };
      const byCategory = new Map<string, FixableIssue[]>();
      for (const i of issues) {
        if (!byCategory.has(i.category)) byCategory.set(i.category, []);
        byCategory.get(i.category)!.push(i);
      }

      for (const [cat, catIssues] of byCategory) {
        logger.info(`  ${cat.toUpperCase()} (${catIssues.length}):`);
        for (const i of catIssues) {
          const icon = sevIcon[i.severity] || '•';
          logger.info(`    ${icon} ${i.id} [${i.fix_type}] ${i.title}`);
        }
        logger.info('');
      }

      logger.info('Generate a fix prompt:');
      logger.info(`  npx qa-agent fix --report ${reportDir} --severity blocker major`);
      logger.info(`  npx qa-agent fix --report ${reportDir} --category security`);
      logger.info(`  npx qa-agent fix --report ${reportDir} --id FIX-001 FIX-003`);
      logger.info(`  npx qa-agent fix --report ${reportDir} --type code`);
      return;
    }

    // Generate fix prompt
    const { prompt, selectedIssues, skippedCount } = await buildFixPrompt(reportDir, {
      issueIds: options.id,
      categories: options.category,
      severities: options.severity,
      fixTypes: options.type,
      maxIssues: parseInt(options.max, 10),
    });

    if (selectedIssues.length === 0) {
      logger.warn('No issues match the selected filters.');
      logger.info('Use --list to see available issues.');
      return;
    }

    // Write prompt to file
    const promptPath = path.join(reportDir, 'fix-prompt.md');
    await fs.writeFile(promptPath, prompt, 'utf-8');

    logger.section(`Fix Prompt Generated`);
    logger.info(`Issues selected: ${selectedIssues.length}${skippedCount > 0 ? ` (${skippedCount} more available, use --max to increase)` : ''}`);
    logger.info(`Prompt: ${promptPath}`);
    logger.info('');
    logger.info('To apply fixes, ask Claude Code to read the prompt:');
    logger.info(`  "Read ${promptPath} and fix the issues listed there"`);
  });

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Auto-detect a config file in configs/ that matches the given URL.
 * Checks all .yml/.yaml files and matches by url field.
 */
async function findConfigByUrl(url: string): Promise<string | null> {
  const configDir = path.join(process.cwd(), 'configs');
  try {
    const entries = await fs.readdir(configDir);
    const yamlFiles = entries.filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));

    for (const file of yamlFiles) {
      if (file === 'example-site.yml') continue;
      const filePath = path.join(configDir, file);
      try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const parsed = yaml.load(raw) as any;
        if (parsed?.url) {
          // Match by URL (normalize trailing slashes)
          const configUrl = parsed.url.replace(/\/+$/, '');
          const inputUrl = url.replace(/\/+$/, '');
          if (configUrl === inputUrl) {
            return filePath;
          }
        }
      } catch { /* skip unreadable config files */ }
    }
  } catch { /* configs/ dir doesn't exist */ }
  return null;
}

async function resolveConfig(options: any) {
  if (options.config) {
    return loadConfig(options.config);
  } else if (options.url) {
    // Auto-detect: check if a config file exists for this URL
    const matchedConfig = await findConfigByUrl(options.url);
    if (matchedConfig) {
      logger.info(`Auto-detected config: ${matchedConfig}`);
      const config = await loadConfig(matchedConfig);
      // CLI flags override config values (so you can still override per-run)
      if (options.username) config.username = options.username;
      if (options.password) config.app_password = options.password;
      if (options.project) config.project_path = options.project;
      return config;
    }
    // No config found — build from CLI flags
    return configFromCLI({
      url: options.url,
      username: options.username,
      password: options.password,
      project: options.project,
    });
  } else {
    logger.error('Provide either --config or --url');
    process.exit(1);
  }
}

program.parse();
