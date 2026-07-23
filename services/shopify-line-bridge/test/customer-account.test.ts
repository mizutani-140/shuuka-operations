import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';

function customerLinkDb(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM customer_link_states')) {
                return {
                  state: 'state-1',
                  line_friend_id: 'friend-1',
                  line_user_id: 'U123',
                  harness_user_id: 'user-1',
                  expires_at: new Date(Date.now() + 60_000).toISOString(),
                };
              }
              return null;
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as D1Database;
}

const queueMetrics = { backlogCount: 0, backlogBytes: 0 };
const shopifyEvents: Queue = {
  async metrics() {
    return queueMetrics;
  },
  async send() {
    return { metadata: { metrics: queueMetrics } };
  },
  async sendBatch() {
    return { metadata: { metrics: queueMetrics } };
  },
};

const env: Env = {
  DB: customerLinkDb(),
  SHOPIFY_EVENTS: shopifyEvents,
  APP_BASE_URL: 'https://shuuka-shopify-line-bridge.k-mizutani.workers.dev',
  LINE_HARNESS_API_URL: 'https://shuuka-line-harness.k-mizutani.workers.dev',
  LINE_LIFF_ID: '2010723883-nNNXQGQn',
  SHOPIFY_API_VERSION: '2026-07',
  SHOPIFY_SHOP_DOMAIN: 'ksz15x-gq.myshopify.com',
  SHOPIFY_API_KEY: 'e59b352152ab223f9515b8d2b5034281',
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_ID: '2f9a39bd-9105-4d91-ba99-0bfe995c67d0',
  SHOPIFY_CUSTOMER_ACCOUNT_AUTHORIZATION_URL: 'https://shopify.com/authentication/78124712124/oauth/authorize',
  SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET: 'client-secret',
  SHOPIFY_CUSTOMER_ACCOUNT_TOKEN_URL: 'https://shopify.com/authentication/78124712124/oauth/token',
  SHOPIFY_CUSTOMER_ACCOUNT_GRAPHQL_URL: 'https://shopify.com/78124712124/account/customer/api/2026-07/graphql',
  SHOPIFY_API_SECRET: 'shopify-api-secret',
  SHOPIFY_TOKEN_ENCRYPTION_KEY: '1'.repeat(64),
  SHOPIFY_LINK_SIGNING_SECRET: 'link-signing-secret',
  LINE_HARNESS_API_KEY: 'line-harness-key',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Customer Account OAuth callback', () => {
  it('returns a controlled error when Shopify sends an HTML token error response', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Forbidden</html>', {
      status: 403,
      headers: { 'Content-Type': 'text/html' },
    }));

    const response = await app.request(
      'https://shuuka-shopify-line-bridge.k-mizutani.workers.dev/customer/callback?code=code-1&state=state-1',
      undefined,
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toContain('text/html');
    await expect(response.text()).resolves.toContain('Shopify認証に失敗しました');

    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get('user-agent')).toContain('shuuka-shopify-line-bridge');
  });

  it('uses the GraphQL endpoint returned by Shopify customer-account discovery', async () => {
    const discoveredGraphqlUrl = 'https://shopify.com/78124712124/account/customer/api/2026-07/graphql';
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return Response.json({ access_token: 'customer-token' });
      }
      if (url.endsWith('/.well-known/customer-account-api')) {
        return Response.json({ graphql_api: discoveredGraphqlUrl });
      }
      if (url === discoveredGraphqlUrl) {
        return Response.json({ data: { customer: null }, errors: [{ message: 'test stop' }] });
      }
      return new Response('Not found', { status: 404 });
    });

    const response = await app.request(
      'https://shuuka-shopify-line-bridge.k-mizutani.workers.dev/customer/callback?code=code-2&state=state-2',
      undefined,
      env,
    );

    expect(response.status).toBe(400);
    expect(requestedUrls).toEqual([
      'https://shopify.com/authentication/78124712124/oauth/token',
      'https://ksz15x-gq.myshopify.com/.well-known/customer-account-api',
      discoveredGraphqlUrl,
    ]);
  });

  it('keeps the completed account link successful when Harness enrichment fails', async () => {
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return Response.json({ access_token: 'customer-token' });
      }
      if (url.endsWith('/.well-known/customer-account-api')) {
        return Response.json({
          graphql_api: 'https://shopify.com/78124712124/account/customer/api/2026-07/graphql',
        });
      }
      if (url.includes('/account/customer/api/2026-07/graphql')) {
        return Response.json({
          data: {
            customer: {
              id: 'gid://shopify/Customer/12345',
              displayName: '祝果 太郎',
              emailAddress: { emailAddress: 'customer@example.com' },
            },
          },
        });
      }
      return Response.json({ success: false, error: 'Friend not found' }, { status: 404 });
    });

    const response = await app.request(
      'https://shuuka-shopify-line-bridge.k-mizutani.workers.dev/customer/callback?code=code-3&state=state-3',
      undefined,
      env,
    );

    expect(requestedUrls.some((url) => url.includes('/api/friends/friend-1/metadata'))).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toContain('LINE連携が完了しました');
  });
});
