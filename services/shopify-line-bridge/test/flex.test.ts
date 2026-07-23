import { describe, expect, it } from 'vitest';
import { orderCreatedFlex, orderFulfilledFlex } from '../src/flex.js';

const order = {
  id: 123,
  name: '#1001',
  total_price: '12800',
  currency: 'JPY',
  order_status_url: 'https://shuuka.jp/orders/status',
  customer: { id: 456 },
  line_items: [{ name: '旬のぶどう 特選', quantity: 1 }],
};

describe('Flex Message builders', () => {
  it('creates a valid order confirmation bubble', () => {
    const message = orderCreatedFlex(order);
    const flex = JSON.parse(message.flexJson) as { type: string; body: { contents: unknown[] } };
    expect(message.altText).toContain('#1001');
    expect(flex.type).toBe('bubble');
    expect(flex.body.contents.length).toBeGreaterThan(4);
  });

  it('uses a shipping-specific title', () => {
    const message = orderFulfilledFlex(order);
    expect(message.altText).toContain('発送');
  });
});
