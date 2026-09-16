@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动 Dramatis，请稍候……
call pnpm desktop
echo.
echo 服务已停止。按任意键关闭这个窗口。
pause >nul
