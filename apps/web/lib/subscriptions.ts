export interface SubscriptionView {
  id: string;
  org: { id: string; name: string };
  status: string;
  product: { key: string; name: string };
  plan: { name: string; tier: string; planVersionId: string };
  priceVersionId: string;
  amountMinor: number;
  billingInterval: string;
  quantity: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  scheduledChange: { priceVersionId: string; planName: string | null; amountMinor: number | null; quantity: number; effectiveAt: string } | null;
  suspendedAt: string | null;
  cancelledAt: string | null;
  pendingAction: string | null;
  lastLifecycleError?: string | null;
  downgradeOptions: { priceVersionId: string; planName: string; amountMinor: number; billingInterval: string }[];
}

export const SUB_STATUS: Record<string, { label: string; tone: 'neutral' | 'progress' | 'good' | 'warn' }> = {
  pending_activation: { label: 'Being set up', tone: 'progress' },
  trialing: { label: 'Trial', tone: 'good' },
  active: { label: 'Active', tone: 'good' },
  past_due: { label: 'Payment due', tone: 'warn' },
  grace: { label: 'Grace period', tone: 'warn' },
  suspended: { label: 'Suspended', tone: 'warn' },
  cancel_scheduled: { label: 'Ends at period end', tone: 'neutral' },
  cancelled: { label: 'Ended', tone: 'neutral' },
};

export const day = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '—');
