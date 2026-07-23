# 祝果 一商品・松竹梅 移行手順

## 目的

祝果の商品を品種別に並べず、季節商品「旬のブドウギフト」一つに統合する。購入者は品種ではなく贈る理由から、梅・竹・松の三つのお仕立てを選ぶ。九品種は「今季のお仕立て候補」として説明に使い、品種指定の購入選択肢にはしない。

## 公開後の構造

| 贈答格 | 購入理由 | 価格 | 今季の候補 |
| --- | --- | ---: | --- |
| 梅 | 迷わず贈れる、旬の定番 | ¥5,000 | シャインマスカット、巨峰、シナノスマイル |
| 竹 | 箱を開けた瞬間に、華やぐ | ¥10,000 | サンシャインレッド、スカーレット、マスカットノワール |
| 松 | 記憶に残る、特別な贈りもの | ¥20,000 | 富士の輝き、クイーンニーナ、マイハート |

販売価格は商品バリエーションを正とする。`gift.tiers` 内の `price_label` は説明表示用なので、価格変更時は両方を同じ作業で更新する。

## 変更対象

- 主商品: `grape-gift-3kg` を公開上の唯一の商品にする。内部ハンドルと既存SKUは注文・連携互換のため維持する。
- 旧プレミアム商品: `premium-grape-gift` の松バリエーションを主商品へ移し、全経路確認後にアーカイブする。
- 商品メタフィールド:
  - `gift.tiers` (`json`): 松竹梅の訴求・候補・表示価格
  - `gift.varieties` (`json`): 九品種の収穫時期・説明
- テーマ: メタフィールドがあれば管理データを表示し、未登録時は2026年の確定内容へフォールバックする。

## 必須の実行条件

1. 対象ストアが `ksz15x-gq.myshopify.com` であることを実API応答で確認する。
2. 商品更新の明示承認を得る。
3. `gift_architecture_preflight.graphql` を直前に実行し、商品ID、バリエーションID、オプションID、在庫ロケーション、数量、既存メタフィールド、既存リダイレクトを保存する。
4. 既知のIDや在庫がプリフライトと一つでも違う場合は、変数ファイルを直して再検証するまで書き込まない。
5. `gift_product_unify.variables.example.json` の `_..._FROM_PREFLIGHT_` をすべて置換する。数量は文字列ではなく整数にする。

検証済みGraphQLから必要になるスコープは `read_products`, `write_products`, `read_inventory`, `read_locations`, `read_markets_home`, `read_online_store_navigation`, `write_online_store_navigation`。作業用認証にはこれを超える権限を付けない。

## 実行順序

1. `gift_architecture_preflight.graphql` を実行してJSON応答を退避する。
   - 2026-07-23の基準値は `gift_architecture_preflight.snapshot.json` に正規化して保存済み。ただし実行直前に再取得し、在庫差分を優先する。
2. `gift` 定義がない場合だけ `gift_definitions_create.graphql` を実行する。
3. `gift_product_option_prepare.graphql`、`gift_matsu_variant_create.graphql`、`gift_product_copy_update.graphql` の順で実行する。
   - 2026-07-23の `productSet` 一括更新は汎用エラーで無変更終了したため、成功した分割操作を正とする。
   - 梅・竹は既存バリエーションIDと在庫を維持する。
   - 松は旧プレミアム商品の現在庫と同じロケーション・数量で新規作成する。
   - 初回移行済みのため、前二つの作成操作は再実行しない。
4. `gift_architecture_verify.graphql` で主商品が三バリエーションになり、順序が梅・竹・松、価格が5000・10000・20000、SKUと在庫が想定どおりであることを確認する。
5. 初回登録では `build_gift_metafields.mjs` を実行し、`compareDigest: null` の作成専用入力を生成する。既存値の更新ではプリフライトのdigestを `--tiers-digest` と `--varieties-digest` に指定する。
6. `gift_metafields_set.graphql` を実行する。二つの値は一回の原子的更新で登録する。
7. 開発テーマでPC、393 px、457 pxを確認する。
   - トップ、商品詳細、予約、ギフトガイド、コレクション、ヘッダー・フッター到達ページ
   - 三つの贈答格、九品種候補、横スクロールなし
   - 梅・竹・松を選んだ時に、カート投入対象のvariant IDと`贈答格`プロパティが一致
8. 本番テーマを反映し、同じ表示・選択・カート確認を繰り返す。
9. 主商品の松が購入対象になっていることを確認した後にだけ、`gift_retire_premium.graphql` で旧商品をアーカイブし、旧URLから主商品へのリダイレクトを作る。旧商品ハンドルが転送より優先される場合は `gift_archive_handle.graphql` で退避ハンドルへ変更する。
10. `gift_architecture_verify.graphql` と公開ストアで、旧URLの転送、旧商品が非公開、主商品三段階が購入可能であることを確認する。

## 季節更新

1. `gift_content_2026.json` を次季の確定内容へ更新する。
2. 現在の二メタフィールドの`compareDigest`を取得する。
3. 次を実行して値入力を再生成する。

```sh
node scripts/shopify_setup/build_gift_metafields.mjs \
  --owner-id gid://shopify/Product/9431536074940 \
  --tiers-digest CURRENT_TIERS_DIGEST \
  --varieties-digest CURRENT_VARIETIES_DIGEST
```

4. GraphQL検証後に`gift_metafields_set.graphql`を実行し、開発テーマで確認してから本番表示を確認する。

## 中止・復旧

- 主商品統合の検証に失敗した場合、旧プレミアム商品は触らず、プリフライトの退避JSONから主商品のオプション・バリエーション・在庫を戻す。
- 本番テーマ反映後に不具合が出た場合、直前の本番テーマへ戻す。旧商品はアーカイブしない。
- 旧商品のアーカイブ後に旧導線の問題が出た場合、`gift_restore_premium.graphql` で旧商品を再度`ACTIVE`にし、作成したリダイレクトIDを削除する。
- 復旧後も主商品の松バリエーションを自動削除しない。注文参照を壊す可能性があるため、注文・在庫を確認して別作業で判断する。
