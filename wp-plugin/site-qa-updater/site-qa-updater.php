<?php
/**
 * Plugin Name: Site QA Updater
 * Plugin URI: https://wordpress.org/plugins/site-qa-updater/
 * Description: Lightweight REST API endpoints for automated plugin updates, backups, and rollbacks. Designed for CI/CD and QA automation tools. Install, use, remove — no permanent footprint.
 * Version: 1.0.0
 * Requires at least: 5.5
 * Requires PHP: 7.4
 * Author: Site QA Agent
 * Author URI: https://github.com/AiWorkflowsDev
 * License: GPL v2 or later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: site-qa-updater
 *
 * This plugin is meant to be installed temporarily by automation tools.
 * It adds REST API endpoints that use WordPress's built-in Plugin_Upgrader
 * class — the same code that runs when you click "Update Now" in wp-admin.
 *
 * All endpoints require the `update_plugins` capability (administrator role)
 * and work with WordPress Application Passwords.
 *
 * Endpoints:
 *   POST /wp-qa/v1/update-plugin    — Update a plugin to the latest version
 *   POST /wp-qa/v1/backup-plugin    — Backup a plugin before updating
 *   POST /wp-qa/v1/revert-plugin    — Revert a plugin from a backup
 *   POST /wp-qa/v1/cleanup-backup   — Delete a backup
 *   GET  /wp-qa/v1/status           — Check if the helper is active
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SITE_QA_UPDATER_VERSION', '1.0.0' );
define( 'SITE_QA_BACKUP_DIR', WP_CONTENT_DIR . '/wp-qa-backups' );

add_action( 'rest_api_init', 'site_qa_updater_register_routes' );

/**
 * Validate plugin_file parameter to prevent path traversal.
 * Must match pattern: folder-name/file-name.php
 */
function site_qa_updater_validate_plugin_file( $value, $request, $param ) {
	if ( ! is_string( $value ) || empty( $value ) ) {
		return new WP_Error( 'invalid_param', 'plugin_file must be a non-empty string.' );
	}
	// Must contain exactly one slash, no path traversal
	if ( preg_match( '/\.\./', $value ) || substr_count( $value, '/' ) > 1 ) {
		return new WP_Error( 'invalid_param', 'Invalid plugin_file format. Expected: folder/file.php' );
	}
	// Must look like a valid plugin path
	if ( ! preg_match( '/^[\w\-]+\/[\w\-]+(?:\.php)?$/', $value ) ) {
		return new WP_Error( 'invalid_param', 'Invalid plugin_file format. Expected: folder/file.php' );
	}
	return true;
}

function site_qa_updater_register_routes() {

	// ── Status check ────────────────────────────────────────────────────
	register_rest_route( 'wp-qa/v1', '/status', array(
		'methods'             => 'GET',
		'callback'            => function () {
			return array(
				'active'  => true,
				'version' => SITE_QA_UPDATER_VERSION,
			);
		},
		'permission_callback' => function () {
			return current_user_can( 'update_plugins' );
		},
	) );

	// ── Update a plugin ─────────────────────────────────────────────────
	register_rest_route( 'wp-qa/v1', '/update-plugin', array(
		'methods'             => 'POST',
		'callback'            => 'site_qa_updater_update_plugin',
		'permission_callback' => function () {
			return current_user_can( 'update_plugins' );
		},
		'args'                => array(
			'plugin_file' => array(
				'required'          => true,
				'type'              => 'string',
				'description'       => 'Plugin file path relative to plugins directory (e.g. akismet/akismet.php)',
				'sanitize_callback' => 'sanitize_text_field',
				'validate_callback' => 'site_qa_updater_validate_plugin_file',
			),
		),
	) );

	// ── Backup a plugin ─────────────────────────────────────────────────
	register_rest_route( 'wp-qa/v1', '/backup-plugin', array(
		'methods'             => 'POST',
		'callback'            => 'site_qa_updater_backup_plugin',
		'permission_callback' => function () {
			return current_user_can( 'update_plugins' );
		},
		'args'                => array(
			'plugin_file' => array(
				'required'          => true,
				'type'              => 'string',
				'description'       => 'Plugin file path relative to plugins directory',
				'sanitize_callback' => 'sanitize_text_field',
				'validate_callback' => 'site_qa_updater_validate_plugin_file',
			),
		),
	) );

	// ── Revert a plugin from backup ─────────────────────────────────────
	register_rest_route( 'wp-qa/v1', '/revert-plugin', array(
		'methods'             => 'POST',
		'callback'            => 'site_qa_updater_revert_plugin',
		'permission_callback' => function () {
			return current_user_can( 'update_plugins' );
		},
		'args'                => array(
			'backup_id'   => array(
				'required'          => true,
				'type'              => 'string',
				'description'       => 'Backup identifier returned by backup-plugin',
				'sanitize_callback' => 'sanitize_file_name',
			),
			'plugin_file' => array(
				'required'          => true,
				'type'              => 'string',
				'description'       => 'Plugin file path relative to plugins directory',
				'sanitize_callback' => 'sanitize_text_field',
				'validate_callback' => 'site_qa_updater_validate_plugin_file',
			),
		),
	) );

	// ── Clean up a backup ───────────────────────────────────────────────
	register_rest_route( 'wp-qa/v1', '/cleanup-backup', array(
		'methods'             => 'POST',
		'callback'            => 'site_qa_updater_cleanup_backup',
		'permission_callback' => function () {
			return current_user_can( 'update_plugins' );
		},
		'args'                => array(
			'backup_id' => array(
				'required'          => true,
				'type'              => 'string',
				'description'       => 'Backup identifier to delete',
				'sanitize_callback' => 'sanitize_file_name',
			),
		),
	) );
}

/**
 * Update a plugin using WordPress's built-in Plugin_Upgrader.
 * Same mechanism as clicking "Update Now" in wp-admin.
 */
function site_qa_updater_update_plugin( $request ) {
	require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
	require_once ABSPATH . 'wp-admin/includes/plugin.php';
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/misc.php';

	$plugin_file = sanitize_text_field( $request->get_param( 'plugin_file' ) );

	// Validate plugin exists
	$plugin_path = WP_PLUGIN_DIR . '/' . $plugin_file;
	if ( ! file_exists( $plugin_path ) ) {
		return new WP_Error(
			'plugin_not_found',
			'Plugin file not found: ' . $plugin_file,
			array( 'status' => 404 )
		);
	}

	// Remember activation state
	$was_active    = is_plugin_active( $plugin_file );
	$was_network   = is_plugin_active_for_network( $plugin_file );
	$old_data      = get_plugin_data( $plugin_path );
	$old_version   = $old_data['Version'];

	// Force WordPress to check for updates (refresh transient)
	delete_site_transient( 'update_plugins' );
	wp_update_plugins();

	// Run the upgrader
	$skin     = new Automatic_Upgrader_Skin();
	$upgrader = new Plugin_Upgrader( $skin );
	$result   = $upgrader->upgrade( $plugin_file );

	if ( is_wp_error( $result ) ) {
		return new WP_Error(
			'update_failed',
			$result->get_error_message(),
			array( 'status' => 500 )
		);
	}

	if ( false === $result ) {
		// Upgrader returned false — check for messages
		$messages = $skin->get_upgrade_messages();
		return new WP_Error(
			'update_failed',
			! empty( $messages ) ? implode( '; ', $messages ) : 'Update failed — the plugin may already be at the latest version, or the download URL is unavailable (check license for premium plugins).',
			array( 'status' => 500 )
		);
	}

	// Re-activate if it was active
	if ( $was_active ) {
		activate_plugin( $plugin_file, '', $was_network );
	}

	// Get new version
	// Clear the plugin data cache
	if ( function_exists( 'wp_clean_plugins_cache' ) ) {
		wp_clean_plugins_cache();
	}
	$new_data    = get_plugin_data( WP_PLUGIN_DIR . '/' . $plugin_file );
	$new_version = $new_data['Version'];

	return array(
		'success'     => true,
		'message'     => 'Plugin updated successfully',
		'old_version' => $old_version,
		'new_version' => $new_version,
		'active'      => is_plugin_active( $plugin_file ),
	);
}

/**
 * Backup a plugin's files before updating.
 * Stores in wp-content/wp-qa-backups/{slug}-v{version}/
 */
function site_qa_updater_backup_plugin( $request ) {
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/plugin.php';

	$plugin_file = sanitize_text_field( $request->get_param( 'plugin_file' ) );
	$plugin_path = WP_PLUGIN_DIR . '/' . $plugin_file;

	if ( ! file_exists( $plugin_path ) ) {
		return new WP_Error( 'plugin_not_found', 'Plugin not found', array( 'status' => 404 ) );
	}

	$plugin_data = get_plugin_data( $plugin_path );
	$slug        = dirname( $plugin_file );
	$version     = $plugin_data['Version'];
	$backup_id   = sanitize_file_name( $slug . '-v' . $version );
	$backup_path = SITE_QA_BACKUP_DIR . '/' . $backup_id;

	// Create backup directory with protection
	if ( ! file_exists( SITE_QA_BACKUP_DIR ) ) {
		wp_mkdir_p( SITE_QA_BACKUP_DIR );
		WP_Filesystem();
		global $wp_filesystem;
		$wp_filesystem->put_contents( SITE_QA_BACKUP_DIR . '/.htaccess', "Deny from all\n" );
		$wp_filesystem->put_contents( SITE_QA_BACKUP_DIR . '/index.php', '<?php // Silence is golden.' );
	}

	// Skip if already backed up
	if ( file_exists( $backup_path ) ) {
		return array(
			'success'   => true,
			'backup_id' => $backup_id,
			'version'   => $version,
			'message'   => 'Backup already exists',
		);
	}

	// Copy plugin folder
	$source = WP_PLUGIN_DIR . '/' . $slug;
	if ( ! file_exists( $source ) ) {
		return new WP_Error( 'source_not_found', 'Plugin directory not found', array( 'status' => 404 ) );
	}

	WP_Filesystem();
	global $wp_filesystem;

	$copy_result = copy_dir( $source, $backup_path );
	if ( is_wp_error( $copy_result ) ) {
		return new WP_Error( 'backup_failed', $copy_result->get_error_message(), array( 'status' => 500 ) );
	}

	return array(
		'success'   => true,
		'backup_id' => $backup_id,
		'version'   => $version,
	);
}

/**
 * Revert a plugin from a backup.
 */
function site_qa_updater_revert_plugin( $request ) {
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/plugin.php';

	$backup_id   = sanitize_file_name( $request->get_param( 'backup_id' ) );
	$plugin_file = sanitize_text_field( $request->get_param( 'plugin_file' ) );
	$backup_path = SITE_QA_BACKUP_DIR . '/' . $backup_id;

	if ( ! file_exists( $backup_path ) ) {
		return new WP_Error( 'backup_not_found', 'Backup not found: ' . $backup_id, array( 'status' => 404 ) );
	}

	$slug       = dirname( $plugin_file );
	$plugin_dir = WP_PLUGIN_DIR . '/' . $slug;
	$was_active = is_plugin_active( $plugin_file );

	// Deactivate before replacing
	if ( $was_active ) {
		deactivate_plugins( $plugin_file );
	}

	WP_Filesystem();
	global $wp_filesystem;

	// Remove current version
	$wp_filesystem->delete( $plugin_dir, true );

	// Restore from backup
	$copy_result = copy_dir( $backup_path, $plugin_dir );
	if ( is_wp_error( $copy_result ) ) {
		return new WP_Error( 'revert_failed', $copy_result->get_error_message(), array( 'status' => 500 ) );
	}

	// Re-activate
	if ( $was_active ) {
		activate_plugin( $plugin_file );
	}

	if ( function_exists( 'wp_clean_plugins_cache' ) ) {
		wp_clean_plugins_cache();
	}
	$plugin_data = get_plugin_data( WP_PLUGIN_DIR . '/' . $plugin_file );

	return array(
		'success' => true,
		'message' => 'Plugin reverted to v' . $plugin_data['Version'],
		'version' => $plugin_data['Version'],
	);
}

/**
 * Delete a backup.
 */
function site_qa_updater_cleanup_backup( $request ) {
	require_once ABSPATH . 'wp-admin/includes/file.php';

	$backup_id   = sanitize_file_name( $request->get_param( 'backup_id' ) );
	$backup_path = SITE_QA_BACKUP_DIR . '/' . $backup_id;

	if ( ! file_exists( $backup_path ) ) {
		return array( 'success' => true, 'message' => 'Backup already removed' );
	}

	WP_Filesystem();
	global $wp_filesystem;
	$wp_filesystem->delete( $backup_path, true );

	return array( 'success' => true, 'message' => 'Backup cleaned up' );
}
