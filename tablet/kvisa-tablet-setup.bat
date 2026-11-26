@echo off
:: ===========================================================================
::  Kvisa tablet setup  -  run ONCE on the drop-off tablet.
::  Right-click this file and choose "Run as administrator",
::  while signed in to the Windows account the tablet will use every day.
::
::  What it does:
::   1. Starts the browser full screen on the Kvisa tablet page whenever this
::      account signs in, in silent-printing mode: labels go straight to the
::      default printer, with no print window.
::   2. Turns off swipes from the screen edges, and the browser's pop-ups
::      (save password, translate, developer tools, page headers when printing).
::  To undo everything, run kvisa-tablet-undo.bat the same way.
:: ===========================================================================
net session >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Please right-click this file and choose "Run as administrator".
  echo.
  pause
  exit /b 1
)

set "URL=https://yidele.github.io/Kvisa/tablet/"
set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%BROWSER%" (
  echo  Could not find Google Chrome or Microsoft Edge. Install Chrome and run this again.
  pause
  exit /b 1
)
echo  Browser: %BROWSER%

set "ARGS=--kiosk --kiosk-printing --no-first-run --disable-pinch --overscroll-history-navigation=0 --hide-crash-restore-bubble --edge-kiosk-type=fullscreen %URL%"
set "STARTUP=%AppData%\Microsoft\Windows\Start Menu\Programs\Startup"

:: Shortcut that starts the tablet app at sign-in, and one on the desktop
powershell -NoProfile -ExecutionPolicy Bypass -Command "$w = New-Object -ComObject WScript.Shell; $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Kvisa Tablet.lnk'; foreach ($p in @('%STARTUP%\Kvisa Tablet.lnk', $desk)) { $s = $w.CreateShortcut($p); $s.TargetPath = '%BROWSER%'; $s.Arguments = '%ARGS%'; $s.Save() }"
if errorlevel 1 (
  echo  Could not create the shortcuts.
  pause
  exit /b 1
)

:: Browser settings for both Chrome and Edge
for %%K in ("HKLM\SOFTWARE\Policies\Google\Chrome" "HKLM\SOFTWARE\Policies\Microsoft\Edge") do (
  reg add %%K /v PrintPreviewUseSystemDefaultPrinter /t REG_DWORD /d 1 /f >nul
  reg add %%K /v PrintHeaderFooter /t REG_DWORD /d 0 /f >nul
  reg add %%K /v PasswordManagerEnabled /t REG_DWORD /d 0 /f >nul
  reg add %%K /v TranslateEnabled /t REG_DWORD /d 0 /f >nul
  reg add %%K /v DeveloperToolsAvailability /t REG_DWORD /d 2 /f >nul
  reg add %%K /v BackgroundModeEnabled /t REG_DWORD /d 0 /f >nul
)
:: Edge: no startup boost (a browser already running in the background would ignore silent printing)
:: and no first-run welcome pages
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v StartupBoostEnabled /t REG_DWORD /d 0 /f >nul
reg add "HKLM\SOFTWARE\Policies\Microsoft\Edge" /v HideFirstRunExperience /t REG_DWORD /d 1 /f >nul

:: No swipes from the screen edges (Start menu, task view, notifications)
reg add "HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI" /v AllowEdgeSwipe /t REG_DWORD /d 0 /f >nul

:: Keep the printer you choose as the default (Windows won't switch it)
reg add "HKCU\Software\Microsoft\Windows NT\CurrentVersion\Windows" /v LegacyDefaultPrinterMode /t REG_DWORD /d 1 /f >nul

echo.
echo  Done.
echo  1. Make the label printer the DEFAULT printer:
echo     Settings ^> Bluetooth ^& devices ^> Printers ^& scanners ^> your printer ^> Set as default.
echo  2. Restart the tablet (closing the browser is not enough).
echo     The Kvisa tablet app opens full screen, and labels print with no window.
echo.
pause
