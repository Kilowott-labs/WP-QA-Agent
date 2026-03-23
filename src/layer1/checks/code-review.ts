import fs from 'fs/promises';
import path from 'path';
import { CodeReviewResult, CodeReviewFinding, CodeAnalysis } from '../../types.js';
import { logger } from '../../utils.js';

const MAX_FILE_SIZE = 200 * 1024;
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', '.git', '.svn', 'cache',
]);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Run automated code review checks against a local WordPress project.
 * Applies key patterns from the review standards:
 *   - php-security.md (escaping, nonces, sanitization)
 *   - database.md (prepared statements, N+1)
 *   - woocommerce.md (CRUD usage, direct DB access)
 *   - rest-api.md (permission callbacks)
 *   - architecture.md (ABSPATH guard, hardcoded creds)
 *   - javascript.md (dangerouslySetInnerHTML, hardcoded data)
 *
 * Runs AFTER code-analysis.ts so it can use CodeAnalysis to scope WC checks.
 */
export async function runCodeReview(
  projectPath: string,
  codeAnalysis?: CodeAnalysis
): Promise<CodeReviewResult> {
  const result: CodeReviewResult = {
    files_scanned: 0,
    php_files_scanned: 0,
    js_files_scanned: 0,
    total_findings: 0,
    findings: [],
    summary: { critical: 0, high: 0, medium: 0, low: 0 },
    checklists_applied: [],
  };

  try {
    await fs.access(projectPath);
  } catch {
    logger.warn(`Code review: project path not accessible: ${projectPath}`);
    return result;
  }

  // Find active theme(s)
  const themePaths = await findThemePaths(projectPath);
  if (themePaths.length === 0) {
    logger.warn('Code review: no theme directory found');
    return result;
  }

  // Determine which checklists apply
  result.checklists_applied.push('php-security');
  result.checklists_applied.push('architecture');

  const hasWC = codeAnalysis?.template_overrides
    ? codeAnalysis.template_overrides.length > 0
    : false;
  const hasWCHooks = codeAnalysis?.active_hooks?.some(h =>
    h.includes('woocommerce') || h.includes('wc_')
  ) ?? false;

  if (hasWC || hasWCHooks) {
    result.checklists_applied.push('woocommerce');
  }

  if (codeAnalysis?.rest_endpoints && codeAnalysis.rest_endpoints.length > 0) {
    result.checklists_applied.push('rest-api');
  }

  result.checklists_applied.push('database');

  // Scan each theme path
  for (const themePath of themePaths) {
    // PHP files
    const phpFiles = await walkDir(themePath, '.php');
    for (const filePath of phpFiles) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');
        result.php_files_scanned++;
        result.files_scanned++;

        reviewPHP(relPath, content, result, hasWC || hasWCHooks);
      } catch { /* skip unreadable */ }
    }

    // JS files (non-minified)
    const jsFiles = await walkDir(themePath, '.js');
    const nonMinJS = jsFiles.filter(
      f => !f.endsWith('.min.js') && !f.includes('node_modules')
    );
    for (const filePath of nonMinJS) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_FILE_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = path.relative(projectPath, filePath).replace(/\\/g, '/');
        result.js_files_scanned++;
        result.files_scanned++;

        if (content.includes('registerBlockType') || content.includes('useBlockProps')) {
          result.checklists_applied.push('javascript');
        }

        reviewJS(relPath, content, result);
      } catch { /* skip */ }
    }
  }

  // Deduplicate checklists_applied
  result.checklists_applied = [...new Set(result.checklists_applied)];

  // Compute summary
  result.total_findings = result.findings.length;
  for (const f of result.findings) {
    result.summary[f.severity]++;
  }

  return result;
}

// ── PHP Review Rules ────────────────────────────────────────────────────────

function reviewPHP(
  relPath: string,
  content: string,
  result: CodeReviewResult,
  hasWC: boolean
): void {
  const lines = content.split('\n');

  // ── Architecture: ABSPATH guard ─────────────────────────────────────────
  // Every PHP file must have: if (!defined('ABSPATH')) { exit; }
  // Skip index.php (often just silence-is-golden) and files that start with <?php namespace
  const isStandalone = !relPath.endsWith('index.php')
    && !content.includes('namespace ')
    && content.trimStart().startsWith('<?php');
  if (isStandalone && !/defined\s*\(\s*['"]ABSPATH['"]\s*\)/.test(content)) {
    addFinding(result, {
      rule: 'missing-abspath-guard',
      severity: 'medium',
      file: relPath,
      line: 1,
      code_snippet: lines[0]?.trim() || '',
      message: 'Missing ABSPATH check — file can be accessed directly via URL',
      fix: "Add `if (!defined('ABSPATH')) { exit; }` at the top of the file",
      checklist: 'architecture',
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const lineNum = i + 1;

    // Skip comments and empty lines
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed === '') {
      continue;
    }

    // ── php-security: Unescaped echo/print ────────────────────────────────
    // Match echo $var; or echo get_*(); that don't use esc_*/wp_kses
    if (/\b(echo|print)\s+/.test(trimmed) && !isEscaped(trimmed)) {
      // Skip echo of plain strings, numbers, function calls that are safe
      if (!isPlainStringEcho(trimmed)) {
        addFinding(result, {
          rule: 'unescaped-output',
          severity: 'critical',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'Output without escaping function — XSS vulnerability',
          fix: 'Use esc_html(), esc_attr(), esc_url(), or wp_kses_post() depending on context',
          checklist: 'php-security',
        });
      }
    }

    // ── php-security: print_r / var_dump in production ───────────────────
    if (/\b(print_r|var_dump|var_export)\s*\(/.test(trimmed)) {
      addFinding(result, {
        rule: 'debug-output',
        severity: 'high',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'Debug function in production code — exposes internal data',
        fix: 'Remove print_r/var_dump/var_export or wrap in WP_DEBUG check',
        checklist: 'php-security',
      });
    }

    // ── php-security: Missing nonce on form handler ─────────────────────
    // Detect wp_ajax_ handler functions that don't verify nonce
    if (/add_action\s*\(\s*['"]wp_ajax_(nopriv_)?/.test(trimmed)) {
      const callbackMatch = trimmed.match(/,\s*['"](\w+)['"]/);
      if (callbackMatch) {
        const callbackName = callbackMatch[1];
        // Search for the callback function and check for nonce verification
        const funcPattern = new RegExp(
          `function\\s+${callbackName}\\s*\\(`,
        );
        const funcIdx = content.search(funcPattern);
        if (funcIdx >= 0) {
          // Check next ~30 lines of the function for nonce check
          const funcContent = content.slice(funcIdx, funcIdx + 2000);
          if (!/wp_verify_nonce|check_ajax_referer|verify_nonce/.test(funcContent)) {
            addFinding(result, {
              rule: 'missing-nonce-ajax',
              severity: 'critical',
              file: relPath,
              line: lineNum,
              code_snippet: trimmed.slice(0, 200),
              message: `AJAX handler "${callbackName}" has no nonce verification`,
              fix: 'Add check_ajax_referer() or wp_verify_nonce() as the first operation in the handler',
              checklist: 'php-security',
            });
          }
        }
      }
    }

    // ── database: wpdb without prepare ──────────────────────────────────
    if (/\$wpdb->(get_results|get_row|get_var|get_col|query)\s*\(/.test(trimmed)) {
      // Check if prepare is used
      const surroundingLines = lines.slice(Math.max(0, i - 2), i + 5).join('\n');
      if (!/->prepare\s*\(/.test(surroundingLines) && /\$/.test(trimmed.split('(')[1] || '')) {
        addFinding(result, {
          rule: 'wpdb-no-prepare',
          severity: 'critical',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'wpdb query with variable input without $wpdb->prepare() — SQL injection risk',
          fix: 'Use $wpdb->prepare() with %s/%d/%f placeholders for all variable inputs',
          checklist: 'database',
        });
      }
    }

    // ── database: Query inside loop ─────────────────────────────────────
    // Detect get_post_meta, WP_Query, get_posts inside foreach/for/while
    if (isInsideLoop(lines, i)) {
      if (/\b(get_post_meta|get_user_meta|get_option|get_term_meta)\s*\(/.test(trimmed)) {
        addFinding(result, {
          rule: 'query-in-loop',
          severity: 'high',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'Meta query inside loop — N+1 query performance problem',
          fix: 'Use update_meta_cache() or wp_cache_get() before the loop, or restructure to batch-fetch',
          checklist: 'database',
        });
      }
      if (/\bnew\s+WP_Query\b|\bget_posts\s*\(|\bwc_get_orders\s*\(|\bwc_get_products\s*\(/.test(trimmed)) {
        addFinding(result, {
          rule: 'wp-query-in-loop',
          severity: 'high',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'WP_Query/get_posts inside loop — severe N+1 performance issue',
          fix: 'Restructure to run the query once before the loop and iterate the results',
          checklist: 'database',
        });
      }
    }

    // ── woocommerce: Direct post_meta on WC objects ─────────────────────
    if (hasWC) {
      // get_post_meta with WC meta keys
      const wcMetaKeys = ['_price', '_regular_price', '_sale_price', '_sku', '_stock',
        '_stock_status', '_weight', '_length', '_width', '_height',
        '_order_total', '_order_currency', '_billing_', '_shipping_',
        '_payment_method', '_customer_user'];

      if (/\b(get_post_meta|update_post_meta|delete_post_meta)\s*\(/.test(trimmed)) {
        const hasWCKey = wcMetaKeys.some(key => trimmed.includes(`'${key}`) || trimmed.includes(`"${key}`));
        if (hasWCKey) {
          addFinding(result, {
            rule: 'wc-direct-postmeta',
            severity: 'critical',
            file: relPath,
            line: lineNum,
            code_snippet: trimmed.slice(0, 200),
            message: 'Direct post_meta access on WooCommerce data — use WC CRUD classes',
            fix: 'Use wc_get_product()/wc_get_order() and the appropriate getter/setter methods (e.g. $product->get_price(), $order->get_total())',
            checklist: 'woocommerce',
          });
        }
      }

      // wpdb queries on WC tables
      if (/\$wpdb.*(?:shop_order|wc_order|woocommerce_order|wp_posts.*post_type.*shop_order)/.test(trimmed)) {
        addFinding(result, {
          rule: 'wc-direct-db',
          severity: 'critical',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'Direct database query on WooCommerce order data — bypasses HPOS, hooks, and caches',
          fix: 'Use wc_get_orders() with WC_Order_Query for HPOS-compatible order queries',
          checklist: 'woocommerce',
        });
      }
    }

    // ── rest-api: __return_true on permission_callback ───────────────────
    if (/permission_callback.*__return_true/.test(trimmed)) {
      // Check for a comment explaining why
      const prevLine = (lines[i - 1] || '').trim();
      if (!prevLine.startsWith('//') && !prevLine.startsWith('*')) {
        addFinding(result, {
          rule: 'rest-open-permission',
          severity: 'high',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'REST endpoint with __return_true permission callback — publicly accessible without auth',
          fix: 'Add proper capability check (e.g. current_user_can()) or document why public access is intentional',
          checklist: 'rest-api',
        });
      }
    }

    // ── php-security: Hardcoded credentials / API keys ──────────────────
    if (/(?:api_key|apikey|secret_key|password|token|auth_token|private_key)\s*[=:]\s*['"][^'"]{8,}['"]/i.test(trimmed)) {
      // Skip constants defined via getenv/define patterns and common false positives
      if (!/getenv|defined|constant|sanitize_|__\(|_e\(|example|placeholder|your[-_]/.test(trimmed)) {
        addFinding(result, {
          rule: 'hardcoded-credential',
          severity: 'critical',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 80) + '...[REDACTED]',
          message: 'Possible hardcoded API key or credential in source code',
          fix: 'Move credentials to wp-config.php constants or environment variables. Use defined() to access them.',
          checklist: 'php-security',
        });
      }
    }

    // ── php-security: file_get_contents on user input ───────────────────
    if (/file_get_contents\s*\(/.test(trimmed) && /\$_(GET|POST|REQUEST|SERVER)/.test(trimmed)) {
      addFinding(result, {
        rule: 'unsafe-file-read',
        severity: 'critical',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'file_get_contents with user-controlled path — local file inclusion vulnerability',
        fix: 'Validate and sanitize the file path. Use a whitelist of allowed files.',
        checklist: 'php-security',
      });
    }

    // ── php-security: eval / preg_replace with /e ───────────────────────
    if (/\beval\s*\(/.test(trimmed) || /preg_replace\s*\(\s*['"].*\/e['"]/.test(trimmed)) {
      addFinding(result, {
        rule: 'code-execution',
        severity: 'critical',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'eval() or preg_replace /e modifier — arbitrary code execution risk',
        fix: 'Replace eval() with safer alternatives. Use preg_replace_callback() instead of /e modifier.',
        checklist: 'php-security',
      });
    }

    // ── php-security: Unvalidated wp_redirect ───────────────────────────
    if (/\bwp_redirect\s*\(/.test(trimmed) && !/esc_url_raw|wp_safe_redirect/.test(trimmed)) {
      // Check if the arg looks like a variable (not a static URL)
      if (/wp_redirect\s*\(\s*\$/.test(trimmed)) {
        addFinding(result, {
          rule: 'unsafe-redirect',
          severity: 'high',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 200),
          message: 'wp_redirect() with variable URL without esc_url_raw() — open redirect vulnerability',
          fix: 'Use wp_safe_redirect() for internal redirects or wrap URL in esc_url_raw()',
          checklist: 'php-security',
        });
      }
    }

    // ── architecture: Direct use of $_FILES without validation ──────────
    if (/\$_FILES\[/.test(trimmed) && !/wp_handle_upload|wp_check_filetype|mime/.test(
      lines.slice(Math.max(0, i - 3), i + 10).join('\n')
    )) {
      addFinding(result, {
        rule: 'unsafe-file-upload',
        severity: 'high',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'Direct $_FILES access without MIME type validation',
        fix: 'Use wp_handle_upload() with proper MIME type checking via wp_check_filetype_and_ext()',
        checklist: 'php-security',
      });
    }
  }
}

// ── JS Review Rules ─────────────────────────────────────────────────────────

function reviewJS(
  relPath: string,
  content: string,
  result: CodeReviewResult
): void {
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const lineNum = i + 1;

    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed === '') continue;

    // ── javascript: dangerouslySetInnerHTML without sanitization ────────
    if (/dangerouslySetInnerHTML/.test(trimmed)) {
      addFinding(result, {
        rule: 'dangerous-innerhtml',
        severity: 'high',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'dangerouslySetInnerHTML used — XSS risk if content is not sanitized',
        fix: 'Ensure content is sanitized server-side via wp_kses_post() before passing to the block',
        checklist: 'javascript',
      });
    }

    // ── javascript: innerHTML assignment ────────────────────────────────
    if (/\.innerHTML\s*=/.test(trimmed) && !/\.innerHTML\s*=\s*['"]/.test(trimmed)) {
      addFinding(result, {
        rule: 'innerhtml-assignment',
        severity: 'medium',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'innerHTML assignment with dynamic content — XSS risk',
        fix: 'Use textContent for plain text, or use DOM methods to build elements safely',
        checklist: 'javascript',
      });
    }

    // ── javascript: localStorage with sensitive data ────────────────────
    if (/localStorage\.(setItem|getItem)\s*\(\s*['"](?:token|password|secret|api_key|auth)/i.test(trimmed)) {
      addFinding(result, {
        rule: 'localstorage-sensitive',
        severity: 'high',
        file: relPath,
        line: lineNum,
        code_snippet: trimmed.slice(0, 200),
        message: 'Sensitive data stored in localStorage — accessible to any JS on the page',
        fix: 'Use server-side sessions or HTTP-only cookies for sensitive data',
        checklist: 'javascript',
      });
    }

    // ── javascript: hardcoded API keys/URLs ─────────────────────────────
    if (/(?:api_key|apiKey|api_secret|apiSecret)\s*[:=]\s*['"][^'"]{10,}['"]/.test(trimmed)) {
      if (!/example|placeholder|your[-_]|TODO|FIXME/.test(trimmed)) {
        addFinding(result, {
          rule: 'js-hardcoded-key',
          severity: 'critical',
          file: relPath,
          line: lineNum,
          code_snippet: trimmed.slice(0, 80) + '...[REDACTED]',
          message: 'Hardcoded API key in JavaScript — exposed to all visitors',
          fix: 'Pass data via wp_localize_script() or data-* attributes from server-side',
          checklist: 'javascript',
        });
      }
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function addFinding(result: CodeReviewResult, finding: CodeReviewFinding): void {
  // Deduplicate: same rule + file + line
  const exists = result.findings.some(
    f => f.rule === finding.rule && f.file === finding.file && f.line === finding.line
  );
  if (!exists) {
    result.findings.push(finding);
  }
}

/** Check if echo/print line uses proper escaping */
function isEscaped(line: string): boolean {
  return /esc_html|esc_attr|esc_url|esc_textarea|wp_kses|wp_kses_post|esc_html__|esc_html_e|esc_attr__|esc_attr_e|wp_json_encode|selected\(|checked\(|disabled\(/.test(line);
}

/** Check if an echo is just a plain string or safe construct */
function isPlainStringEcho(line: string): boolean {
  // echo 'string';  echo "string";  echo 123;
  if (/\b(echo|print)\s+['"][^$]*['"]/.test(line)) return true;
  // echo __('text', 'domain');  (translation functions are fine — they return literals)
  if (/\b(echo|print)\s+__\(/.test(line)) return true;
  // echo PHP_EOL; echo "\n";
  if (/\b(echo|print)\s+(PHP_EOL|'\\n'|"\\n")/.test(line)) return true;
  // echo number
  if (/\b(echo|print)\s+\d+/.test(line)) return true;
  // echo inside <?= — these are common short tags, skip for now
  if (/\<\?=/.test(line)) return false; // treat <?= as needing review
  return false;
}

/** Rough check if a line index is inside a foreach/for/while block */
function isInsideLoop(lines: string[], lineIndex: number): boolean {
  let depth = 0;
  // Walk backwards to find an enclosing loop
  for (let i = lineIndex; i >= Math.max(0, lineIndex - 100); i--) {
    const line = lines[i].trim();
    // Count braces going backward
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}') depth++;
      if (line[c] === '{') depth--;
    }
    // If we're at depth < 0, we're inside a block — check if it's a loop
    if (depth < 0 && /\b(foreach|for|while)\s*\(/.test(line)) {
      return true;
    }
    // Reset if we've exited the block
    if (depth > 0) return false;
  }
  return false;
}

/** Walk directory recursively for files with given extension */
async function walkDir(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...(await walkDir(fullPath, ext)));
      } else if (entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch { /* skip inaccessible dirs */ }
  return results;
}

/** Find theme paths in a WordPress project */
async function findThemePaths(projectPath: string): Promise<string[]> {
  const paths: string[] = [];

  // Check common theme locations
  const candidates = [
    projectPath, // Project IS the theme
    path.join(projectPath, 'wp-content', 'themes'),
  ];

  for (const candidate of candidates) {
    // If the candidate itself has functions.php, it's a theme
    try {
      await fs.access(path.join(candidate, 'functions.php'));
      paths.push(candidate);
      continue;
    } catch { /* not a theme root */ }

    // Otherwise, check subdirectories
    try {
      const entries = await fs.readdir(candidate, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const themePath = path.join(candidate, entry.name);
        try {
          await fs.access(path.join(themePath, 'functions.php'));
          paths.push(themePath);
        } catch { /* not a theme */ }
      }
    } catch { /* dir not accessible */ }
  }

  return paths;
}
