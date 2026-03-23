import fs from 'fs/promises';
import path from 'path';
import {
  CodeAnalysis,
  CodeIssue,
  SiteConfig,
  RestEndpointInfo,
  AjaxHandlerInfo,
  CheckoutFieldInfo,
  EnqueuedAssetInfo,
  PageTemplateInfo,
  JSSourceFileInfo,
  PostTypeDetail,
  TaxonomyDetail,
  ShortcodeDetail,
  CheckoutFieldDetail,
  HookCallbackDetail,
  FeatureDescription,
} from '../../types.js';
import { logger } from '../../utils.js';

const MAX_PHP_SIZE = 200 * 1024;   // skip PHP files > 200KB
const MAX_JS_SIZE = 500 * 1024;    // skip JS files > 500KB
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', '.git', '.svn', 'cache',
]);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Deep-scan a local WordPress project directory for theme features,
 * hooks, endpoints, custom fields, templates, and potential issues.
 *
 * Accepts optional SiteConfig to merge user-declared custom_features
 * and critical_flows into the analysis for richer test case generation.
 */
export async function analyseProjectCode(
  projectPath: string,
  config?: SiteConfig
): Promise<CodeAnalysis> {
  const result = createEmptyResult(projectPath);

  try {
    await fs.access(projectPath);
  } catch {
    logger.warn(`Project path not accessible: ${projectPath}`);
    return result;
  }

  // Find the active theme directory (prefers child theme, also returns parent)
  const { childThemePath, parentThemePath } = await findActiveTheme(projectPath, result);
  const themePath = childThemePath;

  // Scan child theme first (higher priority), then parent if it exists
  const themesToScan: { path: string; label: string }[] = [];
  if (childThemePath) themesToScan.push({ path: childThemePath, label: 'child theme' });
  if (parentThemePath) themesToScan.push({ path: parentThemePath, label: 'parent theme' });

  for (const theme of themesToScan) {
    logger.info(`  Scanning ${theme.label} PHP files...`);
    const phpFiles = await walkDir(theme.path, '.php');
    logger.info(`  Found ${phpFiles.length} PHP files in ${theme.label}`);

    for (const filePath of phpFiles) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_PHP_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = path.relative(theme.path, filePath).replace(/\\/g, '/');
        const prefix = themesToScan.length > 1 && theme.label === 'parent theme' ? '[parent] ' : '';
        extractPHPPatterns(prefix + relPath, content, result);
      } catch { /* skip unreadable files */ }
    }

    // WooCommerce template overrides (child theme overrides take precedence)
    await findTemplateOverrides(theme.path, result);

    // Custom email templates
    await findEmailTemplates(theme.path, result);

    // theme.json (child theme's takes precedence)
    if (!result.theme_json_data) {
      await readThemeJson(theme.path, result);
    }

    // JS source files in theme
    logger.info(`  Scanning ${theme.label} JS files...`);
    const jsFiles = await walkDir(theme.path, '.js');
    const nonMinJS = jsFiles.filter(
      (f) => !f.endsWith('.min.js') && !f.includes('node_modules')
    );
    for (const filePath of nonMinJS) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_JS_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = path.relative(theme.path, filePath).replace(/\\/g, '/');
        analyseJSFile(relPath, stat.size, content, result);
      } catch { /* skip */ }
    }

    // composer.json / package.json (theme level)
    await readJsonDeps(path.join(theme.path, 'composer.json'), 'require', result.composer_dependencies);
    await readJsonDeps(path.join(theme.path, 'package.json'), 'dependencies', result.npm_dependencies);
  }

  // Project-level composer/package.json (if different from theme)
  await readJsonDeps(path.join(projectPath, 'composer.json'), 'require', result.composer_dependencies);
  await readJsonDeps(path.join(projectPath, 'package.json'), 'dependencies', result.npm_dependencies);

  // Scan custom plugins
  await scanPlugins(projectPath, result);

  // Deduplicate
  deduplicateResult(result);

  // Enriched deep extraction (second pass on key files for detail)
  for (const theme of themesToScan) {
    logger.info(`  Extracting detailed feature info from ${theme.label}...`);
    const phpFiles = await walkDir(theme.path, '.php');
    for (const filePath of phpFiles) {
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_PHP_SIZE) continue;
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = path.relative(theme.path, filePath).replace(/\\/g, '/');
        extractEnrichedDetails(relPath, content, result);
      } catch { /* skip */ }
    }
  }

  if (themesToScan.length > 0) {
    buildFeatureMap(result, config);
  }

  // Merge user-declared custom_features from config into feature map
  if (config?.custom_features && config.custom_features.length > 0) {
    mergeConfigFeatures(config, result);
  }

  // Generate test recommendations based on all findings
  generateRecommendations(result);

  return result;
}

// ── Theme Discovery ─────────────────────────────────────────────────────────

interface ThemeDiscoveryResult {
  childThemePath: string | null;
  parentThemePath: string | null;
}

/**
 * Find the active theme directory, preferring child themes.
 * If a child theme is detected (has `Template:` header), also returns the parent.
 * This ensures features from both child and parent themes are scanned.
 */
async function findActiveTheme(
  projectPath: string,
  result: CodeAnalysis
): Promise<ThemeDiscoveryResult> {
  const themesDir = path.join(projectPath, 'wp-content', 'themes');
  const discoveryResult: ThemeDiscoveryResult = {
    childThemePath: null,
    parentThemePath: null,
  };

  try {
    const themes = await fs.readdir(themesDir);

    // First pass: collect all themes with their metadata
    const themeInfos: {
      name: string;
      dir: string;
      parentSlug?: string; // Template: header → this is a child theme
    }[] = [];

    for (const theme of themes) {
      if (theme.startsWith('.')) continue;
      const stylePath = path.join(themesDir, theme, 'style.css');
      try {
        const style = await fs.readFile(stylePath, 'utf-8');
        const nameMatch = style.match(/Theme Name:\s*(.+)/i);
        if (nameMatch) {
          // Check for child theme: "Template:" header points to parent theme slug
          const templateMatch = style.match(/^\s*Template:\s*(.+)/im);
          themeInfos.push({
            name: nameMatch[1].trim(),
            dir: path.join(themesDir, theme),
            parentSlug: templateMatch ? templateMatch[1].trim() : undefined,
          });
        }
      } catch { /* no style.css */ }
    }

    // Prefer child themes (they have a Template: header pointing to parent)
    const childTheme = themeInfos.find((t) => t.parentSlug);
    if (childTheme) {
      result.theme_name = `${childTheme.name} (child theme)`;
      discoveryResult.childThemePath = childTheme.dir;

      // Find the parent theme by slug (directory name)
      const parentDir = path.join(themesDir, childTheme.parentSlug!);
      try {
        await fs.access(parentDir);
        discoveryResult.parentThemePath = parentDir;
        const parentStyle = await fs.readFile(path.join(parentDir, 'style.css'), 'utf-8');
        const parentName = parentStyle.match(/Theme Name:\s*(.+)/i)?.[1]?.trim();
        if (parentName) {
          result.theme_name = `${childTheme.name} (child of ${parentName})`;
        }
        logger.info(`  Child theme: ${childTheme.name} → Parent: ${parentName || childTheme.parentSlug}`);
      } catch {
        logger.warn(`  Parent theme "${childTheme.parentSlug}" not found locally — scanning child theme only`);
      }
    } else if (themeInfos.length > 0) {
      // No child theme found — use the first standard theme
      // Prefer themes that have functions.php (more likely to be the active one)
      let activeTheme = themeInfos[0];
      for (const t of themeInfos) {
        try {
          await fs.access(path.join(t.dir, 'functions.php'));
          activeTheme = t;
          break;
        } catch { /* no functions.php */ }
      }
      result.theme_name = activeTheme.name;
      discoveryResult.childThemePath = activeTheme.dir;
    }
  } catch { /* no themes dir */ }

  return discoveryResult;
}

// ── PHP Pattern Extraction ──────────────────────────────────────────────────

function extractPHPPatterns(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  // Page template header (first 30 lines only)
  const headerLines = content.split('\n').slice(0, 30).join('\n');
  const tmplMatch = headerLines.match(/Template Name:\s*(.+)/i);
  if (tmplMatch) {
    result.page_templates.push({ name: tmplMatch[1].trim(), file: relPath });
    result.custom_features_found.push(`Page template: ${tmplMatch[1].trim()}`);
  }

  // WooCommerce hooks
  const wcHookRe = /add_(?:action|filter)\(\s*['"](woocommerce_\w+)['"]/g;
  let m;
  while ((m = wcHookRe.exec(content)) !== null) {
    result.active_hooks.push(m[1]);
  }

  // Custom post types
  const cptRe = /register_post_type\(\s*['"](\w+)['"]/g;
  while ((m = cptRe.exec(content)) !== null) {
    result.custom_post_types.push(m[1]);
    result.custom_features_found.push(`Custom post type: ${m[1]}`);
  }

  // Custom taxonomies
  const taxRe = /register_taxonomy\(\s*['"](\w+)['"]/g;
  while ((m = taxRe.exec(content)) !== null) {
    result.custom_taxonomies.push(m[1]);
    result.custom_features_found.push(`Custom taxonomy: ${m[1]}`);
  }

  // Shortcodes
  const scRe = /add_shortcode\(\s*['"](\w+)['"]/g;
  while ((m = scRe.exec(content)) !== null) {
    result.shortcodes.push(m[1]);
    result.custom_features_found.push(`Shortcode: [${m[1]}]`);
  }

  // REST API endpoints
  const restRe = /register_rest_route\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]/g;
  while ((m = restRe.exec(content)) !== null) {
    const surrounding = content.slice(m.index, m.index + 300);
    const methodMatch = surrounding.match(/['"]methods['"]\s*=>\s*['"]?(\w+)['"]?/);
    result.rest_endpoints.push({
      namespace: m[1],
      route: m[2],
      methods: methodMatch?.[1] || 'GET',
      file: relPath,
    });
    result.custom_features_found.push(`REST endpoint: ${m[1]}${m[2]}`);
  }

  // AJAX handlers
  const ajaxRe = /add_action\(\s*['"](wp_ajax_(nopriv_)?(\w+))['"]/g;
  while ((m = ajaxRe.exec(content)) !== null) {
    result.ajax_handlers.push({
      action: m[3],
      is_nopriv: !!m[2],
      file: relPath,
    });
  }

  // Custom checkout fields
  const checkoutFieldHooks = [
    'woocommerce_checkout_fields',
    'woocommerce_before_checkout_billing_form',
    'woocommerce_after_checkout_billing_form',
    'woocommerce_before_checkout_shipping_form',
    'woocommerce_after_checkout_shipping_form',
    'woocommerce_before_order_notes',
    'woocommerce_after_order_notes',
    'woocommerce_checkout_before_customer_details',
    'woocommerce_checkout_after_customer_details',
  ];
  for (const hook of checkoutFieldHooks) {
    if (content.includes(hook)) {
      result.custom_checkout_fields.push({ hook, file: relPath });
    }
  }

  // Custom product tabs
  if (content.includes('woocommerce_product_tabs')) {
    result.custom_product_tabs.push(relPath);
    result.custom_features_found.push('Custom product tabs');
  }

  // Custom product data panels / fields
  const prodFieldHooks = [
    'woocommerce_product_data_panels',
    'woocommerce_product_data_tabs',
    'woocommerce_product_options_general_product_data',
    'woocommerce_product_options_pricing',
  ];
  for (const hook of prodFieldHooks) {
    if (content.includes(hook)) {
      result.custom_product_fields.push(`${hook} in ${relPath}`);
    }
  }

  // Gutenberg blocks
  const blockRe = /register_block_type\(\s*['"]([^'"]+)['"]/g;
  while ((m = blockRe.exec(content)) !== null) {
    result.gutenberg_blocks.push(m[1]);
    result.custom_features_found.push(`Gutenberg block: ${m[1]}`);
  }

  // Custom widgets
  const widgetRe = /class\s+(\w+)\s+extends\s+WP_Widget/g;
  while ((m = widgetRe.exec(content)) !== null) {
    result.custom_widgets.push(m[1]);
    result.custom_features_found.push(`Custom widget: ${m[1]}`);
  }

  // Enqueued scripts
  const enqScriptRe = /wp_enqueue_script\(\s*['"]([^'"]+)['"]\s*(?:,\s*['"]?([^'")\s,]+)['"]?)?/g;
  while ((m = enqScriptRe.exec(content)) !== null) {
    const before = content.slice(Math.max(0, m.index - 500), m.index);
    const isConditional = /is_(?:page|checkout|cart|product|singular|front_page|shop)\s*\(/.test(before);
    result.enqueued_scripts.push({
      handle: m[1],
      src_pattern: m[2] || '',
      file: relPath,
      is_conditional: isConditional,
    });
  }

  // WC Email class extensions
  if (/class\s+\w+\s+extends\s+WC_Email/.test(content)) {
    result.custom_email_templates.push(relPath);
    result.custom_features_found.push(`Custom WC email: ${relPath}`);
  }

  // Security: unsanitized superglobals
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/\$_(GET|POST|REQUEST)\[/.test(lines[i])) {
      // Check surrounding 5 lines for sanitization
      const window = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      if (!/sanitize_|esc_|wp_kses|intval|absint|wp_nonce|wp_verify/.test(window)) {
        result.potential_issues.push({
          severity: 'major',
          file: relPath,
          issue: `Unsanitized $_GET/$_POST/$_REQUEST on line ${i + 1}`,
          recommendation: 'Use sanitize_text_field(), esc_html(), or wp_kses() on user input',
        });
      }
    }
  }
}

// ── JS File Analysis ────────────────────────────────────────────────────────

function analyseJSFile(
  relPath: string,
  sizeBytes: number,
  content: string,
  result: CodeAnalysis
): void {
  const features: string[] = [];

  if (/wc_checkout_params|wc_cart_params|woocommerce_params/.test(content))
    features.push('wc-integration');
  if (/\$\.ajax|jQuery\.ajax|fetch\(|XMLHttpRequest/.test(content))
    features.push('ajax');
  if (/Stripe|paypal|braintree/i.test(content))
    features.push('payment-gateway');
  if (/FormData|form\.submit|validate/.test(content))
    features.push('form-handling');
  if (/addEventListener|\.on\(|\.click\(/.test(content))
    features.push('event-handlers');
  if (/wp\.blocks|registerBlockType/.test(content))
    features.push('gutenberg');
  if (/gsap|ScrollTrigger|anime|swiper|slick/i.test(content))
    features.push('animations');
  if (/google.*maps|mapbox|leaflet/i.test(content))
    features.push('maps');

  if (features.length > 0) {
    result.js_source_files.push({ file: relPath, size_bytes: sizeBytes, features });
  }
}

// ── Template Overrides ──────────────────────────────────────────────────────

async function findTemplateOverrides(
  themePath: string,
  result: CodeAnalysis
): Promise<void> {
  const wcDir = path.join(themePath, 'woocommerce');
  try {
    const overrides = await walkDir(wcDir, '.php');
    result.template_overrides = overrides.map((f) =>
      path.relative(wcDir, f).replace(/\\/g, '/')
    );
  } catch { /* no WC overrides */ }
}

async function findEmailTemplates(
  themePath: string,
  result: CodeAnalysis
): Promise<void> {
  const emailDir = path.join(themePath, 'woocommerce', 'emails');
  try {
    const emails = await walkDir(emailDir, '.php');
    for (const f of emails) {
      const rel = path.relative(themePath, f).replace(/\\/g, '/');
      if (!result.custom_email_templates.includes(rel)) {
        result.custom_email_templates.push(rel);
      }
    }
  } catch { /* no email overrides */ }
}

// ── Config File Readers ─────────────────────────────────────────────────────

async function readThemeJson(
  themePath: string,
  result: CodeAnalysis
): Promise<void> {
  try {
    const raw = await fs.readFile(path.join(themePath, 'theme.json'), 'utf-8');
    const data = JSON.parse(raw);
    result.theme_json_data = {
      version: data.version || 1,
      has_custom_templates: !!(data.customTemplates?.length),
      has_template_parts: !!(data.templateParts?.length),
      custom_color_palette: !!(data.settings?.color?.palette?.length),
      custom_font_sizes: !!(data.settings?.typography?.fontSizes?.length),
    };
    result.custom_features_found.push('Block theme with theme.json');
  } catch { /* no theme.json */ }
}

async function readJsonDeps(
  filePath: string,
  key: string,
  target: string[]
): Promise<void> {
  try {
    const data = JSON.parse(await fs.readFile(filePath, 'utf-8'));
    const deps = Object.keys(data[key] || {});
    for (const d of deps) {
      if (!target.includes(d)) target.push(d);
    }
  } catch { /* file not found */ }
}

// ── Plugin Scanner ──────────────────────────────────────────────────────────

async function scanPlugins(
  projectPath: string,
  result: CodeAnalysis
): Promise<void> {
  const pluginsDir = path.join(projectPath, 'wp-content', 'plugins');
  try {
    const plugins = await fs.readdir(pluginsDir);
    for (const plugin of plugins) {
      if (plugin.startsWith('.')) continue;
      const pluginDir = path.join(pluginsDir, plugin);
      try {
        const stat = await fs.stat(pluginDir);
        if (!stat.isDirectory()) continue;
      } catch { continue; }

      const mainFile = path.join(pluginDir, `${plugin}.php`);
      try {
        const content = await fs.readFile(mainFile, 'utf-8');
        if (content.includes('Plugin Name:')) {
          const uri = content.match(/Plugin URI:\s*(.+)/i)?.[1]?.trim();
          if (!uri || uri.includes('localhost') || uri.includes('example')) {
            result.custom_features_found.push(`Custom plugin: ${plugin}`);
          }
        }
      } catch { /* main file doesn't follow convention */ }
    }
  } catch { /* no plugins dir */ }
}

// ── Recommendations ─────────────────────────────────────────────────────────

function generateRecommendations(result: CodeAnalysis): void {
  if (result.template_overrides.length > 0) {
    result.test_recommendations.push(
      `Verify ${result.template_overrides.length} WooCommerce template overrides render correctly — these may break on WC updates`
    );
  }
  if (result.custom_checkout_fields.length > 0) {
    result.test_recommendations.push(
      'Custom checkout fields detected — verify they render, validate, and save correctly'
    );
  }
  if (result.rest_endpoints.length > 0) {
    result.test_recommendations.push(
      `Test ${result.rest_endpoints.length} custom REST API endpoints for correct responses`
    );
  }
  if (result.ajax_handlers.some((h) => h.is_nopriv)) {
    result.test_recommendations.push(
      'Public AJAX handlers found — test AJAX-powered features as a logged-out user'
    );
  }
  if (result.custom_product_tabs.length > 0) {
    result.test_recommendations.push(
      'Custom product tabs detected — verify tab content displays on product pages'
    );
  }
  if (result.page_templates.length > 0) {
    result.test_recommendations.push(
      `Verify ${result.page_templates.length} custom page templates render without layout issues`
    );
  }
  if (result.gutenberg_blocks.length > 0) {
    result.test_recommendations.push(
      `Test ${result.gutenberg_blocks.length} custom Gutenberg blocks on frontend`
    );
  }
  if (result.custom_widgets.length > 0) {
    result.test_recommendations.push(
      'Verify custom widgets render correctly in sidebars/footer'
    );
  }
  if (result.active_hooks.some((h) => h.includes('checkout'))) {
    result.test_recommendations.push(
      'Custom checkout hooks detected — test full checkout flow carefully'
    );
  }
  if (result.custom_post_types.length > 0) {
    result.test_recommendations.push(
      'Custom post types found — verify archives and single views display correctly'
    );
  }
  if (result.potential_issues.length > 0) {
    result.test_recommendations.push(
      `${result.potential_issues.length} security concerns found — review input sanitization`
    );
  }
  if (result.custom_email_templates.length > 0) {
    result.test_recommendations.push(
      'Custom WooCommerce email templates found — verify order confirmation emails'
    );
  }

  // JS-specific recommendations
  const jsFeatures = new Set(result.js_source_files.flatMap((f) => f.features));
  if (jsFeatures.has('payment-gateway')) {
    result.test_recommendations.push(
      'Custom payment gateway JS detected — verify payment forms load and function'
    );
  }
  if (jsFeatures.has('wc-integration')) {
    result.test_recommendations.push(
      'WooCommerce JS integration detected — verify cart/checkout JS functionality'
    );
  }
}

// ── Enriched Detail Extraction ────────────────────────────────────────────

/**
 * Second-pass extraction: reads function bodies and arguments
 * to produce detailed, test-case-ready information.
 */
function extractEnrichedDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  extractPostTypeDetails(relPath, content, result);
  extractTaxonomyDetails(relPath, content, result);
  extractShortcodeDetails(relPath, content, result);
  extractCheckoutFieldDetails(relPath, content, result);
  extractHookCallbackDetails(relPath, content, result);
}

/**
 * Extract register_post_type() with labels, supports, archive setting.
 */
function extractPostTypeDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  const re = /register_post_type\(\s*['"](\w+)['"]\s*,\s*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const slug = m[1];
    // Already have basic entry — skip if enriched already exists
    if (result.post_type_details.some((d) => d.slug === slug)) continue;

    // Read the next ~80 lines for the args array
    const after = content.slice(m.index, m.index + 3000);

    const label = after.match(/['"]label['"]\s*=>\s*['"_](.*?)['"]/)?.[1]
      || after.match(/['"]labels['"]\s*=>\s*.*?['"]name['"]\s*=>\s*['"_](.*?)['"]/s)?.[1]
      || slug;
    const pluralLabel = after.match(/['"]labels['"]\s*=>\s*.*?['"]name['"]\s*=>\s*['"_](.*?)['"]/s)?.[1];

    const hasArchive = /['"]has_archive['"]\s*=>\s*true/.test(after);
    const isPublic = !/['"]public['"]\s*=>\s*false/.test(after);

    // Extract supports array
    const supports: string[] = [];
    const supportsMatch = after.match(/['"]supports['"]\s*=>\s*(?:array\s*\(|\[)([\s\S]*?)(?:\)|\])/);
    if (supportsMatch) {
      const items = supportsMatch[1].match(/['"](\w+)['"]/g);
      if (items) {
        for (const item of items) supports.push(item.replace(/['"]/g, ''));
      }
    }

    result.post_type_details.push({
      slug,
      label: cleanLabel(label),
      plural_label: pluralLabel ? cleanLabel(pluralLabel) : undefined,
      has_archive: hasArchive,
      public: isPublic,
      supports: supports.length > 0 ? supports : ['title', 'editor'],
      file: relPath,
    });
  }
}

/**
 * Extract register_taxonomy() with labels, object types, hierarchical setting.
 */
function extractTaxonomyDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  const re = /register_taxonomy\(\s*['"](\w+)['"]\s*,\s*(?:['"](\w+)['"]|array\s*\(([^)]+)\)|\[([^\]]+)\])/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const slug = m[1];
    if (result.taxonomy_details.some((d) => d.slug === slug)) continue;

    const objectTypesRaw = m[2] || m[3] || m[4] || '';
    const objectTypes = objectTypesRaw
      .match(/['"](\w+)['"]/g)
      ?.map((s) => s.replace(/['"]/g, '')) || [objectTypesRaw.replace(/['"]/g, '')];

    const after = content.slice(m.index, m.index + 2000);
    const hierarchical = /['"]hierarchical['"]\s*=>\s*true/.test(after);
    const label = after.match(/['"]label['"]\s*=>\s*['"_](.*?)['"]/)?.[1] || slug;

    result.taxonomy_details.push({
      slug,
      label: cleanLabel(label),
      object_types: objectTypes.filter(Boolean),
      hierarchical,
      file: relPath,
    });
  }
}

/**
 * Extract add_shortcode() with callback body analysis.
 */
function extractShortcodeDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  const re = /add_shortcode\(\s*['"](\w+)['"]\s*,\s*['"]?(\w+)['"]?\s*\)/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const tag = m[1];
    const callback = m[2];
    if (result.shortcode_details.some((d) => d.tag === tag)) continue;

    // Find the callback function body
    const funcBody = extractFunctionBody(content, callback);
    const attributes: string[] = [];
    const description: string[] = [];

    if (funcBody) {
      // Extract shortcode_atts defaults
      const attsMatch = funcBody.match(/shortcode_atts\(\s*(?:array\s*\(|\[)([\s\S]*?)(?:\)|\])/);
      if (attsMatch) {
        const attrPairs = attsMatch[1].match(/['"](\w+)['"]\s*=>/g);
        if (attrPairs) {
          for (const pair of attrPairs) {
            attributes.push(pair.match(/['"](\w+)['"]/)?.[1] || '');
          }
        }
      }

      // Determine what it does
      if (/WP_Query|get_posts|new.*query/i.test(funcBody)) description.push('queries posts/content');
      if (/wc_get_product|WC_Product/i.test(funcBody)) description.push('displays WooCommerce products');
      if (/get_template_part|wc_get_template|include/.test(funcBody)) description.push('renders a template');
      if (/<form|<input/.test(funcBody)) description.push('renders a form');
      if (/wp_enqueue_script/.test(funcBody)) description.push('loads JavaScript');
      if (/do_shortcode/.test(funcBody)) description.push('processes nested shortcodes');
    }

    result.shortcode_details.push({
      tag,
      file: relPath,
      callback,
      accepted_attributes: attributes.filter(Boolean),
      renders_html: funcBody ? /<[a-z]|ob_start|return.*['"<]/.test(funcBody) : false,
      uses_query: funcBody ? /WP_Query|get_posts|wc_get_products/.test(funcBody) : false,
      description: description.length > 0
        ? `[${tag}] shortcode: ${description.join(', ')}`
        : `[${tag}] shortcode in ${relPath}`,
    });
  }
}

/**
 * Extract checkout field modifications with actual field names, types, labels.
 */
function extractCheckoutFieldDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  const checkoutHooks = [
    'woocommerce_checkout_fields',
    'woocommerce_before_checkout_billing_form',
    'woocommerce_after_checkout_billing_form',
    'woocommerce_before_checkout_shipping_form',
    'woocommerce_after_checkout_shipping_form',
    'woocommerce_before_order_notes',
    'woocommerce_after_order_notes',
  ];

  for (const hook of checkoutHooks) {
    const hookIdx = content.indexOf(hook);
    if (hookIdx === -1) continue;
    if (result.checkout_field_details.some((d) => d.hook === hook && d.file === relPath)) continue;

    // Get surrounding context: find the callback function
    const surroundingBefore = content.slice(Math.max(0, hookIdx - 200), hookIdx);
    const callbackMatch = surroundingBefore.match(/['"](\w+)['"]\s*(?:,\s*\d+)?\s*\)\s*;?\s*$/);
    const callbackName = callbackMatch?.[1];

    const fields: CheckoutFieldDetail['fields'] = [];
    let condition: string | undefined;
    let funcBody: string | undefined;

    if (callbackName) {
      funcBody = extractFunctionBody(content, callbackName) || undefined;
    } else {
      // Inline closure — read next 100 lines
      funcBody = content.slice(hookIdx, hookIdx + 4000);
    }

    if (funcBody) {
      // Extract field definitions: $fields['billing']['billing_vat'] = array(...)
      const fieldRe = /\$fields?\[['"]?\w*['"]?\]\[['"](\w+)['"]\]\s*=\s*(?:array\s*\(|\[)([\s\S]*?)(?:\)|\])\s*;/g;
      let fm;
      while ((fm = fieldRe.exec(funcBody)) !== null) {
        const fieldName = fm[1];
        const fieldDef = fm[2];
        fields.push({
          name: fieldName,
          type: fieldDef.match(/['"]type['"]\s*=>\s*['"](\w+)['"]/)?.[1] || 'text',
          label: cleanLabel(fieldDef.match(/['"]label['"]\s*=>\s*['"]([^'"]+)['"]/)?.[1] || fieldName),
          required: /['"]required['"]\s*=>\s*true/.test(fieldDef),
          validation: fieldDef.match(/['"]validate['"]\s*=>\s*(?:array\s*\(|\[)([^)\]]+)/)?.[1]?.replace(/['"]/g, '').trim(),
        });
      }

      // Also check for woocommerce_form_field() calls
      const formFieldRe = /woocommerce_form_field\(\s*['"](\w+)['"]\s*,\s*(?:array\s*\(|\[)([\s\S]*?)(?:\)|\])\s*,/g;
      while ((fm = formFieldRe.exec(funcBody)) !== null) {
        const fieldName = fm[1];
        if (fields.some((f) => f.name === fieldName)) continue;
        const fieldDef = fm[2];
        fields.push({
          name: fieldName,
          type: fieldDef.match(/['"]type['"]\s*=>\s*['"](\w+)['"]/)?.[1] || 'text',
          label: cleanLabel(fieldDef.match(/['"]label['"]\s*=>\s*['"]([^'"]+)['"]/)?.[1] || fieldName),
          required: /['"]required['"]\s*=>\s*true/.test(fieldDef),
        });
      }

      // Detect conditions
      if (/is_user_logged_in/.test(funcBody)) condition = 'Only for logged-in users';
      else if (/is_checkout/.test(funcBody) && /is_cart/.test(funcBody)) condition = 'On checkout and cart pages';
      else if (/\$_POST|is_checkout_pay_page/.test(funcBody)) condition = 'During checkout submission';
    }

    const description = fields.length > 0
      ? `${hook}: adds ${fields.map((f) => `"${f.label}" (${f.type}${f.required ? ', required' : ''})`).join(', ')}`
      : `${hook}: modifies checkout fields in ${relPath}`;

    result.checkout_field_details.push({
      hook,
      file: relPath,
      fields,
      condition,
      description,
    });
  }
}

/**
 * Extract important WC hook callbacks with summaries of what they do.
 */
function extractHookCallbackDetails(
  relPath: string,
  content: string,
  result: CodeAnalysis
): void {
  // Focus on hooks that affect user-visible behavior
  const importantHookPatterns = [
    /add_(?:action|filter)\(\s*['"](woocommerce_(?:before|after)_(?:shop_loop|single_product|cart|checkout|main_content)\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
    /add_(?:action|filter)\(\s*['"](woocommerce_(?:product_tabs|single_product_summary|cart_totals|checkout_order_review)\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
    /add_(?:action|filter)\(\s*['"](woocommerce_(?:add_to_cart|loop_add_to_cart|cart_item|order_item)\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
    /add_filter\(\s*['"](woocommerce_(?:get_price|product_price|cart_item_price|checkout_fields)\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
    /add_(?:action|filter)\(\s*['"](woocommerce_email\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
    /add_(?:action|filter)\(\s*['"](woocommerce_(?:shipping|payment|account)\w*)['"]\s*,\s*['"]?(\w+)['"]?/g,
  ];

  for (const hookRe of importantHookPatterns) {
    let m;
    // Reset regex
    hookRe.lastIndex = 0;
    while ((m = hookRe.exec(content)) !== null) {
      const hook = m[1];
      const callback = m[2];

      if (result.hook_callbacks.some((d) => d.hook === hook && d.callback === callback)) continue;

      // Extract priority
      const afterMatch = content.slice(m.index, m.index + 200);
      const priorityMatch = afterMatch.match(/,\s*['"]?\w+['"]?\s*,\s*(\d+)/);
      const priority = priorityMatch ? parseInt(priorityMatch[1]) : undefined;

      // Read callback body
      const funcBody = extractFunctionBody(content, callback);
      const modifies: string[] = [];
      const summary: string[] = [];

      if (funcBody) {
        // What does this callback do?
        if (/echo|print|printf|wc_get_template/.test(funcBody)) {
          summary.push('outputs HTML content');
          if (/<div|<section|<span/.test(funcBody)) modifies.push('adds HTML elements');
        }
        if (/wp_enqueue_script|wp_enqueue_style/.test(funcBody)) {
          summary.push('loads scripts/styles');
          modifies.push('enqueues assets');
        }
        if (/unset\s*\(\s*\$/.test(funcBody)) {
          summary.push('removes fields/items');
          modifies.push('removes elements');
        }
        if (/\$\w+\[['"]class['"]\]|\bclass\s*=/.test(funcBody)) {
          modifies.push('adds CSS classes');
        }
        if (/wc_price|number_format|price/.test(funcBody)) {
          summary.push('modifies price display');
          modifies.push('changes price formatting');
        }
        if (/wp_redirect|wc_add_notice/.test(funcBody)) {
          summary.push('redirects or shows notices');
          modifies.push('adds user notices');
        }
        if (/update_post_meta|update_user_meta|wc_update_order/.test(funcBody)) {
          summary.push('saves custom data');
          modifies.push('writes to database');
        }
        if (/WC\(\)->cart|wc_get_cart/.test(funcBody)) {
          summary.push('modifies cart behavior');
          modifies.push('changes cart logic');
        }

        // Detect conditional wrapping
        const beforeHook = content.slice(Math.max(0, m.index - 300), m.index);
        if (/if\s*\(\s*is_(?:checkout|cart|product|shop|page)/.test(beforeHook)) {
          // Approximate the condition
        }
      }

      if (summary.length === 0) summary.push(`hooks into ${hook}`);

      result.hook_callbacks.push({
        hook,
        callback,
        file: relPath,
        priority,
        summary: summary.join(', '),
        modifies,
      });
    }
  }
}

/**
 * Merge user-declared custom_features from SiteConfig into the feature map.
 * These are human descriptions like "Custom size guide calculator on product pages"
 * that should become testable items even if code analysis couldn't auto-detect them.
 *
 * Cross-references with existing feature_map entries to avoid duplicates.
 */
function mergeConfigFeatures(config: SiteConfig, result: CodeAnalysis): void {
  for (const feature of config.custom_features || []) {
    const featureLower = feature.toLowerCase();

    // Skip if this feature is already covered by code-detected features
    const alreadyCovered = result.feature_map.some((f) => {
      const nameLower = f.name.toLowerCase();
      const descLower = f.description.toLowerCase();
      // Fuzzy match: check if key words from the user feature appear in detected features
      const keywords = featureLower.split(/\s+/).filter((w) => w.length > 3);
      const matchCount = keywords.filter(
        (kw) => nameLower.includes(kw) || descLower.includes(kw)
      ).length;
      return matchCount >= Math.ceil(keywords.length * 0.5);
    });

    if (alreadyCovered) continue;

    // Infer the feature type and likely pages from the description
    const type = inferFeatureType(featureLower);
    const pages = inferFeaturePages(featureLower);

    result.feature_map.push({
      name: feature,
      type,
      description: `User-declared custom feature: ${feature}. Not auto-detected from code — verify manually.`,
      how_to_test: `Look for this feature on the site: "${feature}". Verify it renders correctly, is functional, and works on mobile. If it involves user interaction (calculator, form, toggle), test the interaction.`,
      pages,
      code_files: [],
      depends_on: [],
    });

    // Also add to custom_features_found for completeness
    if (!result.custom_features_found.includes(feature)) {
      result.custom_features_found.push(`[config] ${feature}`);
    }
  }
}

function inferFeatureType(feature: string): FeatureDescription['type'] {
  if (/checkout|payment|billing|shipping|order/.test(feature)) return 'checkout';
  if (/cart|basket|add.to.cart/.test(feature)) return 'cart';
  if (/product|size.guide|wishlist|compare|review/.test(feature)) return 'product';
  if (/account|login|register|profile|dashboard/.test(feature)) return 'account';
  if (/menu|nav|header|footer|sidebar/.test(feature)) return 'navigation';
  if (/email|notification/.test(feature)) return 'email';
  if (/api|integration|currency|multi.?currency|vat/.test(feature)) return 'integration';
  return 'content';
}

function inferFeaturePages(feature: string): string[] {
  const pages: string[] = [];
  if (/checkout|billing|shipping|payment/.test(feature)) pages.push('/checkout/');
  if (/cart|basket/.test(feature)) pages.push('/cart/');
  if (/product|size.guide|wishlist/.test(feature)) pages.push('/shop/');
  if (/account|login|register|profile/.test(feature)) pages.push('/my-account/');
  if (/search|filter/.test(feature)) pages.push('/shop/');
  if (pages.length === 0) pages.push('/');
  return pages;
}

/**
 * Build the feature map: human-readable descriptions of what the theme does,
 * with specific test instructions.
 */
function buildFeatureMap(result: CodeAnalysis, config?: SiteConfig): void {
  const map = result.feature_map;

  // Helper: check if a feature matches any user-declared critical flow
  const isCriticalFlow = (keywords: string[]): boolean => {
    if (!config?.critical_flows) return false;
    return config.critical_flows.some((flow) => {
      const flowLower = flow.toLowerCase();
      return keywords.some((kw) => flowLower.includes(kw.toLowerCase()));
    });
  };

  // Custom post types
  for (const cpt of result.post_type_details) {
    if (['post', 'page', 'product', 'attachment'].includes(cpt.slug)) continue;
    map.push({
      name: `${cpt.label || cpt.slug} (custom post type)`,
      type: 'content',
      description: `Custom post type "${cpt.slug}"${cpt.has_archive ? ' with archive page' : ''}${cpt.public ? ' (publicly visible)' : ' (admin only)'}. Supports: ${cpt.supports.join(', ')}.`,
      how_to_test: `${cpt.has_archive ? `Visit /${cpt.slug}/ archive page. ` : ''}Open a single ${cpt.label || cpt.slug} entry. Verify content displays correctly, no layout issues. Check that ${cpt.supports.includes('thumbnail') ? 'featured images load, ' : ''}navigation works.`,
      pages: cpt.has_archive ? [`/${cpt.slug}/`] : ['/'],
      code_files: [cpt.file],
      depends_on: [],
    });
  }

  // Custom taxonomies
  for (const tax of result.taxonomy_details) {
    if (['category', 'post_tag', 'product_cat', 'product_tag'].includes(tax.slug)) continue;
    map.push({
      name: `${tax.label || tax.slug} (custom taxonomy)`,
      type: 'content',
      description: `Custom ${tax.hierarchical ? 'hierarchical ' : ''}taxonomy "${tax.slug}" for ${tax.object_types.join(', ')}.`,
      how_to_test: `Find content filtered by this taxonomy. Verify filter/category pages load and display correct content. Check that taxonomy archive URLs work.`,
      pages: [`/${tax.slug}/`],
      code_files: [tax.file],
      depends_on: [],
    });
  }

  // Checkout field customizations
  for (const cf of result.checkout_field_details) {
    if (cf.fields.length === 0) continue;
    const fieldNames = cf.fields.map((f) => `"${f.label}"`).join(', ');
    const requiredFields = cf.fields.filter((f) => f.required);
    map.push({
      name: `Custom checkout fields: ${fieldNames}`,
      type: 'checkout',
      description: cf.description + (cf.condition ? ` (${cf.condition})` : ''),
      how_to_test: `Go to checkout page. Verify these fields are visible: ${fieldNames}. ${requiredFields.length > 0 ? `Submit without filling required fields (${requiredFields.map((f) => f.label).join(', ')}) — verify validation error appears. ` : ''}Fill all fields and verify they appear in order confirmation.`,
      pages: ['/checkout/'],
      code_files: [cf.file],
      depends_on: ['woocommerce'],
    });
  }

  // Shortcodes
  for (const sc of result.shortcode_details) {
    map.push({
      name: `Shortcode [${sc.tag}]`,
      type: 'content',
      description: sc.description + (sc.accepted_attributes.length > 0 ? `. Accepts: ${sc.accepted_attributes.join(', ')}` : ''),
      how_to_test: `Find pages using [${sc.tag}] shortcode. Verify content renders correctly${sc.renders_html ? ' (outputs HTML)' : ''}${sc.uses_query ? ' and data loads from database' : ''}. Test on mobile viewport too.`,
      pages: ['/'],
      code_files: [sc.file],
      depends_on: [],
    });
  }

  // WC template overrides → group by area
  const overrideAreas = new Map<string, string[]>();
  for (const tpl of result.template_overrides) {
    const area = tpl.split('/')[0] || 'root';
    if (!overrideAreas.has(area)) overrideAreas.set(area, []);
    overrideAreas.get(area)!.push(tpl);
  }
  for (const [area, templates] of overrideAreas) {
    const areaName = {
      cart: 'Cart', checkout: 'Checkout', myaccount: 'My Account',
      emails: 'Emails', 'single-product': 'Product Page', loop: 'Shop Loop',
      global: 'Global', notices: 'Notices', order: 'Order',
      auth: 'Auth',
    }[area] || area;
    const pagePath = {
      cart: '/cart/', checkout: '/checkout/', myaccount: '/my-account/',
      'single-product': '/product/', loop: '/shop/', order: '/order/',
    }[area] || '/';
    map.push({
      name: `Custom ${areaName} templates (${templates.length} overrides)`,
      type: area.includes('checkout') ? 'checkout' : area.includes('cart') ? 'cart' : area.includes('account') ? 'account' : area.includes('email') ? 'email' : 'product',
      description: `${templates.length} WooCommerce ${areaName.toLowerCase()} templates overridden: ${templates.slice(0, 5).join(', ')}${templates.length > 5 ? '...' : ''}`,
      how_to_test: `Navigate to ${pagePath} and verify layout matches design. Check for visual glitches, missing elements, or broken functionality compared to standard WooCommerce.`,
      pages: [pagePath],
      code_files: templates.map((t) => `woocommerce/${t}`),
      depends_on: ['woocommerce'],
    });
  }

  // Custom page templates
  for (const pt of result.page_templates) {
    map.push({
      name: `Page template: ${pt.name}`,
      type: 'content',
      description: `Custom page template "${pt.name}" in ${pt.file}.`,
      how_to_test: `Find pages using the "${pt.name}" template. Verify layout renders correctly on desktop and mobile. Check for content alignment, spacing, and any dynamic elements.`,
      pages: ['/'],
      code_files: [pt.file],
      depends_on: [],
    });
  }

  // Gutenberg blocks
  if (result.gutenberg_blocks.length > 0) {
    map.push({
      name: `Custom Gutenberg blocks (${result.gutenberg_blocks.length})`,
      type: 'content',
      description: `Custom blocks: ${result.gutenberg_blocks.join(', ')}. These render custom content in the block editor.`,
      how_to_test: `Browse content pages (homepage, about, landing pages). Look for custom block content — interactive elements, custom layouts, dynamic sections. Verify they render on desktop and mobile.`,
      pages: ['/'],
      code_files: [],
      depends_on: [],
    });
  }

  // Hook callbacks that modify visible behavior
  const visibleHooks = result.hook_callbacks.filter((h) =>
    h.modifies.some((m) => m.includes('HTML') || m.includes('price') || m.includes('removes') || m.includes('notices'))
  );
  if (visibleHooks.length > 0) {
    const hooksByArea = new Map<string, HookCallbackDetail[]>();
    for (const h of visibleHooks) {
      const area = h.hook.includes('checkout') ? 'Checkout'
        : h.hook.includes('cart') ? 'Cart'
        : h.hook.includes('product') ? 'Product'
        : h.hook.includes('account') ? 'Account'
        : 'General';
      if (!hooksByArea.has(area)) hooksByArea.set(area, []);
      hooksByArea.get(area)!.push(h);
    }
    for (const [area, hooks] of hooksByArea) {
      map.push({
        name: `Custom ${area} behavior (${hooks.length} hooks)`,
        type: area.toLowerCase() as FeatureDescription['type'],
        description: hooks.map((h) => `${h.callback}: ${h.summary}`).join('. '),
        how_to_test: `Navigate through the ${area.toLowerCase()} flow. Look for custom elements, modified layouts, or changed behavior. Specific changes: ${hooks.map((h) => h.modifies.join(', ')).join('; ')}.`,
        pages: [area === 'Checkout' ? '/checkout/' : area === 'Cart' ? '/cart/' : area === 'Product' ? '/shop/' : '/'],
        code_files: [...new Set(hooks.map((h) => h.file))],
        depends_on: area === 'Checkout' || area === 'Cart' || area === 'Product' ? ['woocommerce'] : [],
      });
    }
  }

  // AJAX-powered features
  const publicAjax = result.ajax_handlers.filter((h) => h.is_nopriv);
  if (publicAjax.length > 0) {
    map.push({
      name: `AJAX features (${publicAjax.length} public endpoints)`,
      type: 'integration',
      description: `Public AJAX handlers: ${publicAjax.map((h) => h.action).join(', ')}. These power dynamic features like live search, add-to-cart without reload, or newsletter signups.`,
      how_to_test: `Browse the site looking for dynamic/AJAX features. Interact with them and verify they respond. Check browser console for AJAX errors. Test as logged-out user.`,
      pages: ['/'],
      code_files: [...new Set(publicAjax.map((h) => h.file))],
      depends_on: [],
    });
  }

  // REST endpoints
  if (result.rest_endpoints.length > 0) {
    map.push({
      name: `Custom REST API (${result.rest_endpoints.length} endpoints)`,
      type: 'integration',
      description: `Custom endpoints: ${result.rest_endpoints.map((e) => `${e.methods} /wp-json/${e.namespace}${e.route}`).join(', ')}`,
      how_to_test: `Look for features that make API calls (search suggestions, dynamic filtering, content loading). Verify they respond correctly. Check network tab for failed API calls.`,
      pages: ['/'],
      code_files: [...new Set(result.rest_endpoints.map((e) => e.file))],
      depends_on: [],
    });
  }

  // Detect plugin dependencies from code patterns and populate depends_on
  populateFeatureDependencies(result, map);
}

/**
 * Analyze code patterns to populate depends_on for each feature map entry.
 * Matches enqueued script handles, hook patterns, and JS features to known plugins.
 */
function populateFeatureDependencies(result: CodeAnalysis, map: FeatureDescription[]): void {
  // Build a set of detected plugin-like dependencies from various sources
  const detectedDeps = new Set<string>();

  // From enqueued scripts
  for (const s of result.enqueued_scripts) {
    if (/stripe/i.test(s.handle)) detectedDeps.add('stripe');
    if (/paypal/i.test(s.handle)) detectedDeps.add('paypal');
    if (/klarna/i.test(s.handle)) detectedDeps.add('klarna');
    if (/swiper|slick|owl/i.test(s.handle)) detectedDeps.add(s.handle);
  }

  // From JS file analysis
  for (const js of result.js_source_files) {
    for (const f of js.features) {
      if (f === 'payment-gateway') detectedDeps.add('payment-gateway-js');
      if (f === 'maps') detectedDeps.add('maps-integration');
    }
  }

  // Enrich checkout features with detected payment deps
  for (const feat of map) {
    if (feat.type === 'checkout') {
      if (detectedDeps.has('stripe')) feat.depends_on = [...(feat.depends_on || []), 'stripe'];
      if (detectedDeps.has('paypal')) feat.depends_on = [...(feat.depends_on || []), 'paypal'];
      if (detectedDeps.has('klarna')) feat.depends_on = [...(feat.depends_on || []), 'klarna'];
    }
  }
}

/**
 * Extract a PHP function body by name.
 * Returns the content between the opening { and closing } of the function.
 */
function extractFunctionBody(content: string, funcName: string): string | null {
  // Match: function funcName( ... ) {
  const funcRe = new RegExp(`function\\s+${funcName}\\s*\\([^)]*\\)\\s*\\{`);
  const match = funcRe.exec(content);
  if (!match) return null;

  // Find matching closing brace
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }

  if (depth !== 0) return null;
  return content.slice(start, i - 1);
}

/**
 * Clean a PHP label string: remove translation wrappers, escaping.
 */
function cleanLabel(label: string): string {
  return label
    .replace(/^__|^esc_html__|^esc_attr__/, '')
    .replace(/\(\s*['"]|['"]\s*,\s*['"][^'"]*['"]\s*\)$/g, '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function createEmptyResult(projectPath: string): CodeAnalysis {
  return {
    project_path: projectPath,
    theme_name: 'Unknown',
    custom_features_found: [],
    template_overrides: [],
    active_hooks: [],
    potential_issues: [],
    test_recommendations: [],
    rest_endpoints: [],
    ajax_handlers: [],
    custom_checkout_fields: [],
    custom_product_tabs: [],
    custom_product_fields: [],
    custom_email_templates: [],
    enqueued_scripts: [],
    page_templates: [],
    gutenberg_blocks: [],
    custom_widgets: [],
    custom_post_types: [],
    custom_taxonomies: [],
    shortcodes: [],
    composer_dependencies: [],
    npm_dependencies: [],
    js_source_files: [],
    post_type_details: [],
    taxonomy_details: [],
    shortcode_details: [],
    checkout_field_details: [],
    hook_callbacks: [],
    feature_map: [],
  };
}

function deduplicateResult(result: CodeAnalysis): void {
  result.active_hooks = [...new Set(result.active_hooks)];
  result.custom_features_found = [...new Set(result.custom_features_found)];
  result.custom_post_types = [...new Set(result.custom_post_types)];
  result.custom_taxonomies = [...new Set(result.custom_taxonomies)];
  result.shortcodes = [...new Set(result.shortcodes)];
  result.gutenberg_blocks = [...new Set(result.gutenberg_blocks)];
  result.custom_widgets = [...new Set(result.custom_widgets)];
  result.custom_product_tabs = [...new Set(result.custom_product_tabs)];
}

async function walkDir(dir: string, ext: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(full, ext)));
      } else if (entry.name.endsWith(ext)) {
        files.push(full);
      }
    }
  } catch { /* directory not accessible */ }
  return files;
}
