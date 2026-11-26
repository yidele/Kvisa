@echo off
:: Kvisa tablet  -  undo the setup. Right-click and choose "Run as administrator".
net session >nul 2>&1
if errorlevel 1 (
  echo  Please right-click this file and choose "Run as administrator".
  pause
  exit /b 1
)
del "%AppData%\Microsoft\Windows\Start Menu\Programs\Startup\Kvisa Tablet.lnk" 2>nul
powershell -NoProfile -Command "Remove-Item ([Environment]::GetFolderPath('Desktop') + '\Kvisa Tablet.lnk') -ErrorAction SilentlyContinue"
for %%K in ("HKLM\SOFTWARE\Policies\Google\Chrome" "HKLM\SOFTWARE\Policies\Microsoft\Edge") do (
  for %%V in (PrintPreviewUseSystemDefaultPrinter PrintHeaderFooter PasswordManagerEnabled TranslateEnabled DeveloperToolsAvailability) do reg delete %%K /v %%V /f >nul 2>&1
)
reg delete "HKLM\SOFTWARE\Policies\Microsoft\Windows\EdgeUI" /v AllowEdgeSwipe /f >nul 2>&1
echo  Undone. Restart the tablet.
pause
