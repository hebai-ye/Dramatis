#!/usr/bin/env node
import process from 'node:process';
import { readAdminConfig, startAdmin } from './dist/main.js';

try {
  const service = startAdmin(readAdminConfig(process.env));
  const stop = () => {
    void service.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch {
  process.stderr.write('管理台启动失败，请检查配置、token、数据库与文件权限。\n');
  process.exit(1);
}
