@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   QA Agent - WordPress/WooCommerce QA Testing Tool
echo   One-time setup
echo ============================================================
echo.

:: ── Check Node.js ────────────────────────────────────────────
echo [1/6] Checking Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo ERROR: Node.js is not installed.
    echo.
    echo Download and install Node.js v22+ from:
    echo   https://nodejs.org/
    echo.
    echo After installing, close this window and run setup.bat again.
    pause
    exit /b 1
)

for /f "tokens=1 delims=v" %%v in ('node -v') do set NODE_VER=%%v
for /f "tokens=1 delims=." %%m in ('node -v') do set NODE_MAJOR=%%m
set NODE_MAJOR=%NODE_MAJOR:v=%

if %NODE_MAJOR% lss 18 (
    echo WARNING: Node.js %NODE_VER% detected. Version 18+ recommended.
    echo Download latest from: https://nodejs.org/
)
echo   Node.js found: %NODE_VER%

:: ── Check Claude Code ────────────────────────────────────────
echo.
echo [2/6] Checking Claude Code...
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo WARNING: Claude Code CLI not found.
    echo.
    echo The /qa-agent command requires Claude Code.
    echo Install from: https://claude.com/claude-code
    echo.
    echo You can still use the CLI directly without Claude Code.
    echo.
) else (
    echo   Claude Code found
)

:: ── Install dependencies ─────────────────────────────────────
echo.
echo [3/6] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo   Dependencies installed

:: ── Install Playwright browser ───────────────────────────────
echo.
echo [4/6] Installing Playwright browser (Chromium)...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo WARNING: Playwright browser install failed.
    echo Browser-based tests may not work.
    echo Try running manually: npx playwright install chromium
)
echo   Playwright browser installed

:: ── Build TypeScript ─────────────────────────────────────────
echo.
echo [5/6] Building project...
call npx tsc
if %errorlevel% neq 0 (
    echo ERROR: TypeScript build failed.
    pause
    exit /b 1
)
echo   Build complete

:: ── Configure environment ────────────────────────────────────
echo.
echo [6/6] Configuration...
echo.

if exist .env (
    echo   .env file already exists. Skipping configuration.
    echo   Edit .env manually if you need to change settings.
    goto :setup_site
)

echo   Let's configure your environment.
echo.

:: PageSpeed API key
echo ──────────────────────────────────────────────────────────
echo   Google PageSpeed API Key (for Lighthouse performance tests)
echo.
echo   This is OPTIONAL but recommended. Without it, Lighthouse
echo   checks still work but with lower rate limits.
echo.
echo   Get a free key at:
echo     https://console.developers.google.com
echo     1. Create a project (or select existing)
echo     2. Enable "PageSpeed Insights API"
echo     3. Create an API key under Credentials
echo.
set /p PAGESPEED_KEY="  Paste your API key (or press Enter to skip): "
echo.

:: Write .env file
echo # QA Agent Configuration> .env
echo.>> .env
echo # Google PageSpeed API key (optional — improves Lighthouse rate limits)>> .env
if defined PAGESPEED_KEY (
    echo PAGESPEED_API_KEY=!PAGESPEED_KEY!>> .env
    echo   PageSpeed API key saved.
) else (
    echo PAGESPEED_API_KEY=>> .env
    echo   Skipped — you can add it later in the .env file.
)
echo.>> .env
echo # Output settings>> .env
echo QA_OUTPUT_DIR=./qa-reports>> .env
echo QA_SCREENSHOT_DIR=./screenshots>> .env

echo.
echo   .env file created.

:: ── Optional: Create a site config ───────────────────────────
:setup_site
echo.
echo ──────────────────────────────────────────────────────────
echo   Would you like to set up a site config now?
echo   (You can always do this later or use --url instead)
echo.
set /p CREATE_CONFIG="  Create a site config? (y/n): "

if /i not "%CREATE_CONFIG%"=="y" goto :done

echo.
echo   Let's set up your first site config.
echo.

:: Site URL
set /p SITE_URL="  Site URL (e.g. https://staging.example.com): "
if "%SITE_URL%"=="" (
    echo   Skipped — no URL provided.
    goto :done
)

:: Site name
set /p SITE_NAME="  Site name (e.g. My Client Site): "
if "%SITE_NAME%"=="" set SITE_NAME=%SITE_URL%

:: WordPress credentials
echo.
echo   WordPress credentials are OPTIONAL but unlock:
echo     - Plugin version and update checks
echo     - WooCommerce system status
echo     - Detailed plugin health data
echo.
echo   To create an Application Password in WordPress:
echo     1. Go to WP Admin ^> Users ^> Your Profile
echo     2. Scroll to "Application Passwords"
echo     3. Enter "QA Agent" as the name, click "Add New"
echo     4. Copy the generated password
echo.
set /p WP_USER="  WordPress username (or press Enter to skip): "
if "%WP_USER%"=="" goto :write_config

set /p WP_PASS="  Application password: "

:: Project path
:write_config
echo.
echo   Local project path is OPTIONAL but enables:
echo     - Deep code analysis (custom features, hooks, templates)
echo     - Code review (security, WC CRUD, escaping checks)
echo     - Code-driven browser testing
echo.
set /p PROJECT_PATH="  Local project path (or press Enter to skip): "

:: Generate slug for filename
set "SLUG=%SITE_URL%"
set "SLUG=%SLUG:https://=%"
set "SLUG=%SLUG:http://=%"
set "SLUG=%SLUG:/=-%"
set "SLUG=%SLUG:.=-%"
for %%a in ("%SLUG%") do set "SLUG=%%~na"

:: Write YAML config
set CONFIG_FILE=configs\%SLUG%.yml
if not exist configs mkdir configs

echo name: "%SITE_NAME%"> %CONFIG_FILE%
echo url: "%SITE_URL%">> %CONFIG_FILE%

if defined WP_USER (
    echo username: "%WP_USER%">> %CONFIG_FILE%
    if defined WP_PASS (
        echo app_password: "%WP_PASS%">> %CONFIG_FILE%
    )
)

if defined PROJECT_PATH (
    echo project_path: "%PROJECT_PATH%">> %CONFIG_FILE%
)

echo.>> %CONFIG_FILE%
echo description: ^|>> %CONFIG_FILE%
echo   WordPress/WooCommerce site for QA testing.>> %CONFIG_FILE%
echo.>> %CONFIG_FILE%
echo max_links_to_crawl: 30>> %CONFIG_FILE%
echo timeout_ms: 30000>> %CONFIG_FILE%

echo.
echo   Site config saved to: %CONFIG_FILE%

:: ── Done ─────────────────────────────────────────────────────
:done
echo.
echo ============================================================
echo   Setup complete!
echo ============================================================
echo.
echo   HOW TO USE:
echo.
echo   Option A - With Claude Code (recommended, fully autonomous):
echo     1. Open a terminal in this folder
echo     2. Type: claude
echo     3. Then type: /qa-agent %SITE_URL%
if defined PROJECT_PATH (
    echo        or: /qa-agent %SITE_URL% --project "%PROJECT_PATH%"
)
echo.

if defined SLUG (
    echo   Option B - CLI with your site config:
    echo     npx qa-agent run --config configs/%SLUG%.yml
    echo.
)

echo   Option C - CLI with just a URL:
echo     npx qa-agent run --url https://your-site.com
echo.
echo   Option D - CLI with credentials:
echo     npx qa-agent run --url https://your-site.com ^
echo       --username your-user --password your-app-password
echo.
echo   Reports are saved to: qa-reports/
echo ============================================================
echo.
pause
