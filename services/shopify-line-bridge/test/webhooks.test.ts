import { afterEach, describe, expect, it, vi } from 'vitest';
import { app } from '../src/index.js';
import { bytesToBase64, hmacSha256 } from '../src/security.js';
import { processQueue } from '../src/webhooks.js';
import type { ShopifyWebhookJob } from '../src/types.js';

function receiptDb(): D1Database {
  const receipts = new Set<string>();

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              if (sql.includes('INSERT OR IGNORE INTO webhook_receipts')) {
                const webhookId = String(values[0]);
                if (receipts.has(webhookId)) return { meta: { changes: 0 } };
                receipts.add(webhookId);
                return { meta: { changes: 1 } };
              }
              if (sql.includes('DELETE FROM webhook_receipts')) {
                return { meta: { changes: receipts.delete(String(values[0])) ? 1 : 0 } };
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as D1Database;
}

async function webhookRequest(env: Env, webhookId: string, body: string): Promise<Response> {
  const signature = bytesToBase64(await hmacSha256(env.SHOPIFY_API_SECRET, body));
  return app.request('https://bridge.example/webhooks/shopify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Hmac-Sha256': signature,
      'X-Shopify-Webhook-Id': webhookId,
      'X-Shopify-Topic': 'orders/create',
      'X-Shopify-Shop-Domain': env.SHOPIFY_SHOP_DOMAIN,
      'X-Shopify-Api-Version': env.SHOPIFY_API_VERSION,
    },
    body,
  }, env);
}

function notificationDb(): D1Database {
  let snapshot: Record<string, unknown> | null = null;
  const notificationWebhookIds = new Set<string>();

  return {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async first() {
              if (sql.includes('FROM order_snapshots')) return snapshot;
              if (sql.includes('FROM account_links')) return { line_friend_id: 'friend-1' };
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO order_snapshots')) {
                snapshot = {
                  customer_id: values[2],
                  order_name: values[3],
                  total_price: values[4],
                  currency: values[5],
                  order_status_url: values[6],
                  line_items_json: values[7],
                  financial_status: values[8],
                  fulfillment_status: values[9],
                  cancelled_at: values[10],
                };
              }
              if (sql.includes('INSERT OR IGNORE INTO notification_log')) {
                const webhookId = String(values[1]);
                if (notificationWebhookIds.has(webhookId)) return { meta: { changes: 0 } };
                notificationWebhookIds.add(webhookId);
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as D1Database;
}

function queueMessage(job: ShopifyWebhookJob) {
  return {
    body: job,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function privacyDb() {
  const state = {
    accountLinks: [
      { shopDomain: 'shuuka.myshopify.com', customerId: '456', friendId: 'friend-1' },
      { shopDomain: 'shuuka.myshopify.com', customerId: '999', friendId: 'friend-2' },
      { shopDomain: 'other.myshopify.com', customerId: '456', friendId: 'friend-3' },
    ],
    orderSnapshots: [
      { shopDomain: 'shuuka.myshopify.com', customerId: '456' },
      { shopDomain: 'shuuka.myshopify.com', customerId: '999' },
      { shopDomain: 'other.myshopify.com', customerId: '456' },
    ],
    notificationLogs: [
      { webhookId: 'webhook-order-1', friendId: 'friend-1' },
      { webhookId: 'webhook-order-2', friendId: 'friend-2' },
      { webhookId: 'webhook-order-3', friendId: 'friend-3' },
    ],
    installations: ['shuuka.myshopify.com', 'other.myshopify.com'],
    merchantStates: ['shuuka.myshopify.com', 'other.myshopify.com'],
    customerLinkStates: ['state-1'],
    receipts: [
      { webhookId: 'webhook-order-1', shopDomain: 'shuuka.myshopify.com' },
      { webhookId: 'webhook-order-2', shopDomain: 'shuuka.myshopify.com' },
      { webhookId: 'webhook-order-3', shopDomain: 'other.myshopify.com' },
    ],
    privacyRequests: [
      { webhookId: 'privacy-old', shopDomain: 'shuuka.myshopify.com', customerId: '999' as string | null },
      { webhookId: 'privacy-other', shopDomain: 'other.myshopify.com', customerId: '456' as string | null },
    ],
  };

  function removeWhere<T>(rows: T[], remove: (row: T) => boolean): void {
    const retained = rows.filter((row) => !remove(row));
    rows.splice(0, rows.length, ...retained);
  }

  async function run(sql: string, values: unknown[]) {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('INSERT OR IGNORE INTO privacy_requests')) {
      state.privacyRequests.push({
        webhookId: String(values[0]),
        shopDomain: String(values[2]),
        customerId: values[3] == null ? null : String(values[3]),
      });
    } else if (normalized.startsWith('DELETE FROM notification_log') && normalized.includes('line_friend_id IN')) {
      const friendIds = new Set(state.accountLinks
        .filter((link) => link.shopDomain === values[0] && link.customerId === values[1])
        .map((link) => link.friendId));
      removeWhere(state.notificationLogs, (log) => friendIds.has(log.friendId));
    } else if (normalized.startsWith('DELETE FROM notification_log') && normalized.includes('webhook_id IN')) {
      const webhookIds = new Set(state.receipts
        .filter((receipt) => receipt.shopDomain === values[0])
        .map((receipt) => receipt.webhookId));
      removeWhere(state.notificationLogs, (log) => webhookIds.has(log.webhookId));
    } else if (normalized.startsWith('DELETE FROM order_snapshots') && normalized.includes('customer_id')) {
      removeWhere(state.orderSnapshots, (order) => (
        order.shopDomain === values[0] && order.customerId === values[1]
      ));
    } else if (normalized.startsWith('DELETE FROM order_snapshots')) {
      removeWhere(state.orderSnapshots, (order) => order.shopDomain === values[0]);
    } else if (normalized.startsWith('DELETE FROM account_links') && normalized.includes('shopify_customer_id')) {
      removeWhere(state.accountLinks, (link) => (
        link.shopDomain === values[0] && link.customerId === values[1]
      ));
    } else if (normalized.startsWith('DELETE FROM account_links')) {
      removeWhere(state.accountLinks, (link) => link.shopDomain === values[0]);
    } else if (normalized.startsWith('DELETE FROM privacy_requests')) {
      removeWhere(state.privacyRequests, (request) => request.shopDomain === values[0]);
    } else if (normalized.startsWith('DELETE FROM shop_installations')) {
      removeWhere(state.installations, (shopDomain) => shopDomain === values[0]);
    } else if (normalized.startsWith('DELETE FROM merchant_oauth_states')) {
      removeWhere(state.merchantStates, (shopDomain) => shopDomain === values[0]);
    } else if (normalized === 'DELETE FROM customer_link_states') {
      state.customerLinkStates.splice(0);
    } else if (normalized.startsWith('DELETE FROM webhook_receipts')) {
      removeWhere(state.receipts, (receipt) => receipt.shopDomain === values[0]);
    } else if (normalized.startsWith('UPDATE privacy_requests')) {
      const request = state.privacyRequests.find((item) => item.webhookId === values[1]);
      if (request && normalized.includes('customer_id = NULL')) request.customerId = null;
    }
    return { meta: { changes: 1 } };
  }

  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          return { run: () => run(sql, values) };
        },
        run: () => run(sql, []),
      };
    },
    async batch(statements: Array<{ run(): Promise<unknown> }>) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
  } as unknown as D1Database;
  return { db, state };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Shopify webhook delivery', () => {
  it('accepts Shopify retry after the first queue send fails', async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const env = {
      DB: receiptDb(),
      SHOPIFY_EVENTS: { send },
      SHOPIFY_API_SECRET: 'shopify-secret',
      SHOPIFY_SHOP_DOMAIN: 'shuuka.myshopify.com',
      SHOPIFY_API_VERSION: '2026-07',
    } as unknown as Env;
    const body = JSON.stringify({ id: 123, name: '#1001' });

    const failed = await webhookRequest(env, 'webhook-1', body);
    const retried = await webhookRequest(env, 'webhook-1', body);

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toEqual({ received: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends one LINE notification when a queue job is delivered twice', async () => {
    const requests: Array<{ url: string; method: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/messages')) {
        return Response.json({ success: true, data: { messageId: 'message-1' } });
      }
      return Response.json({ success: true, data: { id: 'friend-1' } });
    });
    const env = {
      DB: notificationDb(),
      LINE_HARNESS_API_URL: 'https://harness.example',
      LINE_HARNESS_API_KEY: 'harness-key',
    } as unknown as Env;
    const job: ShopifyWebhookJob = {
      webhookId: 'webhook-redelivery',
      topic: 'orders/create',
      shopDomain: 'shuuka.myshopify.com',
      apiVersion: '2026-07',
      receivedAt: '2026-07-24T00:00:00.000Z',
      body: JSON.stringify({
        id: 123,
        name: '#1001',
        total_price: '5000',
        currency: 'JPY',
        customer: { id: 456 },
        line_items: [{ name: '旬のブドウギフト', quantity: 1 }],
      }),
    };
    const first = queueMessage(job);
    const redelivered = queueMessage(job);

    await processQueue({ messages: [first] } as unknown as MessageBatch<ShopifyWebhookJob>, env);
    await processQueue({ messages: [redelivered] } as unknown as MessageBatch<ShopifyWebhookJob>, env);

    expect(requests.filter(({ url }) => url.endsWith('/messages'))).toHaveLength(1);
    expect(first.ack).toHaveBeenCalledOnce();
    expect(redelivered.ack).toHaveBeenCalledOnce();
  });

  it('records a failed job and retries it with a bounded backoff', async () => {
    const updates: unknown[][] = [];
    const env = {
      DB: {
        prepare(sql: string) {
          expect(sql).toContain("SET status = 'failed'");
          return {
            bind(...values: unknown[]) {
              updates.push(values);
              return { async run() { return { meta: { changes: 1 } }; } };
            },
          };
        },
      } as D1Database,
    } as unknown as Env;
    const job: ShopifyWebhookJob = {
      webhookId: 'webhook-failed',
      topic: 'orders/create',
      shopDomain: 'shuuka.myshopify.com',
      apiVersion: '2026-07',
      receivedAt: '2026-07-24T00:00:00.000Z',
      body: '{invalid-json',
    };
    const message = {
      ...queueMessage(job),
      attempts: 10,
    };

    await processQueue({ messages: [message] } as unknown as MessageBatch<ShopifyWebhookJob>, env);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.[1]).toBe('webhook-failed');
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 900 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('maps the order lifecycle to the five customer notifications', async () => {
    const notificationTitles: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.endsWith('/messages')) {
        const request = JSON.parse(String(init?.body)) as { content: string };
        const flex = JSON.parse(request.content) as {
          header: { contents: Array<{ text?: string }> };
        };
        notificationTitles.push(flex.header.contents[1]?.text ?? '');
        return Response.json({ success: true, data: { messageId: crypto.randomUUID() } });
      }
      return Response.json({ success: true, data: { id: 'friend-1' } });
    });
    const env = {
      DB: notificationDb(),
      LINE_HARNESS_API_URL: 'https://harness.example',
      LINE_HARNESS_API_KEY: 'harness-key',
    } as unknown as Env;
    const baseOrder = {
      id: 123,
      name: '#1001',
      total_price: '5000',
      currency: 'JPY',
      order_status_url: 'https://shuuka.jp/orders/status',
      customer: { id: 456 },
      line_items: [{ name: '旬のブドウギフト', quantity: 1 }],
    };
    const jobs: ShopifyWebhookJob[] = [
      {
        webhookId: 'webhook-created',
        topic: 'orders/create',
        shopDomain: 'shuuka.myshopify.com',
        apiVersion: '2026-07',
        receivedAt: '2026-07-24T00:00:00.000Z',
        body: JSON.stringify({ ...baseOrder, financial_status: 'pending' }),
      },
      {
        webhookId: 'webhook-paid',
        topic: 'orders/updated',
        shopDomain: 'shuuka.myshopify.com',
        apiVersion: '2026-07',
        receivedAt: '2026-07-24T00:01:00.000Z',
        body: JSON.stringify({ ...baseOrder, financial_status: 'paid' }),
      },
      {
        webhookId: 'webhook-fulfilled',
        topic: 'orders/fulfilled',
        shopDomain: 'shuuka.myshopify.com',
        apiVersion: '2026-07',
        receivedAt: '2026-07-24T00:02:00.000Z',
        body: JSON.stringify({ ...baseOrder, financial_status: 'paid', fulfillment_status: 'fulfilled' }),
      },
      {
        webhookId: 'webhook-cancelled',
        topic: 'orders/updated',
        shopDomain: 'shuuka.myshopify.com',
        apiVersion: '2026-07',
        receivedAt: '2026-07-24T00:03:00.000Z',
        body: JSON.stringify({
          ...baseOrder,
          financial_status: 'paid',
          fulfillment_status: 'fulfilled',
          cancelled_at: '2026-07-24T00:03:00.000Z',
        }),
      },
      {
        webhookId: 'webhook-refunded',
        topic: 'refunds/create',
        shopDomain: 'shuuka.myshopify.com',
        apiVersion: '2026-07',
        receivedAt: '2026-07-24T00:04:00.000Z',
        body: JSON.stringify({ order_id: 123 }),
      },
    ];

    await processQueue({
      messages: jobs.map(queueMessage),
    } as unknown as MessageBatch<ShopifyWebhookJob>, env);

    expect(notificationTitles).toEqual([
      'ご注文ありがとうございます',
      'お支払いを確認しました',
      '商品を発送しました',
      'ご注文をキャンセルしました',
      '返金手続きを受け付けました',
    ]);
  });

  it('deletes linked customer and order data for customers/redact', async () => {
    const { db, state } = privacyDb();
    const env = { DB: db } as unknown as Env;
    const message = queueMessage({
      webhookId: 'webhook-customer-redact',
      topic: 'customers/redact',
      shopDomain: 'shuuka.myshopify.com',
      apiVersion: '2026-07',
      receivedAt: '2026-07-24T00:00:00.000Z',
      body: JSON.stringify({ customer: { id: 456 } }),
    });

    await processQueue({ messages: [message] } as unknown as MessageBatch<ShopifyWebhookJob>, env);

    expect(state.accountLinks).toEqual([
      { shopDomain: 'shuuka.myshopify.com', customerId: '999', friendId: 'friend-2' },
      { shopDomain: 'other.myshopify.com', customerId: '456', friendId: 'friend-3' },
    ]);
    expect(state.orderSnapshots).toEqual([
      { shopDomain: 'shuuka.myshopify.com', customerId: '999' },
      { shopDomain: 'other.myshopify.com', customerId: '456' },
    ]);
    expect(state.notificationLogs.map(({ friendId }) => friendId)).toEqual(['friend-2', 'friend-3']);
    expect(state.privacyRequests.find(({ webhookId }) => webhookId === 'webhook-customer-redact')?.customerId)
      .toBeNull();
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('deletes all stored customer data for shop/redact', async () => {
    const { db, state } = privacyDb();
    const env = { DB: db } as unknown as Env;
    const message = queueMessage({
      webhookId: 'webhook-shop-redact',
      topic: 'shop/redact',
      shopDomain: 'shuuka.myshopify.com',
      apiVersion: '2026-07',
      receivedAt: '2026-07-24T00:00:00.000Z',
      body: JSON.stringify({ shop_id: 789, shop_domain: 'shuuka.myshopify.com' }),
    });

    await processQueue({ messages: [message] } as unknown as MessageBatch<ShopifyWebhookJob>, env);

    expect(state.accountLinks).toEqual([
      { shopDomain: 'other.myshopify.com', customerId: '456', friendId: 'friend-3' },
    ]);
    expect(state.orderSnapshots).toEqual([
      { shopDomain: 'other.myshopify.com', customerId: '456' },
    ]);
    expect(state.notificationLogs).toEqual([
      { webhookId: 'webhook-order-3', friendId: 'friend-3' },
    ]);
    expect(state.installations).toEqual(['other.myshopify.com']);
    expect(state.merchantStates).toEqual(['other.myshopify.com']);
    expect(state.receipts).toEqual([
      { webhookId: 'webhook-order-3', shopDomain: 'other.myshopify.com' },
    ]);
    expect(state.privacyRequests).toEqual([
      { webhookId: 'privacy-other', shopDomain: 'other.myshopify.com', customerId: '456' },
    ]);
    expect(state.customerLinkStates).toEqual([]);
    expect(message.ack).toHaveBeenCalledOnce();
  });
});
