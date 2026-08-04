#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrConnect } from '@tencent-connect/qqbot-connector';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envPath = path.join(root, '.env');

function upsertEnv(file, map) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!text && fs.existsSync(path.join(root, '.env.example'))) {
    text = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
  }
  for (const [k, v] of Object.entries(map)) {
    const re = new RegExp(`^${k}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, `${k}=${v}`);
    else text += `\n${k}=${v}\n`;
  }
  fs.writeFileSync(file, text.endsWith('\n') ? text : text + '\n', 'utf8');
}

console.log('请使用手机 QQ 扫描控制台二维码，绑定机器人并获取 AppID/AppSecret...');
const list = await qrConnect();
const cred = list?.[0];
if (!cred?.appId || !cred?.appSecret) {
  console.error('未拿到凭证');
  process.exit(1);
}
upsertEnv(envPath, {
  QQBOT_APP_ID: cred.appId,
  QQBOT_CLIENT_SECRET: cred.appSecret,
});
console.log('绑定成功，已写入 .env');
console.log('AppID:', cred.appId);
console.log('下一步: npm start');
