import { LineHarness } from '@line-harness/sdk';

export function createHarness(env: Env): LineHarness {
  return new LineHarness({
    apiUrl: env.LINE_HARNESS_API_URL,
    apiKey: env.LINE_HARNESS_API_KEY,
  });
}

export async function markFriendLinked(
  env: Env,
  friendId: string,
  customerId: string,
  displayName: string | null,
): Promise<void> {
  const harness = createHarness(env);
  const now = new Date().toISOString();
  await harness.friends.setMetadata(friendId, {
    shopify_linked: true,
    shopify_customer_id: customerId,
    shopify_customer_name: displayName,
    shopify_linked_at: now,
  });

  const tags = await harness.tags.list();
  let linkedTag = tags.find((tag) => tag.name === 'Shopify連携済み');
  if (!linkedTag) {
    linkedTag = await harness.tags.create({ name: 'Shopify連携済み', color: '#6F3C2C' });
  }
  await harness.friends.addTag(friendId, linkedTag.id);
}
