/**
 * The perf guard for the `GET /orders` hot path.
 *
 * Record the baseline once, commit it, and let CI run this on every PR:
 *   node example/realworld/enrichOrders.bench.ts --update   # record
 *   node example/realworld/enrichOrders.bench.ts            # check (exit 1 if slower)
 */

// In your own app this is just:  import { bench, run } from "benchguard";
import { bench, run } from "../../src/index.ts";
import { enrichOrders, type Customer, type Order } from "./enrichOrders.ts";

// A fixture sized like a real page of data, not a toy. Benchmarks should use
// volumes close to production — an O(n²) bug is invisible at n=10.
const customers: Customer[] = Array.from({ length: 1_000 }, (_, i) => ({
  id: `cust_${i}`,
  name: `Customer ${i}`,
  tier: i % 10 === 0 ? "enterprise" : i % 3 === 0 ? "pro" : "free",
}));

const orders: Order[] = Array.from({ length: 5_000 }, (_, i) => ({
  id: `ord_${i}`,
  customerId: `cust_${i % 1_000}`,
  items: Array.from({ length: 3 }, (_, j) => ({
    sku: `sku_${j}`,
    qty: j + 1,
    unitPriceCents: 1999,
  })),
}));

bench("enrichOrders — 5k orders × 1k customers", () =>
  enrichOrders(orders, customers),
);

await run({
  baseline: "example/realworld/baseline.json",
  threshold: 0.15, // allow 15% drift; CI machines are noisier than laptops
});
