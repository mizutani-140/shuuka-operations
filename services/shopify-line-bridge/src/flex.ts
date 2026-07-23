import type { ShopifyOrderPayload } from './types.js';

type FlexComponent = Record<string, unknown>;

export type NotificationContent = {
  altText: string;
  flexJson: string;
};

function clean(value: unknown, fallback = '—', max = 80): string {
  if (typeof value !== 'string' && typeof value !== 'number') return fallback;
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  return normalized.slice(0, max);
}

function money(order: ShopifyOrderPayload): string {
  const amount = clean(order.total_price, '0', 24);
  const currency = clean(order.currency, 'JPY', 8);
  if (currency === 'JPY') return `¥${Number(amount).toLocaleString('ja-JP')}`;
  return `${amount} ${currency}`;
}

function row(label: string, value: string): FlexComponent {
  return {
    type: 'box',
    layout: 'baseline',
    margin: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: '#7B6A58', flex: 2 },
      { type: 'text', text: value, size: 'sm', color: '#2D241C', flex: 4, wrap: true, align: 'end' },
    ],
  };
}

function validHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function bubble(
  title: string,
  lead: string,
  order: ShopifyOrderPayload,
  accent: string,
  extraRows: FlexComponent[] = [],
): NotificationContent {
  const orderName = clean(order.name ?? (order.order_number ? `#${order.order_number}` : order.id), 'ご注文');
  const itemSummary = (order.line_items ?? [])
    .slice(0, 3)
    .map((item) => `${clean(item.name ?? item.title, '商品', 34)} ×${item.quantity ?? 1}`)
    .join('\n');
  const statusUrl = validHttpsUrl(order.order_status_url);
  const footerContents: FlexComponent[] = [];
  if (statusUrl) {
    footerContents.push({
      type: 'button',
      style: 'primary',
      color: '#6F3C2C',
      height: 'sm',
      action: { type: 'uri', label: '配送・注文状況を見る', uri: statusUrl },
    });
  }
  footerContents.push({
    type: 'button',
    style: 'link',
    height: 'sm',
    action: { type: 'uri', label: '祝果オンラインストア', uri: 'https://shuuka.jp/' },
  });

  const contents = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: accent,
      paddingAll: '20px',
      contents: [
        { type: 'text', text: '祝果 SHUUKA', color: '#FFFFFF', size: 'xs', weight: 'bold' },
        { type: 'text', text: title, color: '#FFFFFF', size: 'xl', weight: 'bold', margin: 'md', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      paddingAll: '20px',
      contents: [
        { type: 'text', text: lead, color: '#2D241C', size: 'md', wrap: true },
        { type: 'separator', margin: 'xl', color: '#E8DED4' },
        row('注文番号', orderName),
        row('合計', money(order)),
        ...(itemSummary ? [row('商品', itemSummary)] : []),
        ...extraRows,
        { type: 'text', text: 'ご不明点は、このLINEにメッセージをお送りください。', size: 'xs', color: '#8A7A6A', wrap: true, margin: 'xl' },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      paddingAll: '16px',
      contents: footerContents,
    },
    styles: { footer: { separator: true, separatorColor: '#E8DED4' } },
  };

  return {
    altText: `祝果｜${title}（${orderName}）`,
    flexJson: JSON.stringify(contents),
  };
}

export function orderCreatedFlex(order: ShopifyOrderPayload): NotificationContent {
  return bubble('ご注文ありがとうございます', 'ご注文を受け付けました。旬の果実を丁寧に準備いたします。', order, '#6F3C2C');
}

export function orderPaidFlex(order: ShopifyOrderPayload): NotificationContent {
  return bubble('お支払いを確認しました', 'お支払いの確認が取れました。発送準備が整い次第、LINEでお知らせします。', order, '#3E6B4F');
}

export function orderFulfilledFlex(order: ShopifyOrderPayload): NotificationContent {
  return bubble('商品を発送しました', '祝果から旬のおいしさを発送しました。到着まで今しばらくお待ちください。', order, '#B06C2E');
}

export function orderCancelledFlex(order: ShopifyOrderPayload): NotificationContent {
  return bubble('ご注文をキャンセルしました', 'ご注文のキャンセルを受け付けました。返金時期は決済方法により異なります。', order, '#7A6A60');
}

export function refundCreatedFlex(order: ShopifyOrderPayload): NotificationContent {
  return bubble('返金手続きを受け付けました', '返金処理を開始しました。反映時期はカード会社・決済方法により異なります。', order, '#7A6A60');
}
