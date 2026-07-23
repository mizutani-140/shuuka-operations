export type ShopifyWebhookJob = {
  webhookId: string;
  topic: string;
  shopDomain: string;
  apiVersion: string | null;
  body: string;
  receivedAt: string;
};

export type LinkTicketPayload = {
  v: 1;
  aud: string;
  friendId: string;
  lineUserId: string;
  userId: string;
  nonce: string;
  exp: number;
};

export type ShopifyOrderPayload = {
  id: number | string;
  name?: string;
  order_number?: number;
  total_price?: string;
  currency?: string;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  order_status_url?: string | null;
  customer?: { id?: number | string; email?: string | null } | null;
  line_items?: Array<{ name?: string; title?: string; quantity?: number }>;
};

declare global {
  interface Env {
    SHOPIFY_API_SECRET: string;
    SHOPIFY_TOKEN_ENCRYPTION_KEY: string;
    SHOPIFY_LINK_SIGNING_SECRET: string;
    SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET: string;
    LINE_HARNESS_API_KEY: string;
  }
}

export {};
