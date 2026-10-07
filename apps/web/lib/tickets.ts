export interface TicketSummary { id: string; subject: string; status: string; category: string | null; createdAt: string; updatedAt: string; org?: { id: string; name: string } }
export interface TicketMessage { id: string; body: string; internal: boolean; createdAt: string; author: { name: string; isStaff: boolean } }
export interface Ticket extends TicketSummary { messages: TicketMessage[]; org?: { id: string; name: string; billingEmail?: string | null } }

export const TICKET_STATUS: Record<string, { label: string; tone: 'neutral' | 'progress' | 'good' | 'warn' }> = {
  open: { label: 'Open', tone: 'progress' },
  pending_internal: { label: 'Waiting for our team', tone: 'progress' },
  pending_customer: { label: 'Waiting for you', tone: 'warn' },
  resolved: { label: 'Resolved', tone: 'good' },
  closed: { label: 'Closed', tone: 'neutral' },
};

export const CATEGORY_LABEL: Record<string, string> = {
  general: 'General question',
  billing: 'Billing & invoices',
  technical: 'Technical problem',
  account: 'Account & team',
  domain: 'Domains & DNS',
  manual_service_request: 'Service request (change we perform for you)',
};
