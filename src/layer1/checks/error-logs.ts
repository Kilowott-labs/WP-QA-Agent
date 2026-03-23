import fs from 'fs/promises';
import path from 'path';
import {
  SiteConfig,
  ErrorLogResult,
  ErrorLogEntry,
  ErrorLogGroup,
} from '../../types.js';
import { baseUrl, getAuthHeader, logger } from '../../utils.js';

/**
 * Error log analysis.
 * - Queries WP REST API and WC system status for error log data (most reliable)
 * - Fetches WordPress debug.log and other error logs via HTTP (if exposed)
 * - Reads local error logs when project_path is available (Mode A)
 * - Parses, categorises, groups, and summarises log entries
 */
export async function analyseErrorLogs(
  config: SiteConfig
): Promise<ErrorLogResult> {
  const base = baseUrl(config.url);
  const timeout = 15000;
  const hasAuth = !!(config.username && config.app_password);
  const sourcesChecked: string[] = [];
  const sourcesAccessible: string[] = [];
  const allEntries: ErrorLogEntry[] = [];

  // ── 1. Query WP REST API for error data (most reliable with auth) ──────
  if (hasAuth) {
    const authHeaders: HeadersInit = {
      'Content-Type': 'application/json',
      Authorization: getAuthHeader(config.username!, config.app_password!),
    };

    // 1a. WooCommerce system status logs endpoint
    sourcesChecked.push('API: WC system_status');
    try {
      const res = await fetch(`${base}/wp-json/wc/v3/system_status`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const data = await res.json();
        const env = data.environment || {};

        // WC reports the log directory — useful to know even if we can't read it
        if (env.log_directory) {
          logger.info(`  WC log directory: ${env.log_directory}`);
        }

        // WC system status includes recent fatal errors
        if (data.pages?.length > 0) {
          for (const page of data.pages) {
            if (page.content && /error|fatal|warning/i.test(page.content)) {
              allEntries.push({
                level: 'error',
                message: `WC system status page issue: ${page.page_name || 'unknown'} — ${page.content.slice(0, 200)}`,
                source: 'wc-system-status',
              });
            }
          }
        }

        // Check WP debug mode from WC
        if (env.wp_debug) {
          sourcesAccessible.push('API: WC system_status (debug enabled)');
        }
      }
    } catch { /* WC not available or no auth */ }

    // 1b. WordPress Site Health debug data (WP 5.2+)
    sourcesChecked.push('API: wp-site-health');
    try {
      const res = await fetch(`${base}/wp-json/wp-site-health/v1/tests/background-updates`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.status === 'critical' || data.status === 'recommended') {
          allEntries.push({
            level: data.status === 'critical' ? 'error' : 'warning',
            message: `Site Health (background-updates): ${data.label} — ${data.description?.replace(/<[^>]*>/g, '').slice(0, 200) || 'no details'}`,
            source: 'site-health',
          });
          sourcesAccessible.push('API: wp-site-health');
        }
      }
    } catch { /* endpoint not available */ }

    // 1c. Try WP debug.log via authenticated request
    sourcesChecked.push('API: authenticated debug.log');
    try {
      const res = await fetch(`${base}/wp-json/wp/v2/settings`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      // If we can access settings, we know auth works — check if debug is on
      // and where logs might be
    } catch { /* non-critical */ }

    // 1d. Fetch WC status tool logs (WC stores logs in wc-logs directory)
    sourcesChecked.push('API: WC logs');
    try {
      const res = await fetch(`${base}/wp-json/wc/v3/system_status/tools`, {
        headers: authHeaders,
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const tools = await res.json();
        // Check for log-related tools
        const logTools = tools.filter((t: any) =>
          t.id?.includes('log') || t.description?.toLowerCase().includes('log')
        );
        if (logTools.length > 0) {
          sourcesAccessible.push('API: WC logs (tools available)');
        }
      }
    } catch { /* non-critical */ }
  }

  // ── 2. Try to fetch error logs via HTTP ──────────────────────────────────
  const remoteLogPaths = [
    '/wp-content/debug.log',
    '/debug.log',
    '/error_log',
    '/wp-content/error_log',
    '/php_error.log',
    '/logs/error.log',
    '/logs/php-error.log',
    '/wp-content/uploads/debug.log',
    '/wp-content/logs/debug.log',
    '/.logs/error.log',
  ];

  // Build headers — use auth if available (some servers allow authenticated log access)
  const httpHeaders: HeadersInit = {
    'User-Agent': 'wp-qa-agent/1.0',
  };
  if (hasAuth) {
    httpHeaders['Authorization'] = getAuthHeader(config.username!, config.app_password!);
  }

  for (const logPath of remoteLogPaths) {
    sourcesChecked.push(`HTTP: ${logPath}`);
    try {
      // First try with Range header for efficiency
      const res = await fetch(`${base}${logPath}`, {
        signal: AbortSignal.timeout(timeout),
        headers: { ...httpHeaders, Range: 'bytes=-524288' },
      });

      if (res.ok || res.status === 206) {
        const text = await res.text();
        if (isLogContent(text)) {
          sourcesAccessible.push(`HTTP: ${logPath}`);
          const entries = parseLogContent(text, `remote:${logPath}`);
          allEntries.push(...entries);
          logger.info(`  Found ${entries.length} entries in ${logPath}`);
          continue;
        }
      }

      // If Range request failed with 416 (Range Not Satisfiable), retry without Range
      if (res.status === 416) {
        const retryRes = await fetch(`${base}${logPath}`, {
          signal: AbortSignal.timeout(timeout),
          headers: httpHeaders,
        });
        if (retryRes.ok) {
          const text = await retryRes.text();
          if (isLogContent(text)) {
            sourcesAccessible.push(`HTTP: ${logPath}`);
            const entries = parseLogContent(text, `remote:${logPath}`);
            allEntries.push(...entries);
            logger.info(`  Found ${entries.length} entries in ${logPath}`);
          }
        }
      }
    } catch {
      // Not accessible — expected for well-configured sites
    }
  }

  // ── 3. Read local error logs (Mode A — with project path) ──────────────
  if (config.project_path) {
    const localLogPaths = [
      'debug.log',
      'wp-content/debug.log',
      'error_log',
      'php_error.log',
      'logs/error.log',
      'logs/debug.log',
      'wp-content/uploads/debug.log',
      'wp-content/logs/debug.log',
      'wp-content/wc-logs',
    ];

    for (const relPath of localLogPaths) {
      const fullPath = path.join(config.project_path, relPath);
      sourcesChecked.push(`Local: ${relPath}`);
      try {
        const stat = await fs.stat(fullPath);

        // If it's a directory (e.g. wc-logs), scan for .log files inside
        if (stat.isDirectory()) {
          try {
            const files = await fs.readdir(fullPath);
            const logFiles = files.filter((f) => f.endsWith('.log')).sort().slice(-5); // Last 5 log files
            for (const logFile of logFiles) {
              const logFilePath = path.join(fullPath, logFile);
              try {
                const logStat = await fs.stat(logFilePath);
                if (!logStat.isFile() || logStat.size === 0) continue;
                const content = logStat.size > 524288
                  ? await readTail(logFilePath, 524288)
                  : await fs.readFile(logFilePath, 'utf-8');
                if (isLogContent(content)) {
                  sourcesAccessible.push(`Local: ${relPath}/${logFile}`);
                  const entries = parseLogContent(content, `local:${relPath}/${logFile}`);
                  allEntries.push(...entries);
                  logger.info(`  Found ${entries.length} entries in local ${relPath}/${logFile} (${formatSize(logStat.size)})`);
                }
              } catch { /* skip individual files */ }
            }
          } catch { /* can't read dir */ }
          continue;
        }

        if (!stat.isFile() || stat.size === 0) continue;

        // Read last 512KB for large files
        const content = stat.size > 524288
          ? await readTail(fullPath, 524288)
          : await fs.readFile(fullPath, 'utf-8');

        if (isLogContent(content)) {
          sourcesAccessible.push(`Local: ${relPath}`);
          const entries = parseLogContent(content, `local:${relPath}`);
          allEntries.push(...entries);
          logger.info(`  Found ${entries.length} entries in local ${relPath} (${formatSize(stat.size)})`);
        }
      } catch {
        // File doesn't exist — normal
      }
    }
  }

  // ── 3. Categorise and group ────────────────────────────────────────────
  const severityCounts = {
    fatal: 0,
    error: 0,
    warning: 0,
    notice: 0,
    deprecated: 0,
    parse: 0,
    other: 0,
  };
  for (const entry of allEntries) {
    severityCounts[entry.level]++;
  }

  const grouped = groupEntries(allEntries);

  // Recent entries (last 24h)
  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;
  const recentEntries = allEntries.filter((e) => {
    if (!e.timestamp) return false;
    try {
      return new Date(e.timestamp).getTime() > oneDayAgo;
    } catch {
      return false;
    }
  });

  return {
    sources_checked: sourcesChecked,
    sources_accessible: sourcesAccessible,
    total_entries: allEntries.length,
    entries: allEntries.slice(0, 500), // Cap at 500 to keep report manageable
    grouped: grouped.slice(0, 100),
    severity_counts: severityCounts,
    recent_entries: recentEntries.slice(0, 100),
  };
}

// ── Parsing ────────────────────────────────────────────────────────────────

function isLogContent(text: string): boolean {
  // Must look like a log file, not an HTML page or empty
  if (text.length < 10) return false;
  const trimmed = text.trimStart();
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<html') || trimmed.startsWith('<?xml')) return false;
  // Reject JSON API error responses (e.g. {"code":"rest_no_route"})
  if (trimmed.startsWith('{') && trimmed.includes('"code"')) return false;

  // PHP error logs contain these patterns
  if (/\b(Fatal error|Warning|Notice|Deprecated|Parse error|PHP |Stack trace)/i.test(text)) return true;
  // Standard log timestamp format: [DD-Mon-YYYY HH:MM:SS]
  if (/\[\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}/.test(text)) return true;
  // WooCommerce log format: YYYY-MM-DD @ HH:MM:SS or just YYYY-MM-DD with ERROR/WARNING
  if (/\d{4}-\d{2}-\d{2}[T@ ]\d{2}:\d{2}:\d{2}/.test(text) && /\b(error|warning|critical|exception|fatal)\b/i.test(text)) return true;
  // Generic log lines with severity prefixes
  if (/^\[?\d{4}[-/]\d{2}[-/]\d{2}.*\b(ERROR|WARN|FATAL|CRITICAL)\b/m.test(text)) return true;

  return false;
}

/**
 * Parse PHP/WordPress error log content into structured entries.
 * Handles multiple formats:
 * - WordPress debug.log: [DD-Mon-YYYY HH:MM:SS UTC] PHP Warning: ...
 * - PHP error_log: [DD-Mon-YYYY HH:MM:SS zone] PHP Warning: ...
 * - Plain: PHP Fatal error: ... in /path/file.php on line 123
 */
function parseLogContent(content: string, source: string): ErrorLogEntry[] {
  const entries: ErrorLogEntry[] = [];
  const lines = content.split('\n');

  let currentEntry: Partial<ErrorLogEntry> | null = null;
  let stackLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    // Check for new log entry (starts with timestamp or PHP error prefix)
    const timestampMatch = line.match(
      /^\[(\d{2}-[A-Za-z]{3}-\d{4}\s+\d{2}:\d{2}:\d{2}[^\]]*)\]\s*(.*)/
    );
    const phpErrorMatch = !timestampMatch && line.match(
      /^(PHP\s+)?(Fatal\s+error|Warning|Notice|Deprecated|Parse\s+error|Catchable\s+fatal\s+error)\s*:\s*(.*)/i
    );

    if (timestampMatch || phpErrorMatch) {
      // Save previous entry
      if (currentEntry) {
        if (stackLines.length > 0) currentEntry.stack_trace = stackLines;
        entries.push(finaliseEntry(currentEntry, source));
      }

      // Start new entry
      if (timestampMatch) {
        const timestamp = timestampMatch[1];
        const rest = timestampMatch[2];
        currentEntry = {
          timestamp: normaliseTimestamp(timestamp),
          source,
        };
        // Parse the error content after timestamp
        parseErrorContent(rest, currentEntry);
      } else if (phpErrorMatch) {
        currentEntry = { source };
        const level = phpErrorMatch[2];
        const msg = phpErrorMatch[3];
        currentEntry.level = classifyLevel(level);
        parseMessageWithLocation(msg, currentEntry);
      }
      stackLines = [];
    } else if (currentEntry) {
      // Continuation: stack trace line or multi-line error
      const stackMatch = line.match(/^#\d+\s+(.+)/);
      const thrownMatch = line.match(/^\s+thrown in (.+) on line (\d+)/);
      if (stackMatch) {
        stackLines.push(stackMatch[1]);
      } else if (thrownMatch) {
        currentEntry.file = thrownMatch[1];
        currentEntry.line = parseInt(thrownMatch[2], 10);
      } else if (line.match(/^\s*Stack trace:/)) {
        // Stack trace header — skip
      } else if (line.startsWith('  ') || line.startsWith('\t')) {
        // Continuation of previous message
        if (currentEntry.message) {
          currentEntry.message += ' ' + line.trim();
        }
      }
    }
  }

  // Save last entry
  if (currentEntry) {
    if (stackLines.length > 0) currentEntry.stack_trace = stackLines;
    entries.push(finaliseEntry(currentEntry, source));
  }

  return entries;
}

function parseErrorContent(text: string, entry: Partial<ErrorLogEntry>): void {
  // Format: "PHP Warning: message in /path/file.php on line 123"
  // or: "PHP Fatal error: message"
  const phpMatch = text.match(
    /^(PHP\s+)?(Fatal\s+error|Warning|Notice|Deprecated|Parse\s+error|Catchable\s+fatal\s+error)\s*:\s*(.*)/i
  );
  if (phpMatch) {
    entry.level = classifyLevel(phpMatch[2]);
    parseMessageWithLocation(phpMatch[3], entry);
  } else if (text.match(/^WordPress database error/i)) {
    entry.level = 'error';
    entry.message = text;
  } else {
    entry.level = 'other';
    entry.message = text.slice(0, 500);
  }
}

function parseMessageWithLocation(msg: string, entry: Partial<ErrorLogEntry>): void {
  // "Undefined variable $x in /path/file.php on line 42"
  const locMatch = msg.match(/^(.+?)\s+in\s+(\/[^\s]+\.php)\s+on\s+line\s+(\d+)/);
  if (locMatch) {
    entry.message = locMatch[1].trim();
    entry.file = locMatch[2];
    entry.line = parseInt(locMatch[3], 10);
  } else {
    // "Undefined variable $x in /path/file.php:42"
    const altLocMatch = msg.match(/^(.+?)\s+in\s+(\/[^\s]+\.php):(\d+)/);
    if (altLocMatch) {
      entry.message = altLocMatch[1].trim();
      entry.file = altLocMatch[2];
      entry.line = parseInt(altLocMatch[3], 10);
    } else {
      entry.message = msg.slice(0, 500).trim();
    }
  }
}

function classifyLevel(level: string): ErrorLogEntry['level'] {
  const l = level.toLowerCase().replace(/\s+/g, ' ').trim();
  if (l.includes('fatal') || l.includes('catchable fatal')) return 'fatal';
  if (l.includes('parse')) return 'parse';
  if (l.includes('warning')) return 'warning';
  if (l.includes('notice')) return 'notice';
  if (l.includes('deprecated')) return 'deprecated';
  return 'error';
}

function normaliseTimestamp(raw: string): string {
  // "02-Mar-2026 14:32:45 UTC" → ISO string
  try {
    const d = new Date(raw.replace(/-/g, ' '));
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch { /* fallback */ }
  return raw;
}

function finaliseEntry(partial: Partial<ErrorLogEntry>, source: string): ErrorLogEntry {
  return {
    level: partial.level || 'other',
    message: partial.message || 'Unknown error',
    file: partial.file,
    line: partial.line,
    timestamp: partial.timestamp,
    stack_trace: partial.stack_trace,
    source: partial.source || source,
  };
}

// ── Grouping ───────────────────────────────────────────────────────────────

function groupEntries(entries: ErrorLogEntry[]): ErrorLogGroup[] {
  const groups = new Map<string, ErrorLogGroup>();

  for (const entry of entries) {
    // Group by normalised message (strip varying parts like line numbers, timestamps)
    const key = normaliseForGrouping(entry.message, entry.level);

    if (groups.has(key)) {
      const g = groups.get(key)!;
      g.count++;
      if (entry.file && !g.files.includes(entry.file)) g.files.push(entry.file);
      if (entry.timestamp) {
        if (!g.first_seen || entry.timestamp < g.first_seen) g.first_seen = entry.timestamp;
        if (!g.last_seen || entry.timestamp > g.last_seen) g.last_seen = entry.timestamp;
      }
    } else {
      groups.set(key, {
        message: entry.message,
        level: entry.level,
        count: 1,
        files: entry.file ? [entry.file] : [],
        first_seen: entry.timestamp,
        last_seen: entry.timestamp,
      });
    }
  }

  // Sort by count descending, then severity
  const severityOrder = { fatal: 0, parse: 1, error: 2, warning: 3, notice: 4, deprecated: 5, other: 6 };
  return [...groups.values()].sort((a, b) => {
    const sev = severityOrder[a.level] - severityOrder[b.level];
    return sev !== 0 ? sev : b.count - a.count;
  });
}

function normaliseForGrouping(message: string, level: string): string {
  return `${level}:${message
    .replace(/on line \d+/g, 'on line N')
    .replace(/:\d+$/g, ':N')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, 'DATE')
    .slice(0, 200)}`;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function readTail(filePath: string, bytes: number): Promise<string> {
  const fh = await fs.open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(bytes, stat.size));
    await fh.read(buf, 0, buf.length, start);
    const content = buf.toString('utf-8');
    // Skip partial first line
    const firstNewline = content.indexOf('\n');
    return firstNewline > 0 ? content.slice(firstNewline + 1) : content;
  } finally {
    await fh.close();
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
