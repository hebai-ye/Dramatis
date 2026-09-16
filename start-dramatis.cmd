@echo off
rem Only three things: enter this directory, hand off to Node, keep the window.
rem No branching and no non-ASCII on purpose. Batch files are fragile about line
rem endings and code pages, so every diagnostic lives in the Node launcher.
cd /d "%~dp0"
node "tools\desktop\launch.mjs" %*
echo.
pause
