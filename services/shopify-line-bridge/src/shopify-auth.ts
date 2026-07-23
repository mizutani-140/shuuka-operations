import type { Context } from 'hono';
import {
  clearOauthStateCookie,
  encryptSecret,
  isValidShopDomain,
  oauthStateCookie,
  parseCookies,
  randomToken,
  verifyShopifyQuery,
} from './security.js';

const SCOPES = 'read_orders,read_customers';

function page(title: string, body: string, ok = true): Response {
  return new Response(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;background:#f7f1ea;color:#2d241c;margin:0}.card{max-width:640px;margin:12vh auto;background:#fff;border-radius:20px;padding:32px;box-shadow:0 18px 50px #6f3c2c22}h1{font-size:24px}p{line-height:1.8}a{color:#6f3c2c}</style></head><body><main class="card"><h1>${title}</h1><p>${body}</p></main></body></html>`, {
    status: ok ? 200 : 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function appConfigured(env: Env): boolean {
  return Boolean(env.SHOPIFY_API_KEY && !env.SHOPIFY_API_KEY.startsWith('CONFIGURE_'));
}

export async function beginShopifyInstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!appConfigured(c.env)) return page('Shopifyアプリ設定待ち', 'Shopify Dev Dashboardでアプリを作成後に有効になります。', false);
  const url = new URL(c.req.url);
  const shop = url.searchParams.get('shop')?.toLowerCase() ?? '';
  if (!isValidShopDomain(shop) || shop !== c.env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) {
    return page('ストアを確認できません', '祝果ストアからインストールを開始してください。', false);
  }

  const incomingHmac = url.searchParams.get('hmac');
  if (incomingHmac && !(await verifyShopifyQuery(url, c.env.SHOPIFY_API_SECRET))) {
    return page('署名を確認できません', 'Shopify管理画面からもう一度開いてください。', false);
  }

  const state = randomToken();
  const now = new Date();
  await c.env.DB.prepare(
    `INSERT INTO merchant_oauth_states (state, shop_domain, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(state, shop, new Date(now.getTime() + 10 * 60_000).toISOString(), now.toISOString())
    .run();

  const redirectUri = `${c.env.APP_BASE_URL}/shopify/callback`;
  const authorizationUrl = new URL(`https://${shop}/admin/oauth/authorize`);
  authorizationUrl.searchParams.set('client_id', c.env.SHOPIFY_API_KEY);
  authorizationUrl.searchParams.set('scope', SCOPES);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      Location: authorizationUrl.toString(),
      'Set-Cookie': oauthStateCookie(state),
      'Cache-Control': 'no-store',
    },
  });
}

export async function finishShopifyInstall(c: Context<{ Bindings: Env }>): Promise<Response> {
  const url = new URL(c.req.url);
  if (!(await verifyShopifyQuery(url, c.env.SHOPIFY_API_SECRET))) {
    return page('Shopify署名の検証に失敗しました', '管理画面からインストールをやり直してください。', false);
  }
  const shop = url.searchParams.get('shop')?.toLowerCase() ?? '';
  const state = url.searchParams.get('state') ?? '';
  const code = url.searchParams.get('code') ?? '';
  const cookieState = parseCookies(c.req.header('Cookie')).shopify_oauth_state;
  if (!isValidShopDomain(shop) || shop !== c.env.SHOPIFY_SHOP_DOMAIN.toLowerCase() || !state || !code || cookieState !== state) {
    return page('Shopify認証情報が一致しません', '管理画面からインストールをやり直してください。', false);
  }

  const saved = await c.env.DB.prepare(
    `SELECT shop_domain, expires_at FROM merchant_oauth_states
      WHERE state = ? AND used_at IS NULL`,
  )
    .bind(state)
    .first<{ shop_domain: string; expires_at: string }>();
  if (!saved || saved.shop_domain !== shop || Date.parse(saved.expires_at) < Date.now()) {
    return page('Shopify認証の有効期限が切れました', '管理画面からインストールをやり直してください。', false);
  }
  const consumed = await c.env.DB.prepare(
    'UPDATE merchant_oauth_states SET used_at = ? WHERE state = ? AND used_at IS NULL',
  )
    .bind(new Date().toISOString(), state)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) return page('この認証は使用済みです', '管理画面からやり直してください。', false);

  const tokenResponse = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: c.env.SHOPIFY_API_KEY,
      client_secret: c.env.SHOPIFY_API_SECRET,
      code,
    }),
  });
  const token = await tokenResponse.json<{ access_token?: string; scope?: string; error?: string }>();
  if (!tokenResponse.ok || !token.access_token) {
    console.error(JSON.stringify({ event: 'shopify_install_token_failed', status: tokenResponse.status, error: token.error }));
    return page('Shopifyアプリをインストールできません', '時間をおいてもう一度お試しください。', false);
  }

  const now = new Date().toISOString();
  await c.env.DB.prepare(
    `INSERT INTO shop_installations
      (shop_domain, encrypted_access_token, granted_scopes, installed_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(shop_domain) DO UPDATE SET
       encrypted_access_token = excluded.encrypted_access_token,
       granted_scopes = excluded.granted_scopes,
       updated_at = excluded.updated_at`,
  )
    .bind(
      shop,
      await encryptSecret(token.access_token, c.env.SHOPIFY_TOKEN_ENCRYPTION_KEY),
      token.scope ?? SCOPES,
      now,
      now,
    )
    .run();

  return new Response(page('祝果 LINE連携アプリをインストールしました', 'Webhookによる注文通知を受け取る準備ができました。').body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Set-Cookie': clearOauthStateCookie(),
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}
