/**
 * Fictional product catalog for the mock store. Prices are integer cents.
 * Categories matter to policy: gift_card and custom_cut_glass are non-refundable.
 */

export type Product = { sku: string; name: string; category: string; priceCents: number; stock: number };

export const CATALOG: Product[] = [
  { sku: "GLS-AUR-01", name: "Aurora tempered glass panel kit", category: "home_glass", priceCents: 32_000, stock: 6 },
  { sku: "GLS-CUT-07", name: "Custom-cut glass shelf", category: "custom_cut_glass", priceCents: 12_500, stock: 12 },
  { sku: "KIT-POUR-02", name: "Ceramic pour-over set", category: "kitchen", priceCents: 3_400, stock: 18 },
  { sku: "MUG-STN-04", name: "Stoneware mug set (4)", category: "kitchen", priceCents: 3_600, stock: 22 },
  { sku: "SKL-CI-12", name: "Cast iron skillet 12in", category: "kitchen", priceCents: 4_200, stock: 15 },
  { sku: "DIN-STN-12", name: "Stoneware dinner set (12 pc)", category: "kitchen", priceCents: 8_900, stock: 9 },
  { sku: "TXT-MER-01", name: "Merino throw blanket", category: "textiles", priceCents: 8_900, stock: 14 },
  { sku: "TXT-LIN-Q", name: "Linen duvet cover (queen)", category: "textiles", priceCents: 14_500, stock: 7 },
  { sku: "TXT-APR-01", name: "Linen apron", category: "textiles", priceCents: 2_800, stock: 0 },
  { sku: "ELC-NCH-01", name: "Noise-cancelling headphones", category: "electronics", priceCents: 12_900, stock: 11 },
  { sku: "ELC-THM-01", name: "Smart thermostat", category: "electronics", priceCents: 17_900, stock: 8 },
  { sku: "ELC-SPK-02", name: "Bookshelf speaker pair", category: "electronics", priceCents: 22_900, stock: 5 },
  { sku: "LGT-BRS-01", name: "Brass table lamp", category: "lighting", priceCents: 11_900, stock: 10 },
  { sku: "LGT-PND-03", name: "Rattan pendant light", category: "lighting", priceCents: 9_400, stock: 6 },
  { sku: "OUT-CHR-02", name: "Folding camp chair", category: "outdoor", priceCents: 3_450, stock: 30 },
  { sku: "OUT-LNT-01", name: "Solar lantern", category: "outdoor", priceCents: 2_600, stock: 25 },
  { sku: "GFT-050", name: "Digital gift card $50", category: "gift_card", priceCents: 5_000, stock: 999 },
  { sku: "CLR-VAS-09", name: "Clearance glass vase", category: "clearance", priceCents: 1_900, stock: 20 },
];

export function product(sku: string): Product {
  const p = CATALOG.find((x) => x.sku === sku);
  if (!p) throw new Error(`Unknown SKU ${sku}`);
  return p;
}
