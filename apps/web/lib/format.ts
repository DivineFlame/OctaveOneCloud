export function formatINR(minor: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(minor / 100);
}

const INTERVALS: Record<string, string> = { P1M: 'month', P3M: 'quarter', P6M: '6 months', P1Y: 'year', P2Y: '2 years', P3Y: '3 years' };
export function formatInterval(iso: string): string {
  return INTERVALS[iso] ?? iso;
}

export const ORDER_STATUS_TEXT: Record<string, { label: string; tone: 'neutral' | 'progress' | 'good' | 'warn' }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  awaiting_payment: { label: 'Awaiting payment', tone: 'neutral' },
  paid: { label: 'Paid', tone: 'progress' },
  provisioning: { label: 'Provisioning', tone: 'progress' },
  active: { label: 'Active', tone: 'good' },
  delayed: { label: 'Delayed', tone: 'warn' },
  needs_attention: { label: 'Needs attention — our team has been notified', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  expired: { label: 'Expired', tone: 'neutral' },
};
