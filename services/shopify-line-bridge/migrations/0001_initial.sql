PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS shop_installations (
  shop_domain TEXT PRIMARY KEY,
  encrypted_access_token TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  installed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS merchant_oauth_states (
  state TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customer_link_states (
  state TEXT PRIMARY KEY,
  ticket_nonce TEXT NOT NULL UNIQUE,
  line_friend_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  harness_user_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account_links (
  id TEXT PRIMARY KEY,
  shop_domain TEXT NOT NULL,
  shopify_customer_id TEXT NOT NULL,
  line_friend_id TEXT NOT NULL,
  line_user_id TEXT NOT NULL,
  harness_user_id TEXT NOT NULL,
  customer_display_name TEXT,
  customer_email_hash TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (shop_domain, shopify_customer_id),
  UNIQUE (shop_domain, line_friend_id)
);

CREATE INDEX IF NOT EXISTS idx_account_links_customer
  ON account_links (shop_domain, shopify_customer_id, status);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  api_version TEXT,
  status TEXT NOT NULL,
  received_at TEXT NOT NULL,
  processed_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS order_snapshots (
  shop_domain TEXT NOT NULL,
  order_id TEXT NOT NULL,
  customer_id TEXT,
  order_name TEXT,
  total_price TEXT,
  currency TEXT,
  order_status_url TEXT,
  line_items_json TEXT,
  financial_status TEXT,
  fulfillment_status TEXT,
  cancelled_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (shop_domain, order_id)
);

CREATE TABLE IF NOT EXISTS notification_log (
  id TEXT PRIMARY KEY,
  webhook_id TEXT NOT NULL UNIQUE,
  line_friend_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS privacy_requests (
  webhook_id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  shop_domain TEXT NOT NULL,
  customer_id TEXT,
  requested_at TEXT NOT NULL,
  completed_at TEXT
);
