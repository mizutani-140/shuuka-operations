import type { Context } from 'hono';
import { markFriendLinked } from './harness.js';
import { randomToken, sha256Hex, verifyLinkTicket } from './security.js';

type CustomerAccountTokenResponse = {
  access_token?: string;
  error?: string;
  error_description?: string;
};

type CustomerAccountGraphqlResponse = {
  data?: {
    customer?: {
      id: string;
      displayName: string;
      emailAddress?: { emailAddress?: string | null } | null;
    };
  };
  errors?: Array<{ message: string }>;
};

type CustomerAccountDiscoveryResponse = {
  graphql_api?: string;
};

const SHOPIFY_USER_AGENT = 'shuuka-shopify-line-bridge/0.1 (+https://shuuka.jp)';

async function parseJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return await response.json<T>();
  } catch {
    return null;
  }
}

function isAllowedCustomerApiUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && (url.hostname === 'shopify.com' || url.hostname.endsWith('.shopify.com') || url.hostname.endsWith('.myshopify.com'));
  } catch {
    return false;
  }
}

async function resolveCustomerGraphqlUrl(env: Env): Promise<string> {
  const discoveryUrl = `https://${env.SHOPIFY_SHOP_DOMAIN}/.well-known/customer-account-api`;
  try {
    const response = await fetch(discoveryUrl, {
      headers: {
        Accept: 'application/json',
        'User-Agent': SHOPIFY_USER_AGENT,
      },
    });
    const discovery = await parseJsonResponse<CustomerAccountDiscoveryResponse>(response);
    if (response.ok && discovery?.graphql_api && isAllowedCustomerApiUrl(discovery.graphql_api)) {
      return discovery.graphql_api;
    }
    console.error(JSON.stringify({
      event: 'customer_api_discovery_failed',
      status: response.status,
      contentType: response.headers.get('content-type'),
    }));
  } catch (error) {
    console.error(JSON.stringify({
      event: 'customer_api_discovery_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  return env.SHOPIFY_CUSTOMER_ACCOUNT_GRAPHQL_URL;
}

function html(title: string, message: string, ok: boolean): Response {
  const color = ok ? '#3E6B4F' : '#8B3A32';
  return new Response(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}｜祝果</title>
<style>body{margin:0;background:#f7f1ea;color:#2d241c;font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif}.wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.card{max-width:480px;background:#fff;border-radius:24px;padding:32px;box-shadow:0 18px 50px #6f3c2c24;text-align:center}.mark{width:64px;height:64px;margin:auto;border-radius:50%;display:grid;place-items:center;background:${color};color:#fff;font-size:32px}h1{font-size:24px;margin:20px 0 12px}p{line-height:1.8;color:#6b5b4b}.brand{font-size:12px;letter-spacing:.18em;color:#8b7765;margin-top:24px}</style>
</head><body><main class="wrap"><section class="card"><div class="mark">${ok ? '✓' : '!'}</div><h1>${title}</h1><p>${message}</p><div class="brand">祝果 SHUUKA</div></section></main></body></html>`, {
    status: ok ? 200 : 400,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function configured(value: string): boolean {
  return Boolean(value && !value.startsWith('CONFIGURE_'));
}

function normalizeCustomerId(gid: string): string {
  return gid.split('/').at(-1) ?? gid;
}

export async function beginCustomerLink(c: Context<{ Bindings: Env }>): Promise<Response> {
  const ticket = c.req.query('lh_ticket');
  if (!ticket) return html('連携を開始できません', 'LINEからもう一度「会員連携」を開いてください。', false);
  if (
    !configured(c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID) ||
    !configured(c.env.SHOPIFY_CUSTOMER_ACCOUNT_AUTHORIZATION_URL) ||
    !configured(c.env.SHOPIFY_CUSTOMER_ACCOUNT_TOKEN_URL)
  ) {
    return html('準備中です', 'Shopify会員認証の最終設定を行っています。少し時間をおいてお試しください。', false);
  }

  let payload;
  try {
    payload = await verifyLinkTicket(
      ticket,
      c.env.SHOPIFY_LINK_SIGNING_SECRET,
      new URL(c.env.APP_BASE_URL).origin,
    );
  } catch {
    return html('リンクの有効期限が切れました', 'LINEからもう一度「会員連携」を開いてください。', false);
  }

  const state = randomToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO customer_link_states
      (state, ticket_nonce, line_friend_id, line_user_id, harness_user_id, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(state, payload.nonce, payload.friendId, payload.lineUserId, payload.userId, expiresAt, now.toISOString())
    .run();
  if ((inserted.meta.changes ?? 0) !== 1) {
    return html('このリンクは使用済みです', '安全のため、LINEからもう一度「会員連携」を開いてください。', false);
  }

  const redirectUri = `${c.env.APP_BASE_URL}/customer/callback`;
  const authorizationUrl = new URL(c.env.SHOPIFY_CUSTOMER_ACCOUNT_AUTHORIZATION_URL);
  authorizationUrl.searchParams.set('scope', 'openid email customer-account-api:full');
  authorizationUrl.searchParams.set('client_id', c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('nonce', randomToken(16));
  return c.redirect(authorizationUrl.toString(), 302);
}

export async function finishCustomerLink(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return html('認証を完了できません', '必要な認証情報が不足しています。', false);

  const linkState = await c.env.DB.prepare(
    `SELECT state, line_friend_id, line_user_id, harness_user_id, expires_at
       FROM customer_link_states
      WHERE state = ? AND used_at IS NULL`,
  )
    .bind(state)
    .first<{
      state: string;
      line_friend_id: string;
      line_user_id: string;
      harness_user_id: string;
      expires_at: string;
    }>();
  if (!linkState || Date.parse(linkState.expires_at) < Date.now()) {
    return html('認証の有効期限が切れました', 'LINEからもう一度「会員連携」を開いてください。', false);
  }

  const consumed = await c.env.DB.prepare(
    'UPDATE customer_link_states SET used_at = ? WHERE state = ? AND used_at IS NULL',
  )
    .bind(new Date().toISOString(), state)
    .run();
  if ((consumed.meta.changes ?? 0) !== 1) return html('この認証は使用済みです', 'LINEからやり直してください。', false);

  const redirectUri = `${c.env.APP_BASE_URL}/customer/callback`;
  const basic = btoa(`${c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID}:${c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET}`);
  const tokenResponse = await fetch(c.env.SHOPIFY_CUSTOMER_ACCOUNT_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': SHOPIFY_USER_AGENT,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: c.env.SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const token = await parseJsonResponse<CustomerAccountTokenResponse>(tokenResponse);
  if (!tokenResponse.ok || !token?.access_token) {
    console.error(JSON.stringify({
      event: 'customer_token_exchange_failed',
      status: tokenResponse.status,
      contentType: tokenResponse.headers.get('content-type'),
      error: token?.error,
    }));
    return html('Shopify認証に失敗しました', '時間をおいて、LINEからもう一度お試しください。', false);
  }

  const customerGraphqlUrl = await resolveCustomerGraphqlUrl(c.env);
  const customerResponse = await fetch(customerGraphqlUrl, {
    method: 'POST',
    headers: {
      Authorization: token.access_token,
      'Content-Type': 'application/json',
      'User-Agent': SHOPIFY_USER_AGENT,
    },
    body: JSON.stringify({
      query: 'query LinkCustomer { customer { id displayName emailAddress { emailAddress } } }',
    }),
  });
  const customerResult = await parseJsonResponse<CustomerAccountGraphqlResponse>(customerResponse);
  const customer = customerResult?.data?.customer;
  if (!customerResponse.ok || !customer) {
    console.error(JSON.stringify({
      event: 'customer_query_failed',
      status: customerResponse.status,
      contentType: customerResponse.headers.get('content-type'),
      errors: customerResult?.errors?.map((error) => error.message),
    }));
    return html('会員情報を確認できません', 'Shopifyの会員アカウントでログインしてから、もう一度お試しください。', false);
  }

  const customerId = normalizeCustomerId(customer.id);
  const existingByFriend = await c.env.DB.prepare(
    `SELECT shopify_customer_id FROM account_links
      WHERE shop_domain = ? AND line_friend_id = ? AND status = 'active'`,
  )
    .bind(c.env.SHOPIFY_SHOP_DOMAIN, linkState.line_friend_id)
    .first<{ shopify_customer_id: string }>();
  if (existingByFriend && existingByFriend.shopify_customer_id !== customerId) {
    return html('すでに別の会員情報と連携済みです', '安全のため自動では変更しません。LINEでお問い合わせください。', false);
  }

  const existingByCustomer = await c.env.DB.prepare(
    `SELECT line_friend_id FROM account_links
      WHERE shop_domain = ? AND shopify_customer_id = ? AND status = 'active'`,
  )
    .bind(c.env.SHOPIFY_SHOP_DOMAIN, customerId)
    .first<{ line_friend_id: string }>();
  if (existingByCustomer && existingByCustomer.line_friend_id !== linkState.line_friend_id) {
    return html('この会員情報は連携済みです', '別のLINEアカウントへ変更する場合はお問い合わせください。', false);
  }

  const now = new Date().toISOString();
  const email = customer.emailAddress?.emailAddress?.trim().toLowerCase() ?? null;
  await c.env.DB.prepare(
    `INSERT INTO account_links
      (id, shop_domain, shopify_customer_id, line_friend_id, line_user_id, harness_user_id,
       customer_display_name, customer_email_hash, status, linked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
     ON CONFLICT(shop_domain, shopify_customer_id) DO UPDATE SET
       line_friend_id = excluded.line_friend_id,
       line_user_id = excluded.line_user_id,
       harness_user_id = excluded.harness_user_id,
       customer_display_name = excluded.customer_display_name,
       customer_email_hash = excluded.customer_email_hash,
       status = 'active',
       updated_at = excluded.updated_at`,
  )
    .bind(
      crypto.randomUUID(),
      c.env.SHOPIFY_SHOP_DOMAIN,
      customerId,
      linkState.line_friend_id,
      linkState.line_user_id,
      linkState.harness_user_id,
      customer.displayName,
      email ? await sha256Hex(email) : null,
      now,
      now,
    )
    .run();

  try {
    await markFriendLinked(c.env, linkState.line_friend_id, customerId, customer.displayName);
  } catch (error) {
    console.error(JSON.stringify({
      event: 'harness_link_enrichment_failed',
      message: error instanceof Error ? error.message : String(error),
    }));
  }
  return html('LINE連携が完了しました', 'これから注文受付・お支払い・発送のお知らせをLINEで受け取れます。この画面は閉じて大丈夫です。', true);
}
