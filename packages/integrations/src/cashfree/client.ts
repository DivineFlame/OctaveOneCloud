import { decimalToMinor, minorToDecimalString, redact } from '@ooc/shared';

export class PaymentProviderError extends Error {
  constructor(public readonly kind: 'disabled' | 'http' | 'unknown_outcome' | 'invalid_response', message: string, public readonly details?: unknown) {
    super(message);
  }
}

export interface CreateOrderInput {
  orderId: string;
  amountMinor: number;
  currency: 'INR';
  customer: { id: string; email: string; phone: string; name?: string };
  returnUrl: string;
  notifyUrl?: string;
  note?: string;
}

export interface CashfreeOrder {
  orderId: string;
  cfOrderId?: string;
  amountMinor: number;
  currency: string;
  status: string;
  paymentSessionId?: string;
}

export interface CashfreePayment {
  cfPaymentId: string;
  status: string;
  amountMinor: number;
  currency: string;
  method?: string;
  raw: unknown;
}

/**
 * Cashfree Payment Gateway client (server-side only).
 * Headers per official docs: x-client-id, x-client-secret, x-api-version.
 * Amounts cross this boundary as decimal strings/numbers and are converted exactly from/to minor units.
 */
export class CashfreeClient {
  constructor(
    private readonly baseUrl: string | null,
    private readonly credentials: { clientId?: string; clientSecret?: string; apiVersion: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 20_000,
  ) {}

  get enabled() {
    return Boolean(this.baseUrl && this.credentials.clientId && this.credentials.clientSecret);
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    if (!this.enabled) throw new PaymentProviderError('disabled', 'Cashfree is not configured');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'x-client-id': this.credentials.clientId!,
          'x-client-secret': this.credentials.clientSecret!,
          'x-api-version': this.credentials.apiVersion,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PaymentProviderError('unknown_outcome', `No response from Cashfree (${(e as Error).name})`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PaymentProviderError('invalid_response', `Cashfree returned non-JSON (HTTP ${res.status})`);
    }
    if (res.status >= 500) throw new PaymentProviderError('unknown_outcome', `Cashfree HTTP ${res.status}`, redact(json));
    if (!res.ok) throw new PaymentProviderError('http', `Cashfree HTTP ${res.status}`, redact(json));
    return json;
  }

  async createOrder(input: CreateOrderInput): Promise<CashfreeOrder> {
    const json = (await this.call('POST', '/orders', {
      order_id: input.orderId,
      order_amount: Number(minorToDecimalString(input.amountMinor, input.currency)),
      order_currency: input.currency,
      customer_details: { customer_id: input.customer.id, customer_email: input.customer.email, customer_phone: input.customer.phone, customer_name: input.customer.name },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      order_note: input.note,
    })) as Record<string, unknown>;
    return this.parseOrder(json, input);
  }

  async getOrder(orderId: string): Promise<CashfreeOrder> {
    return this.parseOrder((await this.call('GET', `/orders/${encodeURIComponent(orderId)}`)) as Record<string, unknown>);
  }

  async getOrderPayments(orderId: string): Promise<CashfreePayment[]> {
    const json = await this.call('GET', `/orders/${encodeURIComponent(orderId)}/payments`);
    if (!Array.isArray(json)) throw new PaymentProviderError('invalid_response', 'Expected an array of payments');
    return json.map((p: Record<string, unknown>) => ({
      cfPaymentId: String(p.cf_payment_id),
      status: String(p.payment_status),
      amountMinor: decimalToMinor(p.payment_amount as number | string),
      currency: String(p.payment_currency),
      method: p.payment_group ? String(p.payment_group) : undefined,
      raw: p,
    }));
  }

  private parseOrder(json: Record<string, unknown>, expected?: CreateOrderInput): CashfreeOrder {
    const order: CashfreeOrder = {
      orderId: String(json.order_id),
      cfOrderId: json.cf_order_id ? String(json.cf_order_id) : undefined,
      amountMinor: decimalToMinor(json.order_amount as number | string),
      currency: String(json.order_currency),
      status: String(json.order_status),
      paymentSessionId: json.payment_session_id ? String(json.payment_session_id) : undefined,
    };
    if (expected && (order.orderId !== expected.orderId || order.amountMinor !== expected.amountMinor || order.currency !== expected.currency)) {
      throw new PaymentProviderError('invalid_response', 'Cashfree order does not match the requested order identity/amount/currency');
    }
    return order;
  }
}
