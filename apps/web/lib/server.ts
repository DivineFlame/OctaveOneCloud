import 'server-only';

const apiInternal = process.env.API_INTERNAL_URL ?? 'http://localhost:4000';

export interface PublicPrice { id: string; kind: string; currency: string; billingInterval: string; amountMinor: number; setupFeeMinor: number; isPremium: boolean }
export interface PublicPlan { key: string; name: string; tier: string; planVersionId: string; trialDays: number; supportLevel: string | null; features: { key: string; name: string; unit: string | null; limit: number | null }[]; prices: PublicPrice[] }
export interface PublicProduct { key: string; name: string; family: string; description: string | null; plans: PublicPlan[] }

/** Server-side fetch of the public catalogue. Returns null when the API is unreachable. */
export async function fetchCatalogue(): Promise<PublicProduct[] | null> {
  try {
    const res = await fetch(`${apiInternal}/v1/catalogue/products`, { next: { revalidate: 60 } });
    if (!res.ok) return null;
    return (await res.json()) as PublicProduct[];
  } catch {
    return null;
  }
}
