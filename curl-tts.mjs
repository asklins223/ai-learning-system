import { chromium } from '@playwright/test';
import fs from 'fs';
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:3999/login', { waitUntil: 'networkidle', timeout: 30000 });
await page.waitForTimeout(2000);
await page.click('.login-submit');
await page.waitForTimeout(5000);
// 从页面上下文直接 fetch（自动带 cookie 和 CSRF 逻辑由页面内 JS 处理）
const result = await page.evaluate(async () => {
  const res = await fetch('/api/voice/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: '这是朗读测试，验证音频能否正常返回。', voice: 'zh-CN-XiaoxiaoNeural' }),
  });
  if (!res.ok) return { status: res.status, body: await res.text() };
  const buf = await res.arrayBuffer();
  return { status: res.status, contentType: res.headers.get('content-type'), bytes: buf.byteLength };
});
console.log('页面内 fetch:', JSON.stringify(result));
await browser.close();
