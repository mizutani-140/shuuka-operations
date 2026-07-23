# 祝果 Shopify管理データ

このディレクトリには、祝果ストアの初期構築用ファイルと現在の移行用ファイルが共存しています。

## 現在の正本

一商品・松竹梅構成の作業では、次を正本として使用します。

- `GIFT_ARCHITECTURE_ROLLOUT.md`: 実行順序、確認項目、復旧手順
- `gift_architecture_preflight.graphql`: 書き込み直前の現状取得
- `gift_architecture_preflight.snapshot.json`: 2026-07-23時点の基準値
- `gift_architecture_final.snapshot.json`: 2026-07-23移行完了時のID・在庫・digest・転送ID
- `gift_product_option_prepare.graphql`: 既存オプションを梅・竹へ改名し、松の値を追加した実行記録
- `gift_matsu_variant_create.graphql`: 主商品へ松バリエーションを追加した実行記録
- `gift_product_copy_update.graphql`: 主商品の本文・タグ・商品種別を更新
- `gift_definitions_create.graphql`: 商品メタフィールド定義
- `gift_content_2026.json`: 松竹梅と九品種候補の編集用データ
- `build_gift_metafields.mjs`: 編集用データからGraphQL変数を生成
- `gift_metafields_set.graphql`: 松竹梅と品種候補を原子的に登録
- `gift_architecture_verify.graphql`: 移行後の確認
- `gift_retire_premium.graphql`: 全経路確認後に旧商品をアーカイブ
- `gift_archive_handle.graphql`: 旧商品ハンドルを退避し、旧URL転送を有効化
- `gift_restore_premium.graphql`: 旧商品と旧URLを復旧

対象ストアは `ksz15x-gq.myshopify.com`（公開ドメイン `shuuka.jp`）。本番実行時はストア名「祝果」をAPI応答で確認してから進めます。

`gift_product_unify.graphql` は2026-07-23に `productSet` の汎用エラーで無変更終了した試行記録です。再実行せず、実際に成功した分割操作を参照します。`gift_product_option_prepare` と `gift_matsu_variant_create` も作成済みの値・バリエーションを重複させるため再実行しません。

## 旧初期構築ファイル

次のファイルは、秀品・超秀品・プレミアム商品を別管理していた初期構築時の記録です。現在の商品更新には使用しません。

- `product_set.graphql`
- `product_middle.variables.json`
- `product_premium.variables.json`
- `publish_product.graphql`

これらを再実行すると、公開文言や商品構造が旧設計へ戻る可能性があります。履歴確認以外では使わず、現在の移行は上記「現在の正本」だけで行います。

ページ・ポリシー関連の既存GraphQLは、対象ページを個別に更新する時だけ使用します。商品移行と同時に一括再実行しません。
