'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';
import { useMe } from '@/components/useMe';

interface Org { id: string; name: string; legalName: string | null; gstin: string | null; billingEmail: string | null; stateCode: string | null; country: string }
interface Member { id: string; role: string; user: { id: string; email: string; name: string | null } }

export default function OrgPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  const { me } = useMe();
  const [org, setOrg] = useState<Org | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [msg, setMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const load = useCallback(async () => {
    try {
      setOrg(await api<Org>(`/orgs/${orgId}`));
      setMembers(await api<Member[]>(`/orgs/${orgId}/members`));
    } catch (e) {
      setMsg({ text: describeError(e), error: true });
    }
  }, [orgId]);
  useEffect(() => void load(), [load]);

  const role = me?.organizations.find((o) => o.id === orgId)?.role;
  const canBilling = role === 'owner' || role === 'billing';
  const canMembers = role === 'owner' || role === 'admin';

  async function saveBilling(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, string | null> = {};
    for (const k of ['legalName', 'billingEmail', 'stateCode']) {
      const v = String(f.get(k) ?? '').trim();
      if (v) body[k] = v;
    }
    const gstin = String(f.get('gstin') ?? '').trim();
    body.gstin = gstin ? gstin.toUpperCase() : null;
    try {
      await api(`/orgs/${orgId}/billing`, { method: 'PATCH', body });
      setMsg({ text: 'Billing details saved.' });
      await load();
    } catch (err) {
      setMsg({ text: describeError(err), error: true });
    }
  }

  async function invite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api(`/orgs/${orgId}/invitations`, { method: 'POST', body: { email: String(f.get('email')), role: String(f.get('role')) } });
      setMsg({ text: 'Invitation sent.' });
      e.currentTarget.reset();
    } catch (err) {
      setMsg({ text: describeError(err), error: true });
    }
  }

  if (!org) return <p aria-busy="true">{msg?.text ?? 'Loading…'}</p>;
  return (
    <>
      <p><Link href="/dashboard">← Dashboard</Link></p>
      <h1>{org.name}</h1>
      <div className="row"><span className="badge">Your role: {role ?? '…'}</span><Link className="btn" href="/pricing">Browse products</Link></div>
      {msg && <p className={msg.error ? 'error' : 'muted'} role={msg.error ? 'alert' : 'status'}>{msg.text}</p>}

      <h2>Billing details</h2>
      <p className="muted">Used for GST invoices and to calculate tax on quotes. Your accountant should confirm these details.</p>
      <form className="stack" onSubmit={saveBilling}>
        <label>Legal name<input name="legalName" defaultValue={org.legalName ?? ''} disabled={!canBilling} /></label>
        <label>GSTIN <span className="hint">(optional)</span><input name="gstin" defaultValue={org.gstin ?? ''} maxLength={15} disabled={!canBilling} /></label>
        <label>Billing email<input name="billingEmail" type="email" defaultValue={org.billingEmail ?? ''} disabled={!canBilling} /></label>
        <label>GST state code<input name="stateCode" inputMode="numeric" pattern="\d{2}" defaultValue={org.stateCode ?? ''} disabled={!canBilling} aria-describedby="state-hint" />
          <span id="state-hint" className="hint">Two digits, e.g. 29 for Karnataka. Must match the first two digits of your GSTIN.</span></label>
        {canBilling && <button className="btn" type="submit">Save billing details</button>}
      </form>

      <h2>Team</h2>
      <div className="table-wrap">
        <table>
          <thead><tr><th scope="col">Member</th><th scope="col">Role</th></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}><td>{m.user.name ?? m.user.email}<div className="hint">{m.user.email}</div></td><td>{m.role}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {canMembers && (
        <form className="stack" onSubmit={invite} style={{ marginTop: 16 }}>
          <h3>Invite a teammate</h3>
          <label>Email<input name="email" type="email" required /></label>
          <label>Role
            <select name="role" defaultValue="member">
              <option value="member">Member — view services</option>
              <option value="billing">Billing — manage payments and invoices</option>
              <option value="admin">Admin — manage team and services</option>
              {role === 'owner' && <option value="owner">Owner — full control</option>}
            </select>
          </label>
          <button className="btn" type="submit">Send invitation</button>
        </form>
      )}
    </>
  );
}
