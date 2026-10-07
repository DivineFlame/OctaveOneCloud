export interface InvoiceSummary { id: string; number: string; status: string; orderId: string | null; currency: string; subtotalMinor: number; taxMinor: number; totalMinor: number; issuedAt: string; orgName?: string }
export interface TaxComponent { name: string; rateBps: number; taxableMinor: number; amountMinor: number }
export interface Party { legalName: string; address?: string | null; gstin?: string | null; stateCode?: string | null; country?: string | null; email?: string | null }
export interface CreditNote { id: string; number: string; amountMinor: number; taxMinor: number; taxDetail: TaxComponent[] | null; reason: string; refundId: string | null; issuedAt: string }
export interface Invoice extends InvoiceSummary {
  taxBreakdown: TaxComponent[];
  billing: { seller: Party; buyer: Party; placeOfSupply: string | null; supplyType: string; reverseCharge: boolean; orderId: string; paidAt: string };
  lines: { id: string; description: string; quantity: number; sacCode: string | null; amountMinor: number; taxMinor: number }[];
  creditNotes: CreditNote[];
}

export const rate = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;
export const SUPPLY_TYPE: Record<string, string> = { intra_state: 'Intra-state (CGST + SGST)', inter_state: 'Inter-state (IGST)', export: 'Export of services' };
