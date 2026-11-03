// 生成 .cmd 启动器（必须 CRLF + 纯 ASCII，否则 cmd.exe 解析会出错）
// 用法：node tools\gen-cmd.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HEAD = [
  '@echo off',
  'chcp 65001 >nul',
  'setlocal',
  'cd /d "%~dp0"',
  'set "NODE_EXE=node"',
  'where node >nul 2>nul',
  'if errorlevel 1 set "NODE_EXE=D:\\tool\\node\\node.exe"',
];

const TAIL = ['set "CODE=%ERRORLEVEL%"', 'if not "%CODE%"=="0" pause', 'endlocal', 'exit /b %CODE%'];

const FILES = {
  '创建桌面快捷方式.cmd': 'powershell -NoProfile -ExecutionPolicy Bypass -File "tools\\create-shortcut.ps1"',
  '启动界面.cmd': '"%NODE_EXE%" "src\\server.mjs" %*',
  '一键备份.cmd': '"%NODE_EXE%" "src\\sync.mjs" run %*',
  '选择去向.cmd': '"%NODE_EXE%" "src\\sync.mjs" target-run %*',
  '只看新增-不动文件.cmd': '"%NODE_EXE%" "src\\sync.mjs" dry %*',
  '指定日期备份.cmd': '"%NODE_EXE%" "src\\sync.mjs" date-run %*',
  '补传云端.cmd': '"%NODE_EXE%" "src\\sync.mjs" retry-cloud %*',
  '首次设置.cmd': '"%NODE_EXE%" "src\\sync.mjs" setup %*',
  '校验报告.cmd': '"%NODE_EXE%" "src\\sync.mjs" verify %*',
  '跑测试.cmd': '"%NODE_EXE%" --test --test-isolation=none "test/**/*.test.mjs" %* & rd /s /q "_test_out" 2>nul',
};

for (const [name, cmdline] of Object.entries(FILES)) {
  const body = [...HEAD, cmdline, ...TAIL].join('\r\n') + '\r\n';
  fs.writeFileSync(path.join(ROOT, name), body, 'ascii');
  process.stdout.write(`written ${name} (${Buffer.byteLength(body)} bytes)\n`);
}
