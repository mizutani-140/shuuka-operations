import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { beginCustomerLink, finishCustomerLink } from './customer-account.js';
import { beginShopifyInstall, finishShopifyInstall } from './shopify-auth.js';
import { processQueue, receiveShopifyWebhook } from './webhooks.js';
import type { ShopifyWebhookJob } from './types.js';

export const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Cache-Control', c.res.headers.get('Cache-Control') ?? 'no-store');
});

app.get('/', (c) => c.html(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>祝果 LINE連携</title><style>body{margin:0;background:#f7f1ea;color:#2d241c;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}.wrap{max-width:720px;margin:12vh auto;padding:24px}.card{background:#fff;border-radius:24px;padding:36px;box-shadow:0 18px 50px #6f3c2c22}h1{font-size:28px}.pill{display:inline-block;background:#e9f2eb;color:#3e6b4f;border-radius:99px;padding:8px 14px;font-weight:700}p{line-height:1.9;color:#6b5b4b}</style></head><body><main class="wrap"><section class="card"><span class="pill">稼働中</span><h1>祝果 LINE × Shopify 連携</h1><p>LINE Harnessで顧客情報を管理し、Shopifyの注文受付・お支払い・発送情報を安全にLINEへお届けする連携サービスです。</p></section></main></body></html>`, 200, {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
}));

app.get('/health', (c) => c.json({
  status: 'ok',
  service: 'shuuka-shopify-line-bridge',
  shop: c.env.SHOPIFY_SHOP_DOMAIN,
  apiVersion: c.env.SHOPIFY_API_VERSION,
  customerAccountConfigured:
    !c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID.startsWith('CONFIGURE_') &&
    !c.env.SHOPIFY_CUSTOMER_ACCOUNT_AUTHORIZATION_URL.startsWith('CONFIGURE_'),
}));

app.get('/connect', (c) => {
  const redirectTarget = `${c.env.APP_BASE_URL}/t/link`;
  const authUrl = new URL(`${c.env.LINE_HARNESS_API_URL}/auth/line`);
  authUrl.searchParams.set('ref', 'shopify-link');
  authUrl.searchParams.set('redirect', redirectTarget);
  return c.redirect(authUrl.toString(), 302);
});

app.get('/t/link', beginCustomerLink);
app.get('/customer/callback', finishCustomerLink);
app.get('/shopify/install', beginShopifyInstall);
app.get('/shopify/callback', finishShopifyInstall);
app.post(
  '/webhooks/shopify',
  bodyLimit({ maxSize: 2 * 1024 * 1024, onError: (c) => c.json({ error: 'payload_too_large' }, 413) }),
  receiveShopifyWebhook,
);

app.notFound((c) => c.json({ error: 'not_found' }, 404));
app.onError((error, c) => {
  const requestId = c.req.header('cf-ray') ?? crypto.randomUUID();
  console.error(JSON.stringify({ event: 'request_failed', requestId, path: new URL(c.req.url).pathname, message: error.message }));
  return c.json({ error: 'internal_error', requestId }, 500);
});

const handler: ExportedHandler<Env, ShopifyWebhookJob> = {
  fetch: app.fetch,
  queue: processQueue,
};

export default handler;
