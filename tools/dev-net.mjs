#!/usr/bin/env node
/**
 * 本地联机开发一键启动：room-server (8787) + vite dev (5173) 同时跑。
 * 任一进程退出则整体退出（Ctrl+C 两边一起停）。
 * dev 页面默认 ws://localhost:8787 正好对上，无需 ?server= 覆盖。
 */
import { spawn } from 'node:child_process';

const procs = [
  spawn(process.execPath, ['server/room-server.mjs'], { stdio: 'inherit' }),
  // Windows 下 pnpm 是 .cmd，需 shell 转发
  spawn('pnpm', ['--filter', '@bvn/app', 'dev'], { stdio: 'inherit', shell: true }),
];

const killAll = () => procs.forEach((p) => p.kill());
process.on('SIGINT', () => {
  killAll();
  process.exit(0);
});
procs.forEach((p) =>
  p.on('exit', (code) => {
    killAll();
    process.exit(code ?? 0);
  }),
);
