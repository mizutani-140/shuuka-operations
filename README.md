# 祝果 Operations

祝果のShopify–LINE連携と、本番データ変更手順を管理する非公開リポジトリです。

## 管理対象

- `services/shopify-line-bridge/`: ShopifyとLINE Harnessを接続するCloudflare Worker
- `scripts/shopify_setup/`: Shopifyの商品・ページ・ポリシー変更のGraphQL、変数、検証・復旧手順
- `deploy/line-harness/wrangler.toml`: 祝果用LINE Harness配備設定の秘密情報を含まないスナップショット

Shopifyテーマは `mizutani-140/shuuka-shopify-theme`、LINE Harness本体は
`Shudesu/line-harness-oss` で別管理します。このリポジトリへ入れ子Gitリポジトリとして追加しません。

## 安全境界

- `.env`、`.dev.vars`、秘密鍵、Shopify CLI状態、Cloudflareローカル状態はGitへ保存しません。
- Bridgeの秘密値は `wrangler secret put` で登録します。
- Shopify本番書き込みは、対象ストアとプリフライト結果を確認し、明示承認を得てから実行します。
- `scripts/shopify_setup/README.md` と `GIFT_ARCHITECTURE_ROLLOUT.md` を正本とし、旧商品設計用のGraphQLを再実行しません。

## Bridgeのローカル検証

```sh
pnpm --dir services/shopify-line-bridge typecheck
pnpm --dir services/shopify-line-bridge test
```

## LINE Harness配備設定

`deploy/line-harness/wrangler.toml` は、LINE Harness公開OSSへ祝果固有IDを混ぜないための保管用正本です。
配備前に、独立checkoutの `services/line-harness/apps/worker/wrangler.toml` と内容を比較して使用します。

秘密値 `SHOPIFY_LINK_SIGNING_SECRET` はこのファイルへ追加せず、Cloudflare Worker secretとして設定します。
