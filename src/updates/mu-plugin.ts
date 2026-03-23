/**
 * WP QA Agent mu-plugin: a tiny REST API endpoint for plugin updates.
 *
 * This file generates and installs a must-use plugin that gives
 * wp-qa-agent the ability to update plugins on ANY WordPress host
 * using only application password authentication.
 *
 * The mu-plugin registers:
 *   POST /wp-qa/v1/update-plugin   {plugin_file}     — trigger update
 *   POST /wp-qa/v1/backup-plugin   {plugin_file}     — backup before update
 *   POST /wp-qa/v1/revert-plugin   {backup_id, plugin_file} — revert from backup
 *   POST /wp-qa/v1/cleanup-backup  {backup_id}       — delete a backup
 *
 * All endpoints require `update_plugins` capability (admin role).
 */

import fs from 'fs/promises';
import path from 'path';
import { SiteConfig } from '../types.js';
import { baseUrl, getAuthHeader, logger } from '../utils.js';

const MU_PLUGIN_FILENAME = 'site-qa-updater.php';

const MU_PLUGIN_CODE = `<?php
/**
 * Plugin Name: WP QA Agent Updater
 * Description: REST API endpoints for wp-qa-agent plugin updates. Safe to remove when not needed.
 * Version: 1.0.0
 * Author: wp-qa-agent
 */

if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'rest_api_init', function() {

    // ── Update a plugin ─────────────────────────────────────────────────
    register_rest_route( 'wp-qa/v1', '/update-plugin', array(
        'methods'  => 'POST',
        'callback' => function( $request ) {
            require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
            require_once ABSPATH . 'wp-admin/includes/plugin.php';
            require_once ABSPATH . 'wp-admin/includes/file.php';
            require_once ABSPATH . 'wp-admin/includes/misc.php';

            $plugin_file = $request->get_param( 'plugin_file' );
            if ( ! $plugin_file ) {
                return new WP_Error( 'missing_param', 'plugin_file is required', array( 'status' => 400 ) );
            }

            // Verify plugin exists
            $plugin_path = WP_PLUGIN_DIR . '/' . $plugin_file;
            if ( ! file_exists( $plugin_path ) ) {
                return new WP_Error( 'not_found', 'Plugin file not found', array( 'status' => 404 ) );
            }

            $was_active = is_plugin_active( $plugin_file );

            // Run the upgrader (same mechanism as "Update Now" button)
            $skin = new Automatic_Upgrader_Skin();
            $upgrader = new Plugin_Upgrader( $skin );
            $result = $upgrader->upgrade( $plugin_file );

            if ( is_wp_error( $result ) ) {
                return new WP_Error( 'update_failed', $result->get_error_message(), array( 'status' => 500 ) );
            }

            if ( $result === false ) {
                $errors = $skin->get_upgrade_messages();
                return new WP_Error( 'update_failed', implode( '; ', $errors ) ?: 'Update failed', array( 'status' => 500 ) );
            }

            // Re-activate if it was active before
            if ( $was_active ) {
                activate_plugin( $plugin_file );
            }

            $plugin_data = get_plugin_data( WP_PLUGIN_DIR . '/' . $plugin_file );
            return array(
                'success' => true,
                'message' => 'Plugin updated successfully',
                'version' => $plugin_data['Version'],
            );
        },
        'permission_callback' => function() {
            return current_user_can( 'update_plugins' );
        },
    ));

    // ── Backup a plugin before updating ─────────────────────────────────
    register_rest_route( 'wp-qa/v1', '/backup-plugin', array(
        'methods'  => 'POST',
        'callback' => function( $request ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $plugin_file = $request->get_param( 'plugin_file' );
            if ( ! $plugin_file ) {
                return new WP_Error( 'missing_param', 'plugin_file is required', array( 'status' => 400 ) );
            }

            $plugin_data = get_plugin_data( WP_PLUGIN_DIR . '/' . $plugin_file );
            $slug = dirname( $plugin_file );
            $version = $plugin_data['Version'];
            $backup_id = $slug . '-v' . $version;

            $backup_dir = WP_CONTENT_DIR . '/wp-qa-backups';
            $backup_path = $backup_dir . '/' . $backup_id;

            if ( ! file_exists( $backup_dir ) ) {
                wp_mkdir_p( $backup_dir );
                // Protect backup directory
                file_put_contents( $backup_dir . '/.htaccess', 'Deny from all' );
                file_put_contents( $backup_dir . '/index.php', '<?php // Silence is golden.' );
            }

            if ( file_exists( $backup_path ) ) {
                return array( 'success' => true, 'backup_id' => $backup_id, 'version' => $version, 'message' => 'Backup already exists' );
            }

            $source = WP_PLUGIN_DIR . '/' . $slug;
            if ( ! file_exists( $source ) ) {
                return new WP_Error( 'not_found', 'Plugin directory not found', array( 'status' => 404 ) );
            }

            WP_Filesystem();
            global $wp_filesystem;
            $copy_result = copy_dir( $source, $backup_path );

            if ( is_wp_error( $copy_result ) ) {
                return new WP_Error( 'backup_failed', $copy_result->get_error_message(), array( 'status' => 500 ) );
            }

            return array( 'success' => true, 'backup_id' => $backup_id, 'version' => $version );
        },
        'permission_callback' => function() {
            return current_user_can( 'update_plugins' );
        },
    ));

    // ── Revert a plugin from backup ─────────────────────────────────────
    register_rest_route( 'wp-qa/v1', '/revert-plugin', array(
        'methods'  => 'POST',
        'callback' => function( $request ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $backup_id = $request->get_param( 'backup_id' );
            $plugin_file = $request->get_param( 'plugin_file' );

            if ( ! $backup_id || ! $plugin_file ) {
                return new WP_Error( 'missing_param', 'backup_id and plugin_file are required', array( 'status' => 400 ) );
            }

            $backup_path = WP_CONTENT_DIR . '/wp-qa-backups/' . $backup_id;
            if ( ! file_exists( $backup_path ) ) {
                return new WP_Error( 'not_found', 'Backup not found: ' . $backup_id, array( 'status' => 404 ) );
            }

            $slug = dirname( $plugin_file );
            $plugin_dir = WP_PLUGIN_DIR . '/' . $slug;
            $was_active = is_plugin_active( $plugin_file );

            // Deactivate before replacing files
            if ( $was_active ) {
                deactivate_plugins( $plugin_file );
            }

            WP_Filesystem();
            global $wp_filesystem;

            // Remove current version
            $wp_filesystem->delete( $plugin_dir, true );

            // Copy backup to plugin dir
            $copy_result = copy_dir( $backup_path, $plugin_dir );
            if ( is_wp_error( $copy_result ) ) {
                return new WP_Error( 'revert_failed', $copy_result->get_error_message(), array( 'status' => 500 ) );
            }

            // Re-activate
            if ( $was_active ) {
                activate_plugin( $plugin_file );
            }

            $plugin_data = get_plugin_data( WP_PLUGIN_DIR . '/' . $plugin_file );
            return array(
                'success' => true,
                'message' => 'Plugin reverted to ' . $plugin_data['Version'],
                'version' => $plugin_data['Version'],
            );
        },
        'permission_callback' => function() {
            return current_user_can( 'update_plugins' );
        },
    ));

    // ── Clean up a backup ───────────────────────────────────────────────
    register_rest_route( 'wp-qa/v1', '/cleanup-backup', array(
        'methods'  => 'POST',
        'callback' => function( $request ) {
            require_once ABSPATH . 'wp-admin/includes/file.php';

            $backup_id = $request->get_param( 'backup_id' );
            if ( ! $backup_id ) {
                return new WP_Error( 'missing_param', 'backup_id is required', array( 'status' => 400 ) );
            }

            $backup_path = WP_CONTENT_DIR . '/wp-qa-backups/' . $backup_id;
            if ( ! file_exists( $backup_path ) ) {
                return array( 'success' => true, 'message' => 'Backup already removed' );
            }

            WP_Filesystem();
            global $wp_filesystem;
            $wp_filesystem->delete( $backup_path, true );

            return array( 'success' => true, 'message' => 'Backup cleaned up' );
        },
        'permission_callback' => function() {
            return current_user_can( 'update_plugins' );
        },
    ));
});
`;

/**
 * Check if the wp-qa mu-plugin is installed on the target site.
 */
export async function isHelperInstalled(
  config: SiteConfig,
  targetUrl: string
): Promise<boolean> {
  const base = baseUrl(targetUrl);
  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    Authorization: getAuthHeader(config.username!, config.app_password!),
  };

  try {
    const res = await fetch(`${base}/wp-json/wp-qa/v1/update-plugin`, {
      method: 'OPTIONS',
      headers,
      signal: AbortSignal.timeout(10000),
    });
    // If we get anything other than 404, the route exists
    return res.status !== 404;
  } catch {
    return false;
  }
}

/**
 * Install the mu-plugin to the local project path.
 * The user's deployment process will sync it to the server.
 */
export async function installHelperLocally(
  projectPath: string
): Promise<{ success: boolean; path: string; message: string }> {
  // Find wp-content/mu-plugins directory
  const muPluginsDir = await findMuPluginsDir(projectPath);
  if (!muPluginsDir) {
    return {
      success: false,
      path: '',
      message: `Could not find wp-content/mu-plugins in ${projectPath}. Create the directory first.`,
    };
  }

  const filePath = path.join(muPluginsDir, MU_PLUGIN_FILENAME);

  try {
    await fs.writeFile(filePath, MU_PLUGIN_CODE, 'utf-8');
    return {
      success: true,
      path: filePath,
      message: `Installed to ${filePath}. Deploy to your server to activate.`,
    };
  } catch (err: any) {
    return {
      success: false,
      path: filePath,
      message: `Failed to write: ${err.message}`,
    };
  }
}

/**
 * Get the mu-plugin PHP code (for manual installation).
 */
export function getHelperCode(): string {
  return MU_PLUGIN_CODE;
}

/**
 * Remove the wp-qa mu-plugin after updates are complete.
 * Cleans up so it doesn't stay on the server permanently.
 */
export async function cleanupHelper(projectPath: string): Promise<void> {
  const muDir = await findMuPluginsDir(projectPath);
  if (!muDir) return;

  const filePath = path.join(muDir, MU_PLUGIN_FILENAME);
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
    logger.dim('  Cleaned up wp-qa helper mu-plugin');
  } catch {
    // File doesn't exist or can't be deleted — that's fine
  }
}

async function findMuPluginsDir(projectPath: string): Promise<string | null> {
  // Try common locations
  const candidates = [
    path.join(projectPath, 'wp-content', 'mu-plugins'),
    path.join(projectPath, '..', 'mu-plugins'),
    path.join(projectPath, '..', '..', 'wp-content', 'mu-plugins'),
    path.join(projectPath, '..', '..', '..', 'wp-content', 'mu-plugins'),
  ];

  for (const dir of candidates) {
    try {
      const stat = await fs.stat(dir);
      if (stat.isDirectory()) return dir;
    } catch { /* not found */ }
  }

  // Try to create it in the most likely location
  const wpContent = path.join(projectPath, 'wp-content');
  try {
    const stat = await fs.stat(wpContent);
    if (stat.isDirectory()) {
      const muDir = path.join(wpContent, 'mu-plugins');
      await fs.mkdir(muDir, { recursive: true });
      return muDir;
    }
  } catch { /* no wp-content */ }

  // Try parent directories
  let current = projectPath;
  for (let i = 0; i < 5; i++) {
    const wpContentCheck = path.join(current, 'wp-content');
    try {
      const stat = await fs.stat(wpContentCheck);
      if (stat.isDirectory()) {
        const muDir = path.join(wpContentCheck, 'mu-plugins');
        await fs.mkdir(muDir, { recursive: true });
        return muDir;
      }
    } catch { /* keep looking */ }
    current = path.dirname(current);
  }

  return null;
}
