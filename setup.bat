@echo off
setlocal enabledelayedexpansion

echo.
echo ============================================================
echo   QA Agent - WordPress/WooCommerce QA Testing Tool
echo   One-time setup
echo ============================================================
echo.

:: ── Check Node.js ────────────────────────────────────────────
echo [1/5] Checking Node.js...
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
echo [2/5] Checking Claude Code...
where claude >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo WARNING: Claude Code CLI not found.
    echo.
    echo The /qa-agent command requires Claude Code to run.
    echo Install it from: https://claude.com/claude-code
    echo.
    echo You can still use the CLI directly without Claude Code.
    echo.
) else (
    echo   Claude Code found
)

:: ── Install dependencies ─────────────────────────────────────
echo.
echo [3/5] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo ERROR: npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo   Dependencies installed

:: ── Install Playwright browser ───────────────────────────────
echo.
echo [4/5] Installing Playwright browser (Chromium)...
call npx playwright install chromium
if %errorlevel% neq 0 (
    echo WARNING: Playwright browser install failed.
    echo Browser-based tests may not work.
    echo Try running manually: npx playwright install chromium
)
echo   Playwright browser installed

:: ── Build TypeScript ─────────────────────────────────────────
echo.
echo [5/5] Building project...
call npx tsc
if %errorlevel% neq 0 (
    echo ERROR: TypeScript build failed.
    pause
    exit /b 1
)
echo   Build complete

:: ── Create .env if needed ────────────────────────────────────
if not exist .env (
    echo.
    echo Creating .env from .env.example...
    copy .env.example .env >nul
    echo   .env created
)

:: ── Done ─────────────────────────────────────────────────────
echo.
echo ============================================================
echo   Setup complete!
echo ============================================================
echo.
echo   HOW TO USE:
echo.
echo   Option A - With Claude Code (recommended):
echo     1. Open a terminal in this folder
echo     2. Type: claude
echo     3. Then type: /qa-agent https://your-site.com
echo.
echo   Option B - CLI directly:
echo     npx qa-agent run --url https://your-site.com
echo.
echo   Option C - With WordPress credentials:
echo     npx qa-agent run --url https://your-site.com ^
echo       --username qa-user --password your-app-password
echo.
echo   Option D - With site config file:
echo     npx qa-agent run --config configs/my-site.yml
echo.
echo   Reports are saved to: qa-reports/
echo ============================================================
echo.
pause
