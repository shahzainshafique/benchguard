/**
 * Domain logic for a `GET /orders` endpoint: take the raw orders and customers
 * (say, two queries you already ran) and stitch them into the response objects
 * the API returns: customer name, tier, and each order's total.
 *
 * This is the kind of hot path that runs on every request. It's also exactly
 * where an innocent-looking change turns O(n) into O(n²): swap the Map lookup
 * below for `customers.find(...)` and the OUTPUT stays identical. Every test
 * still passes, but latency explodes as your customer table grows. That is the
 * regression benchguard is built to catch.
 */

export interface Customer {
  id: string;
  name: string;
  tier: "free" | "pro" | "enterprise";
}

export interface LineItem {
  sku: string;
  qty: number;
  unitPriceCents: number;
}

export interface Order {
  id: string;
  customerId: string;
  items: LineItem[];
}

export interface EnrichedOrder {
  id: string;
  customerName: string;
  tier: Customer["tier"];
  totalCents: number;
}

export function enrichOrders(orders: Order[], customers: Customer[]): EnrichedOrder[] {
  // Index customers once: O(customers). Every lookup below is then O(1).
  const byId = new Map(customers.map((c) => [c.id, c]));

  return orders.map((order) => {
    const customer = byId.get(order.customerId);
    const totalCents = order.items.reduce(
      (sum, item) => sum + item.qty * item.unitPriceCents,
      0,
    );
    return {
      id: order.id,
      customerName: customer?.name ?? "unknown",
      tier: customer?.tier ?? "free",
      totalCents,
    };
  });
}
