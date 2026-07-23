# 祝果 Shopify × LINE Harness Bridge

Cloudflare Workers / D1 / Queues 上で、祝果 Shopify と LINE Harness を接続する単一ストア向け連携です。

## 責務

- ShopifyアプリのインストールOAuthとWebhook署名検証
- `X-Shopify-Webhook-Id` による重複排除
- Queue経由の非同期処理とDLQ
- LINE本人確認チケットとShopify Customer Account APIによる顧客連携
- 注文受付・入金・発送・キャンセル・返金のFlex Message
- D1上の顧客対応表とプライバシーWebhook処理

LINE Messaging APIへは直接送信せず、すべてLINE Harness SDK経由で配信します。

## シークレット

次の値は `wrangler secret put` で登録し、設定ファイルやGitには保存しません。

- `LINE_HARNESS_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_TOKEN_ENCRYPTION_KEY`（32バイト）
- `SHOPIFY_LINK_SIGNING_SECRET`
- `SHOPIFY_CUSTOMER_ACCOUNT_CLIENT_SECRET`

## 導線

リッチメニューの「会員連携」から `/connect` を開きます。LINE HarnessがLINE本人を確認し、5分間有効・一度だけ使える署名付きチケットを発行します。その後Shopifyのパスワードレス会員認証を行い、D1へ対応関係を保存します。
