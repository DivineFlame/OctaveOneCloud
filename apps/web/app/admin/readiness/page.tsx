'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, describeError } from '@/lib/api';

interface Check { id: string; area: string; title: string; status: 'pass' | 'fail' | 'warn' | 'manual'; detail: string }
interface Report { generatedAt: string; appEnv: string; summary: Record<Check['status'], number>; automatedChecksPass: boolean; checks: Check[] }

const TONE: Record<Check['status'], string> = { pass: 'good', fail: 'warn', warn: 'progress', manual: '' };
const LABEL: Record<Check['status'], string> = { pass: 'Pass', fail: 'Fail', warn: 'Warning', manual: 'Manual sign-off' };

export default function Readiness() {
  const [r, setR] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => void api<Report>('/admin/readiness').then(setR).catch((e) => setError(describeError(e))), []);

  const areas = r ? [...new Set(r.checks.map((c) => c.area))] : [];
  return (
    <>
      <p><Link href="/admin">← Operations console</Link></p>
      <h1>Launch readiness</h1>
      {error && <p role="alert" className="error">{error}</p>}
      {!r && !error && <p aria-busy="true">Checking…</p>}
      {r && (
        <>
          <div className={`notice ${r.automatedChecksPass ? 'info' : ''}`} role="status">
            <strong>{r.automatedChecksPass ? 'Automated checks pass.' : 'Not ready for real customers.'}</strong>{' '}
            {r.summary.pass} pass · {r.summary.warn} warnings · {r.summary.fail} failing · {r.summary.manual} manual gates. Environment: {r.appEnv}. Checked {new Date(r.generatedAt).toLocaleString('en-IN')}.
            <br />The same report is available on the server: <code>node dist/cli/preflight.js</code> in the api container.
          </div>
          {areas.map((area) => (
            <section key={area}>
              <h2 style={{ textTransform: 'capitalize' }}>{area.replace('_', ' ')}</h2>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {r.checks.filter((c) => c.area === area).map((c) => (
                      <tr key={c.id}>
                        <td style={{ width: 150 }}><span className={`badge ${TONE[c.status]}`}>{LABEL[c.status]}</span></td>
                        <td><strong>{c.title}</strong><br /><span className="muted">{c.detail}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </>
      )}
    </>
  );
}
