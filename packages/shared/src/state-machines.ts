/**
 * Local lifecycle states. These are OctaveOneCloud concepts, not provider enums.
 */
export class InvalidTransitionError extends Error {
  constructor(machine: string, from: string, to: string) {
    super(`Invalid ${machine} transition: ${from} -> ${to}`);
  }
}

function machine<S extends string>(name: string, transitions: Record<S, readonly S[]>) {
  return {
    name,
    states: Object.keys(transitions) as S[],
    canTransition(from: S, to: S): boolean {
      return transitions[from].includes(to);
    },
    assertTransition(from: S, to: S): void {
      if (!transitions[from].includes(to)) throw new InvalidTransitionError(name, from, to);
    },
    isTerminal(state: S): boolean {
      return transitions[state].length === 0;
    },
  };
}

export const ORDER_STATUSES = ['draft', 'awaiting_payment', 'paid', 'provisioning', 'active', 'delayed', 'needs_attention', 'cancelled', 'expired'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const orderMachine = machine<OrderStatus>('order', {
  draft: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'expired', 'cancelled'],
  // A paid order is never moved back to awaiting_payment by a later failed attempt.
  paid: ['provisioning', 'needs_attention'],
  provisioning: ['active', 'delayed', 'needs_attention'],
  delayed: ['provisioning', 'active', 'needs_attention'],
  needs_attention: ['provisioning', 'active', 'cancelled'],
  active: [],
  cancelled: [],
  expired: [],
});

export const PROVISIONING_STATUSES = ['queued', 'running', 'active', 'partially_failed', 'failed', 'compensating', 'unknown_outcome'] as const;
export type ProvisioningStatus = (typeof PROVISIONING_STATUSES)[number];
export const provisioningMachine = machine<ProvisioningStatus>('provisioning', {
  queued: ['running'],
  running: ['active', 'partially_failed', 'failed', 'unknown_outcome'],
  // unknown_outcome requires reconciliation with supplier records before any retry.
  unknown_outcome: ['active', 'failed', 'queued'],
  partially_failed: ['running', 'compensating', 'active'],
  failed: ['queued', 'compensating'],
  compensating: ['failed', 'partially_failed'],
  active: [],
});

export const SUBSCRIPTION_STATUSES = ['pending_activation', 'trialing', 'active', 'past_due', 'grace', 'suspended', 'cancel_scheduled', 'cancelled'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
export const subscriptionMachine = machine<SubscriptionStatus>('subscription', {
  pending_activation: ['trialing', 'active', 'cancelled'],
  trialing: ['active', 'past_due', 'cancelled', 'cancel_scheduled'],
  active: ['past_due', 'cancel_scheduled', 'cancelled'],
  past_due: ['active', 'grace', 'suspended', 'cancelled'],
  grace: ['active', 'suspended', 'cancelled'],
  // Suspension never deletes data; resumption restores access.
  suspended: ['active', 'cancelled'],
  cancel_scheduled: ['active', 'cancelled'],
  cancelled: [],
});

export const PAYMENT_ATTEMPT_STATUSES = ['created', 'pending', 'success', 'failed', 'user_dropped', 'cancelled', 'unknown'] as const;
export type PaymentAttemptStatus = (typeof PAYMENT_ATTEMPT_STATUSES)[number];

export const REFUND_STATUSES = ['requested', 'pending', 'success', 'failed', 'cancelled'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
export const refundMachine = machine<RefundStatus>('refund', {
  requested: ['pending', 'failed', 'cancelled'],
  pending: ['success', 'failed', 'cancelled'],
  success: [],
  failed: ['requested'],
  cancelled: [],
});
