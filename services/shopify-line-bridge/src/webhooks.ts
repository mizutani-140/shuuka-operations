import type { Context } from 'hono';
import { createHarness } from './harness.js';
import {
  orderCancelledFlex,
  orderCreatedFlex,
  orderFulfilledFlex,
  orderPaidFlex,
  refundCreatedFlex,
  type NotificationContent,
} from './flex.js';
import { verifyShopifyWebhook } from './security.js';
import type { ShopifyOrderPayload, ShopifyWebhookJob } from './types.js';

type OrderSnapshot = {
  customer_id: string | null;
  order_name: string | null;
  total_price: string | null;
  currency: string | null;
  order_status_url: string | null;
  line_items_json: string | null;
  financial_status: string | null;
  fulfillment_status: string | null;
  cancelled_at: string | null;
};

function normalizeId(value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || !value) return null;
  return value.split('/').at(-1) ?? value;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function receiveShopifyWebhook(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rawBody = await c.req.raw.text();
  const signature = c.req.header('X-Shopify-Hmac-Sha256') ?? '';
  const webhookId = c.req.header('X-Shopify-Webhook-Id') ?? '';
  const topic = (c.req.header('X-Shopify-Topic') ?? '').toLowerCase();
  const shopDomain = (c.req.header('X-Shopify-Shop-Domain') ?? '').toLowerCase();
  const apiVersion = c.req.header('X-Shopify-Api-Version') ?? null;
  if (!signature || !webhookId || !topic || shopDomain !== c.env.SHOPIFY_SHOP_DOMAIN.toLowerCase()) {
    return jsonResponse({ error: 'invalid_headers' }, 401);
  }
  if (!(await verifyShopifyWebhook(rawBody, signature, c.env.SHOPIFY_API_SECRET))) {
    return jsonResponse({ error: 'invalid_signature' }, 401);
  }

  const receivedAt = new Date().toISOString();
  const inserted = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO webhook_receipts
      (webhook_id, topic, shop_domain, api_version, status, received_at)
     VALUES (?, ?, ?, ?, 'queued', ?)`,
  )
    .bind(webhookId, topic, shopDomain, apiVersion, receivedAt)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return jsonResponse({ received: true, duplicate: true });

  const job: ShopifyWebhookJob = { webhookId, topic, shopDomain, apiVersion, body: rawBody, receivedAt };
  await c.env.SHOPIFY_EVENTS.send(job, { contentType: 'json' });
  return jsonResponse({ received: true });
}

async function saveOrderSnapshot(env: Env, shopDomain: string, order: ShopifyOrderPayload): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO order_snapshots
      (shop_domain, order_id, customer_id, order_name, total_price, currency, order_status_url,
       line_items_json, financial_status, fulfillment_status, cancelled_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(shop_domain, order_id) DO UPDATE SET
       customer_id = excluded.customer_id,
       order_name = excluded.order_name,
       total_price = excluded.total_price,
       currency = excluded.currency,
       order_status_url = excluded.order_status_url,
       line_items_json = excluded.line_items_json,
       financial_status = excluded.financial_status,
       fulfillment_status = excluded.fulfillment_status,
       cancelled_at = excluded.cancelled_at,
       updated_at = excluded.updated_at`,
  )
    .bind(
      shopDomain,
      normalizeId(order.id),
      normalizeId(order.customer?.id),
      order.name ?? null,
      order.total_price ?? null,
      order.currency ?? null,
      order.order_status_url ?? null,
      JSON.stringify(order.line_items ?? []),
      order.financial_status ?? null,
      order.fulfillment_status ?? null,
      order.cancelled_at ?? null,
      now,
    )
    .run();
}

async function getSnapshot(env: Env, shopDomain: string, orderId: string): Promise<OrderSnapshot | null> {
  return env.DB.prepare(
    `SELECT customer_id, order_name, total_price, currency, order_status_url, line_items_json,
            financial_status, fulfillment_status, cancelled_at
       FROM order_snapshots WHERE shop_domain = ? AND order_id = ?`,
  )
    .bind(shopDomain, orderId)
    .first<OrderSnapshot>();
}

function orderFromSnapshot(orderId: string, snapshot: OrderSnapshot): ShopifyOrderPayload {
  return {
    id: orderId,
    name: snapshot.order_name ?? undefined,
    total_price: snapshot.total_price ?? undefined,
    currency: snapshot.currency ?? undefined,
    order_status_url: snapshot.order_status_url,
    customer: snapshot.customer_id ? { id: snapshot.customer_id } : null,
    line_items: JSON.parse(snapshot.line_items_json ?? '[]') as ShopifyOrderPayload['line_items'],
    financial_status: snapshot.financial_status,
    fulfillment_status: snapshot.fulfillment_status,
    cancelled_at: snapshot.cancelled_at,
  };
}

async function sendNotification(
  env: Env,
  job: ShopifyWebhookJob,
  customerId: string,
  content: NotificationContent,
  order: ShopifyOrderPayload,
): Promise<void> {
  const link = await env.DB.prepare(
    `SELECT line_friend_id FROM account_links
      WHERE shop_domain = ? AND shopify_customer_id = ? AND status = 'active'`,
  )
    .bind(job.shopDomain, customerId)
    .first<{ line_friend_id: string }>();
  if (!link) return;

  const logId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO notification_log
      (id, webhook_id, line_friend_id, topic, status, created_at)
     VALUES (?, ?, ?, ?, 'sending', ?)`,
  )
    .bind(logId, job.webhookId, link.line_friend_id, job.topic, new Date().toISOString())
    .run();

  const harness = createHarness(env);
  try {
    await harness.sendFlexToFriend(link.line_friend_id, content.flexJson);
    await Promise.all([
      env.DB.prepare(
        `UPDATE notification_log SET status = 'sent', sent_at = ? WHERE webhook_id = ?`,
      ).bind(new Date().toISOString(), job.webhookId).run(),
      harness.friends.setMetadata(link.line_friend_id, {
        shopify_last_order_id: normalizeId(order.id),
        shopify_last_order_name: order.name ?? null,
        shopify_last_order_topic: job.topic,
        shopify_last_order_at: new Date().toISOString(),
      }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : 'notification_failed';
    await env.DB.prepare(
      `UPDATE notification_log SET status = 'failed', error = ? WHERE webhook_id = ?`,
    ).bind(message, job.webhookId).run();
    throw error;
  }
}

async function processOrder(env: Env, job: ShopifyWebhookJob, order: ShopifyOrderPayload): Promise<void> {
  const orderId = normalizeId(order.id);
  const customerId = normalizeId(order.customer?.id);
  if (!orderId) return;
  const previous = await getSnapshot(env, job.shopDomain, orderId);
  await saveOrderSnapshot(env, job.shopDomain, order);
  if (!customerId) return;

  if (job.topic === 'orders/create') {
    await sendNotification(env, job, customerId, orderCreatedFlex(order), order);
    return;
  }
  if (job.topic === 'orders/fulfilled') {
    await sendNotification(env, job, customerId, orderFulfilledFlex(order), order);
    return;
  }
  if (job.topic === 'orders/updated') {
    if (order.cancelled_at && !previous?.cancelled_at) {
      await sendNotification(env, job, customerId, orderCancelledFlex(order), order);
    } else if (order.financial_status === 'paid' && previous?.financial_status !== 'paid') {
      await sendNotification(env, job, customerId, orderPaidFlex(order), order);
    }
  }
}

async function processRefund(env: Env, job: ShopifyWebhookJob, refund: Record<string, unknown>): Promise<void> {
  const orderId = normalizeId(refund.order_id);
  if (!orderId) return;
  const snapshot = await getSnapshot(env, job.shopDomain, orderId);
  if (!snapshot?.customer_id) return;
  const order = orderFromSnapshot(orderId, snapshot);
  await sendNotification(env, job, snapshot.customer_id, refundCreatedFlex(order), order);
}

async function processPrivacy(env: Env, job: ShopifyWebhookJob, payload: Record<string, unknown>): Promise<void> {
  const customerObject = payload.customer as { id?: unknown } | undefined;
  const customerId = normalizeId(payload.customer_id ?? customerObject?.id);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO privacy_requests
      (webhook_id, topic, shop_domain, customer_id, requested_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(job.webhookId, job.topic, job.shopDomain, customerId, new Date().toISOString())
    .run();

  if (job.topic === 'customers/redact' && customerId) {
    await env.DB.prepare(
      `UPDATE account_links
          SET status = 'redacted', customer_display_name = NULL, customer_email_hash = NULL, updated_at = ?
        WHERE shop_domain = ? AND shopify_customer_id = ?`,
    ).bind(new Date().toISOString(), job.shopDomain, customerId).run();
  }
  if (job.topic === 'shop/redact') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM account_links WHERE shop_domain = ?').bind(job.shopDomain),
      env.DB.prepare('DELETE FROM shop_installations WHERE shop_domain = ?').bind(job.shopDomain),
    ]);
  }
  await env.DB.prepare('UPDATE privacy_requests SET completed_at = ? WHERE webhook_id = ?')
    .bind(new Date().toISOString(), job.webhookId)
    .run();
}

export async function processShopifyWebhook(env: Env, job: ShopifyWebhookJob): Promise<void> {
  const payload = JSON.parse(job.body) as Record<string, unknown>;
  switch (job.topic) {
    case 'orders/create':
    case 'orders/updated':
    case 'orders/fulfilled':
      await processOrder(env, job, payload as unknown as ShopifyOrderPayload);
      break;
    case 'refunds/create':
      await processRefund(env, job, payload);
      break;
    case 'app/uninstalled':
      await env.DB.prepare('DELETE FROM shop_installations WHERE shop_domain = ?').bind(job.shopDomain).run();
      break;
    case 'customers/data_request':
    case 'customers/redact':
    case 'shop/redact':
      await processPrivacy(env, job, payload);
      break;
    default:
      console.log(JSON.stringify({ event: 'shopify_webhook_ignored', topic: job.topic, webhookId: job.webhookId }));
  }
  await env.DB.prepare(
    `UPDATE webhook_receipts SET status = 'processed', processed_at = ?, last_error = NULL WHERE webhook_id = ?`,
  ).bind(new Date().toISOString(), job.webhookId).run();
}

export async function processQueue(batch: MessageBatch<ShopifyWebhookJob>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await processShopifyWebhook(env, message.body);
      message.ack();
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : 'queue_processing_failed';
      console.error(JSON.stringify({ event: 'shopify_webhook_failed', webhookId: message.body.webhookId, topic: message.body.topic, detail }));
      await env.DB.prepare(
        `UPDATE webhook_receipts SET status = 'failed', last_error = ? WHERE webhook_id = ?`,
      ).bind(detail, message.body.webhookId).run();
      message.retry({ delaySeconds: Math.min(900, 30 * 2 ** Math.min(message.attempts, 5)) });
    }
  }
}
