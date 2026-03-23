=== Site QA Updater ===
Contributors: wpqaagent
Tags: updates, rest-api, automation, ci-cd, plugin-management
Requires at least: 5.5
Tested up to: 6.9
Requires PHP: 7.4
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

REST API endpoints for automated plugin updates, backups, and rollbacks. Built for CI/CD and QA automation.

== Description ==

Site QA Updater adds lightweight REST API endpoints that allow automation tools to update WordPress plugins safely using Application Passwords.

This plugin is designed to be **installed temporarily** by automation tools. It can be installed, used for updates, and removed — all via the REST API with no manual steps.

**What it does:**

* Update plugins to the latest version (uses WordPress's built-in Plugin_Upgrader)
* Backup plugins before updating
* Revert to a backup if an update causes issues
* Clean up backups when no longer needed

**Why this exists:**

The WordPress REST API can install new plugins and activate/deactivate them, but it **cannot trigger version updates** on existing plugins. Every WordPress management tool (ManageWP, MainWP, InfiniteWP) solves this by installing a helper plugin. Site QA Updater is a minimal, open-source helper for this purpose.

**Security:**

* All endpoints require the `update_plugins` capability (administrator role)
* Works with WordPress Application Passwords (no wp-admin login needed)
* No data is collected or sent to external servers
* Backups are stored in `wp-content/site-qa-backups/` with .htaccess protection

**Typical automated workflow:**

1. Install: `POST /wp/v2/plugins {"slug": "site-qa-updater", "status": "active"}`
2. Backup: `POST /wp-qa/v1/backup-plugin {"plugin_file": "akismet/akismet.php"}`
3. Update: `POST /wp-qa/v1/update-plugin {"plugin_file": "akismet/akismet.php"}`
4. Verify: Run your tests
5. If broken: `POST /wp-qa/v1/revert-plugin {"backup_id": "...", "plugin_file": "..."}`
6. Cleanup: `POST /wp-qa/v1/cleanup-backup {"backup_id": "..."}`
7. Remove: `DELETE /wp/v2/plugins/site-qa-updater/site-qa-updater`

== Installation ==

**For automation tools (recommended):**

Install and activate via REST API:
`POST /wp/v2/plugins {"slug": "site-qa-updater", "status": "active"}`

**Manual installation:**

1. Upload the `site-qa-updater` folder to `/wp-content/plugins/`
2. Activate through the Plugins menu in WordPress

== Frequently Asked Questions ==

= Is this safe? =

Yes. It uses WordPress's built-in `Plugin_Upgrader` class — the exact same code that runs when you click "Update Now" in wp-admin. Plugin settings in the database are not affected.

= Can I leave it installed permanently? =

Yes, but it's designed to be temporary. Automation tools typically install it, perform updates, and remove it.

= Does it work with premium plugins? =

Yes, as long as the premium plugin's license is active and its update server is reachable. The upgrader uses whatever update mechanism the plugin has registered.

== Changelog ==

= 1.0.0 =
* Initial release
* Plugin update, backup, revert, and cleanup endpoints
* Application Password authentication support
