@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist logs mkdir logs

rem 公网反代（Cloudflare/Nginx）下信任转发头，按真实 IP 防爆破并给 Cookie 加 Secure
if not defined TRUST_PROXY set "TRUST_PROXY=1"

set NODE_EXE=node
where node >nul 2>nul || set NODE_EXE=C:\Program Files\nodejs\node.exe

rem 数据目录：优先站点自带 data，其次工作副本的 ..\data，最后桌面整理包的 ..\..\relayrank-data\data
if not defined DATA_DIR if exist "%~dp0data\db.json" set "DATA_DIR=%~dp0data"
if not defined DATA_DIR if exist "%~dp0..\data\db.json" set "DATA_DIR=%~dp0..\data"
if not defined DATA_DIR if exist "%~dp0..\..\relayrank-data\data\db.json" set "DATA_DIR=%~dp0..\..\relayrank-data\data"

rem 模型侦探：默认开启，反代到 127.0.0.1:5000；server.js 会按 detective.config.json 自动拉起
if not defined ENABLE_DETECTIVE set "ENABLE_DETECTIVE=1"
if not defined DETECTIVE_PORT set "DETECTIVE_PORT=5000"

echo [%date% %time%] start >> logs/boot.log
"%NODE_EXE%" server.js --port=8803 >> logs/server.log 2>&1
