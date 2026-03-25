// ── Site Configuration ─────────────────────────────────────────────────────

export interface SiteConfig {
  name: string;
  url: string;
  staging_url?: string;
  username?: string;
  app_password?: string;       // For REST API authentication
  wp_admin_password?: string;  // For wp-admin browser login (if different from app_password)
  description?: string;
  project_path?: string;

  custom_features?: string[];
  critical_flows?: string[];
  key_pages?: PageConfig[];
  known_issues?: string[];

  run_ecommerce_flow?: boolean;
  run_auth_flow?: boolean;
  run_mobile_tests?: boolean;
  mobile_viewport?: { width: number; height: number };
  max_links_to_crawl?: number;
  timeout_ms?: number;
}

export interface PageConfig {
  name: string;
  path: string;
  expected_status?: number;
  must_contain?: string[];
  must_not_contain?: string[];
}

// ── Check Results ─────────────────────────────────────────────────────────

export interface CheckResult {
  check: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'ERROR' | 'SKIP';
  detail?: string;
  url?: string;
  data?: any;
}

export interface PageHealthResult {
  page: string;
  url: string;
  status: number | 'ERROR';
  load_time_ms: number;
  ok: boolean;
  error?: string;
  redirect_url?: string;
  screenshot?: string;
}

export interface LighthouseResult {
  url: string;
  mobile: ScoreSet;
  desktop: ScoreSet;
  core_web_vitals: CoreWebVitals;
}

export interface ScoreSet {
  performance: number;
  accessibility: number;
  best_practices: number;
  seo: number;
}

export interface CoreWebVitals {
  lcp_ms: number;
  fid_ms: number;
  cls: number;
  fcp_ms: number;
  ttfb_ms: number;
}

export interface WordPressHealthResult {
  site_name: string;
  wp_version: string;
  woocommerce_detected: boolean;
  wc_version?: string;
  plugins: PluginInfo[];
  plugins_needing_update: PluginInfo[];
  inactive_plugins: PluginInfo[];
  wc_template_overrides_outdated?: string[];
  rest_api_accessible: boolean;
}

export interface PluginInfo {
  name: string;
  slug: string;
  version: string;
  status: 'active' | 'inactive';
  update_available?: boolean;
  update_version?: string;
  is_premium?: boolean;
}

export interface BrokenLink {
  source_page: string;
  broken_url: string;
  status: number | 'TIMEOUT' | 'ERROR';
  link_text?: string;
}

// ── Browser / Flow Results ────────────────────────────────────────────────

export interface ConsoleError {
  type: string;
  message: string;
  url: string;
  timestamp: string;
}

export interface NetworkFailure {
  url: string;
  method: string;
  status?: number;
  reason?: string;
}

export interface NetworkRequest {
  url: string;
  method: string;
  status: number;
  type: string;
  duration_ms: number;
  size_bytes?: number;
  is_failed: boolean;
  error_reason?: string;
  is_third_party: boolean;
}

export interface WooCommerceJSState {
  wc_checkout_params_loaded: boolean;
  wc_cart_params_loaded: boolean;
  stripe_loaded?: boolean;
  paypal_loaded?: boolean;
  checkout_url?: string;
  ajax_url?: string;
  cart_hash?: string;
  wc_errors_visible: number;
  custom_checks: Record<string, boolean>;
}

export interface ConsoleNetworkResult {
  page_url: string;
  console_errors: ConsoleError[];
  network_failures: NetworkFailure[];
  network_requests: NetworkRequest[];
  wc_js_state?: WooCommerceJSState;
  // Review-standard browser checks
  review_checks?: ReviewBrowserChecks;
}

export interface ReviewBrowserChecks {
  forms_without_nonce: FormNonceIssue[];
  sensitive_localstorage_keys: string[];
  staging_urls_found: string[];
  ajax_requests_without_nonce: string[];
}

export interface FormNonceIssue {
  action: string;
  id: string;
  method: string;
}

// ── Code Analysis ─────────────────────────────────────────────────────────

export interface CodeAnalysis {
  project_path: string;
  theme_name: string;
  custom_features_found: string[];
  template_overrides: string[];
  active_hooks: string[];
  potential_issues: CodeIssue[];
  test_recommendations: string[];

  // Structured feature detection
  rest_endpoints: RestEndpointInfo[];
  ajax_handlers: AjaxHandlerInfo[];
  custom_checkout_fields: CheckoutFieldInfo[];
  custom_product_tabs: string[];
  custom_product_fields: string[];
  custom_email_templates: string[];
  enqueued_scripts: EnqueuedAssetInfo[];
  page_templates: PageTemplateInfo[];
  gutenberg_blocks: string[];
  custom_widgets: string[];
  custom_post_types: string[];
  custom_taxonomies: string[];
  shortcodes: string[];
  theme_json_data?: ThemeJsonSummary;
  composer_dependencies: string[];
  npm_dependencies: string[];
  js_source_files: JSSourceFileInfo[];

  // Enriched detail (for accurate test case generation)
  post_type_details: PostTypeDetail[];
  taxonomy_details: TaxonomyDetail[];
  shortcode_details: ShortcodeDetail[];
  checkout_field_details: CheckoutFieldDetail[];
  hook_callbacks: HookCallbackDetail[];
  feature_map: FeatureDescription[];
}

export interface CodeIssue {
  severity: 'critical' | 'major' | 'minor';
  file: string;
  issue: string;
  recommendation: string;
}

export interface RestEndpointInfo {
  namespace: string;
  route: string;
  methods: string;
  file: string;
}

export interface AjaxHandlerInfo {
  action: string;
  is_nopriv: boolean;
  file: string;
}

export interface CheckoutFieldInfo {
  hook: string;
  file: string;
}

export interface EnqueuedAssetInfo {
  handle: string;
  src_pattern: string;
  file: string;
  is_conditional: boolean;
}

export interface PageTemplateInfo {
  name: string;
  file: string;
}

export interface ThemeJsonSummary {
  version: number;
  has_custom_templates: boolean;
  has_template_parts: boolean;
  custom_color_palette: boolean;
  custom_font_sizes: boolean;
}

export interface JSSourceFileInfo {
  file: string;
  size_bytes: number;
  features: string[];
}

// ── Enriched Code Detail (for accurate test cases) ───────────────────────

export interface PostTypeDetail {
  slug: string;
  label?: string;
  plural_label?: string;
  has_archive: boolean;
  public: boolean;
  supports: string[];
  file: string;
}

export interface TaxonomyDetail {
  slug: string;
  label?: string;
  object_types: string[];
  hierarchical: boolean;
  file: string;
}

export interface ShortcodeDetail {
  tag: string;
  file: string;
  callback: string;
  accepted_attributes: string[];
  renders_html: boolean;
  uses_query: boolean;
  description: string;
}

export interface CheckoutFieldDetail {
  hook: string;
  file: string;
  fields: {
    name: string;
    type: string;
    label: string;
    required: boolean;
    validation?: string;
  }[];
  condition?: string;    // e.g. "only for logged-in users", "only when shipping differs"
  description: string;
}

export interface HookCallbackDetail {
  hook: string;
  callback: string;
  file: string;
  priority?: number;
  summary: string;       // what the callback does in plain English
  modifies: string[];    // what it changes (e.g. "adds CSS class", "removes field", "changes price display")
  condition?: string;    // conditional logic wrapping the callback
}

export interface FeatureDescription {
  name: string;
  type: 'checkout' | 'product' | 'cart' | 'account' | 'navigation' | 'content' | 'integration' | 'email' | 'admin';
  description: string;
  how_to_test: string;
  pages: string[];       // which pages to test on
  code_files: string[];
  depends_on?: string[]; // plugins or other features it depends on
}

// ── Accessibility Audit ──────────────────────────────────────────────────

export interface AccessibilityResult {
  pages_tested: number;
  total_issues: number;
  issues: AccessibilityIssue[];
  summary: {
    missing_alt_text: number;
    contrast_issues: number;
    missing_labels: number;
    heading_issues: number;
    focus_issues: number;
    aria_issues: number;
    touch_target_issues: number;
    skip_link_present: boolean;
  };
}

export interface AccessibilityIssue {
  type:
    | 'missing-alt'
    | 'contrast'
    | 'missing-label'
    | 'heading-hierarchy'
    | 'focus-indicator'
    | 'aria'
    | 'touch-target'
    | 'skip-link'
    | 'tab-order';
  severity: 'critical' | 'major' | 'minor';
  page: string;
  element?: string;
  detail: string;
  wcag_criterion?: string;
}

// ── Security Scanning ────────────────────────────────────────────────────

export interface SecurityResult {
  overall_risk: 'low' | 'medium' | 'high' | 'critical';
  findings: SecurityFinding[];
  headers: SecurityHeaders;
  exposed_files: ExposedFile[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
    info: number;
  };
}

export interface SecurityFinding {
  id: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  title: string;
  detail: string;
  recommendation: string;
}

export interface SecurityHeaders {
  x_frame_options?: string;
  content_security_policy?: string;
  x_content_type_options?: string;
  strict_transport_security?: string;
  x_xss_protection?: string;
  referrer_policy?: string;
  permissions_policy?: string;
}

export interface ExposedFile {
  path: string;
  status: number;
  risk: string;
}

// ── Performance Deep-Dive ────────────────────────────────────────────────

export interface PerformanceDeepDiveResult {
  pages: PagePerformanceDetail[];
  third_party_audit: ThirdPartyScript[];
  compression: CompressionCheck;
  cache_headers: CacheHeaderCheck[];
  font_loading: FontLoadingCheck[];
  total_issues: number;
}

export interface PagePerformanceDetail {
  page: string;
  url: string;
  total_weight_bytes: number;
  html_bytes: number;
  css_bytes: number;
  js_bytes: number;
  image_bytes: number;
  font_bytes: number;
  other_bytes: number;
  request_count: number;
  render_blocking_count: number;
  ttfb_ms: number;
}

export interface ThirdPartyScript {
  domain: string;
  urls: string[];
  total_size_bytes: number;
  total_duration_ms: number;
  category: string;
}

export interface CompressionCheck {
  gzip_enabled: boolean;
  brotli_enabled: boolean;
  uncompressed_resources: string[];
}

export interface CacheHeaderCheck {
  url: string;
  cache_control?: string;
  has_cache: boolean;
  type: string;
}

export interface FontLoadingCheck {
  url: string;
  display_strategy: string;
  format: string;
  size_bytes?: number;
  is_preloaded: boolean;
}

// ── WordPress Core Health ────────────────────────────────────────────────

export interface WPCoreHealthResult {
  wp_version: string;
  wp_version_status: 'current' | 'outdated' | 'insecure' | 'unknown';
  php_version?: string;
  php_version_status?: 'current' | 'outdated' | 'eol' | 'unknown';
  debug_mode: 'enabled' | 'disabled' | 'unknown';
  error_display: 'enabled' | 'disabled' | 'unknown';
  wp_cron_status: 'enabled' | 'disabled' | 'unknown';
  object_cache: 'redis' | 'memcached' | 'none' | 'unknown';
  memory_limit?: string;
  max_upload_size?: string;
  multisite: boolean;
  ssl_certificate: {
    valid: boolean;
    issuer?: string;
    expires?: string;
    days_until_expiry?: number;
  };
  https_redirect: boolean;
  findings: WPCoreHealthFinding[];
}

export interface WPCoreHealthFinding {
  severity: 'critical' | 'major' | 'minor' | 'info';
  title: string;
  detail: string;
  recommendation?: string;
}

// ── Image Optimization Audit ─────────────────────────────────────────────

export interface ImageAuditResult {
  pages_scanned: number;
  total_images: number;
  oversized_images: OversizedImage[];
  missing_dimensions: MissingDimensionImage[];
  lazy_loading: {
    total_below_fold: number;
    with_lazy_loading: number;
    without_lazy_loading: number;
  };
  format_support: {
    webp_supported: boolean;
    avif_supported: boolean;
    serving_modern_formats: boolean;
  };
  responsive_images: {
    total: number;
    with_srcset: number;
    without_srcset: number;
  };
  total_image_weight_bytes: number;
  optimization_plugin_detected: boolean;
  optimization_plugin_name?: string;
}

export interface OversizedImage {
  url: string;
  page: string;
  size_bytes: number;
  natural_width?: number;
  natural_height?: number;
  display_width?: number;
  display_height?: number;
}

export interface MissingDimensionImage {
  url: string;
  page: string;
  missing: 'width' | 'height' | 'both';
}

// ── Error Log Analysis ──────────────────────────────────────────────────────

export interface ErrorLogResult {
  sources_checked: string[];
  sources_accessible: string[];
  total_entries: number;
  entries: ErrorLogEntry[];
  grouped: ErrorLogGroup[];
  severity_counts: {
    fatal: number;
    error: number;
    warning: number;
    notice: number;
    deprecated: number;
    parse: number;
    other: number;
  };
  recent_entries: ErrorLogEntry[];  // last 24h (if timestamps available)
  log_size_bytes?: number;
}

export interface ErrorLogEntry {
  level: 'fatal' | 'error' | 'warning' | 'notice' | 'deprecated' | 'parse' | 'other';
  message: string;
  file?: string;
  line?: number;
  timestamp?: string;
  stack_trace?: string[];
  source: string;  // which log file it came from
}

export interface ErrorLogGroup {
  message: string;
  level: ErrorLogEntry['level'];
  count: number;
  files: string[];
  first_seen?: string;
  last_seen?: string;
}

// ── Layer 1 Results (contract between L1 and L2) ──────────────────────────

export interface Layer1Results {
  site: SiteConfig;
  tested_at: string;
  duration_ms: number;
  tester_mode: 'with-code' | 'url-only';

  page_health: PageHealthResult[];
  lighthouse?: LighthouseResult;
  wordpress_health: WordPressHealthResult;
  broken_links: BrokenLink[];
  console_network: ConsoleNetworkResult[];
  code_analysis?: CodeAnalysis;

  accessibility?: AccessibilityResult;
  security?: SecurityResult;
  performance_deep_dive?: PerformanceDeepDiveResult;
  wp_core_health?: WPCoreHealthResult;
  image_audit?: ImageAuditResult;
  error_logs?: ErrorLogResult;
  code_review?: CodeReviewResult;
  form_audit?: import('./layer1/checks/form-audit.js').FormAuditResult;

  layer2_queue: Layer2Investigation[];
  screenshots: string[];
  checks: CheckResult[];
}

export interface Layer2Investigation {
  id: string;
  category: 'visual' | 'flow' | 'anomaly' | 'error-context' | 'ux' | 'code-driven';
  priority: 'high' | 'medium' | 'low';
  trigger: string;
  instruction: string;
  context: Record<string, any>;
  pages: string[];
}

// ── Final Report ──────────────────────────────────────────────────────────

export interface Issue {
  id: string;
  title: string;
  description: string;
  location?: string;
  how_to_fix?: string;
  severity: 'blocker' | 'major' | 'minor';
  category:
    | 'performance'
    | 'functionality'
    | 'ui'
    | 'security'
    | 'content'
    | 'seo'
    | 'accessibility'
    | 'code'
    | 'plugins';
}

export interface QAReport {
  site: string;
  url: string;
  tested_at: string;
  duration_ms: number;
  tester_mode: 'with-code' | 'url-only';
  overall_status: 'PASS' | 'WARNING' | 'CRITICAL';
  summary: string;

  blocker_issues: Issue[];
  major_issues: Issue[];
  minor_issues: Issue[];
  code_concerns: Issue[];
  passed_checks: string[];

  lighthouse?: LighthouseResult;
  page_health: PageHealthResult[];
  wordpress_health: WordPressHealthResult;
  broken_links: BrokenLink[];

  total_console_errors: number;
  total_network_failures: number;
  payment_gateway_status: 'loaded' | 'failed' | 'unknown';

  recommendations: string[];
  screenshots: string[];
  raw_data_file: string;
}

// ── Plugin Update System ─────────────────────────────────────────────────

export interface HealthSnapshot {
  timestamp: string;
  page_health: PageHealthResult[];
  console_errors: ConsoleError[];
  network_failures: NetworkFailure[];
  wc_js_state?: WooCommerceJSState;
}

export interface Regression {
  type: 'blocker' | 'major' | 'warning';
  category:
    | 'page-500'
    | 'console-error-checkout'
    | 'wc-js-regression'
    | 'console-error-other'
    | 'load-time'
    | 'network-failure';
  detail: string;
  before: any;
  after: any;
}

export interface PluginUpdateResult {
  plugin: PluginInfo;
  update_type: 'minor' | 'patch' | 'major';
  action: 'updated' | 'skipped-major' | 'failed' | 'deactivated';
  old_version: string;
  new_version: string;
  verified_version?: string;
  baseline: HealthSnapshot;
  post_update?: HealthSnapshot;
  regressions: Regression[];
  duration_ms: number;
  message?: string;
}

export interface UpdateRunResult {
  site: string;
  url: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  total_plugins_with_updates: number;
  results: PluginUpdateResult[];
  halted_early: boolean;
  halt_reason?: string;
  summary: {
    updated: number;
    skipped_major: number;
    failed: number;
    deactivated: number;
  };
}

export interface PluginUpdateCheck {
  plugin: PluginInfo;
  current_version: string;
  available_version: string;
  update_type: 'major' | 'minor' | 'patch';
  auto_updatable: boolean;
  reason?: string;
}

export interface WPCoreUpdateCheck {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  update_type: 'major' | 'minor' | 'patch' | 'none';
  auto_updatable: boolean;
  reason?: string;
}

export interface CheckUpdatesResult {
  site: string;
  url: string;
  checked_at: string;
  wp_core?: WPCoreUpdateCheck;
  plugins_total: number;
  plugins_with_updates: PluginUpdateCheck[];
  auto_updatable: PluginUpdateCheck[];
  manual_review: PluginUpdateCheck[];
}

// ── WooCommerce Template Updates ─────────────────────────────────────────

export interface WCTemplateOverrideInfo {
  file: string;             // e.g. "cart/cart.php"
  theme_version: string;    // @version in theme's override
  core_version: string;     // @version WC expects
  outdated: boolean;
}

export interface WCTemplateUpdateResult {
  file: string;
  action: 'updated' | 'flagged' | 'failed' | 'skipped';
  theme_version: string;
  core_version: string;
  changes_made: string[];
  manual_review_needed: string[];
  backup_path?: string;
  error?: string;
}

export interface WCTemplateUpdateRunResult {
  site: string;
  project_path: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  total_outdated: number;
  results: WCTemplateUpdateResult[];
  summary: {
    updated: number;
    flagged: number;
    failed: number;
  };
}

// ── Code Review (automated standards check) ──────────────────────────────

export interface CodeReviewFinding {
  rule: string;               // e.g. 'unescaped-output', 'missing-nonce', 'wc-direct-db'
  severity: 'critical' | 'high' | 'medium' | 'low';
  file: string;
  line: number;
  code_snippet: string;       // The offending line (trimmed)
  message: string;            // Human-readable description
  fix: string;                // How to fix it
  checklist: string;          // Which review checklist this belongs to
}

export interface CodeReviewResult {
  files_scanned: number;
  php_files_scanned: number;
  js_files_scanned: number;
  total_findings: number;
  findings: CodeReviewFinding[];
  summary: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  checklists_applied: string[];
}

// ── Fixable Issues (structured for AI consumption) ────────────────────────

export interface FixableIssue {
  id: string;
  severity: 'blocker' | 'major' | 'minor';
  category:
    | 'security'
    | 'performance'
    | 'functionality'
    | 'accessibility'
    | 'woocommerce'
    | 'plugins'
    | 'wordpress'
    | 'code'
    | 'content';
  fix_type:
    | 'code'      // Requires file changes in theme/plugin
    | 'config'    // wp-config.php or settings change
    | 'server'    // Server/hosting configuration (headers, PHP, SSL)
    | 'plugin'    // Install, update, or configure a plugin
    | 'content';  // Content changes via WP admin editor
  title: string;
  problem: string;
  fix: string;
  location: string;       // URL, file path, or plugin slug
  code_files?: string[];  // Relevant source files (from code analysis)
}

// ── Run Options ───────────────────────────────────────────────────────────

export interface RunOptions {
  skipBrowser?: boolean;
  skipLighthouse?: boolean;
  mobileOnly?: boolean;
  outputDir?: string;
}
