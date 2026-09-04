import { useEffect, useState } from 'react';
import { PrintableTable } from '../../components/PrintableTable';
import { btnDanger, btnPrimary, btnSecondary, inp } from '../../lib/styles';
import { sbAuth, SB_KEY, SB_URL, _sbToken } from '../../lib/supabase';
import {
  DigestLogRow,
  DigestSubscription,
  deleteDigestSubscription,
  fetchDigestLog,
  fetchDigestSubscriptions,
  insertDigestSubscription,
  updateDigestSubscription,
} from '../../lib/settings';

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DIGEST_SECTIONS = [
  { id: 'margin_summary', label: 'YTD Margin Summary' },
  { id: 'inactive',       label: 'Lost / Inactive Customers' },
  { id: 'top_movers',     label: 'Top Movers (vs prior year)' },
  { id: 'health_movers',  label: 'Customer Health Movement' },
  { id: 'plan_alerts',    label: 'Plan Variance Alerts' },
];

export function DigestEditor() {
  const [subs, setSubs] = useState<DigestSubscription[] | null>(null);
  const [logs, setLogs] = useState<DigestLogRow[]>([]);
  const [msg, setMsg] = useState('');
  const [preview, setPreview] = useState<{ html: string; subject: string; recipients: string[] } | null>(null);
  const [draft, setDraft] = useState({
    name: '',
    recipients: '',
    frequency: 'weekly',
    day_of_week: 1,
    hour_utc: 14,
    sections: ['margin_summary', 'inactive', 'top_movers'],
  });

  function load() {
    Promise.all([fetchDigestSubscriptions(), fetchDigestLog(20)])
      .then(([s, l]) => { setSubs(s); setLogs(l); })
      .catch(() => { setSubs([]); setLogs([]); });
  }
  useEffect(load, []);

  async function add() {
    if (!draft.name || !draft.recipients) return alert('Name and recipients required');
    const recips = draft.recipients.split(/[\s,;]+/).filter(Boolean);
    const session = await sbAuth.auth.getSession();
    const uid = session?.data?.session?.user?.id ?? null;
    insertDigestSubscription({
      name: draft.name.trim(),
      recipients: recips,
      frequency: draft.frequency,
      day_of_week: Number(draft.day_of_week),
      hour_utc: Number(draft.hour_utc),
      sections: draft.sections,
      is_active: true,
      created_by: uid,
    }).then(() => {
      setDraft({
        name: '',
        recipients: '',
        frequency: 'weekly',
        day_of_week: 1,
        hour_utc: 14,
        sections: ['margin_summary', 'inactive', 'top_movers'],
      });
      load();
    });
  }

  function toggle(sub: DigestSubscription) {
    updateDigestSubscription(sub.id, { is_active: !sub.is_active }).then(load);
  }

  function del(id: string) {
    if (!confirm('Delete this digest?')) return;
    deleteDigestSubscription(id).then(load);
  }

  async function send(sub: DigestSubscription, dryRun: boolean) {
    setMsg(dryRun ? 'building preview…' : 'sending…');
    const token = await _sbToken();
    fetch(SB_URL + '/functions/v1/digest-email', {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'manual',
        subscription_id: sub.id,
        recipients: sub.recipients,
        sections: sub.sections,
        dry_run: dryRun,
      }),
    })
      .then((r) => r.json())
      .then((j) => {
        if (dryRun && j.html) {
          setPreview({ html: j.html, subject: j.subject, recipients: j.recipients });
          setMsg('preview built (would send to ' + (j.recipients || []).join(', ') + ')');
        } else {
          setMsg(j.ok ? 'sent to ' + (sub.recipients || []).join(', ') : 'FAIL: ' + (j.error || 'unknown'));
        }
        load();
      })
      .catch((e) => setMsg('ERROR: ' + (e as Error).message));
  }

  if (!subs) return <div className="ld">Loading…</div>;

  return (
    <div>
      {msg && (
        <div style={{ padding: '8px 12px', marginBottom: 10, fontSize: 11, color: 'var(--mt)', background: 'var(--sf2)', border: '1px solid var(--bd)', borderRadius: 4 }}>
          {msg}
        </div>
      )}

      <div className="cd" style={{ padding: 0, marginBottom: 12 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>CREATE A DIGEST</div>
          <div style={{ fontSize: 10, color: 'var(--mt)', marginTop: 3 }}>
            Sends via Resend; set RESEND_API_KEY env var on the Supabase project. Without it, sends fall back to dry-run preview.
          </div>
        </div>
        <div style={{ padding: '12px 14px', display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', alignItems: 'end' }}>
          <Field label="Name">
            <input type="text" placeholder="e.g. Sky weekly" value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              style={{ ...inp(), width: '100%' }} />
          </Field>
          <Field label="Recipients (comma-separated)">
            <input type="text" placeholder="sky@…, accountant@…" value={draft.recipients}
              onChange={(e) => setDraft({ ...draft, recipients: e.target.value })}
              style={{ ...inp(), width: '100%' }} />
          </Field>
          <Field label="Frequency">
            <select value={draft.frequency}
              onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}
              style={{ ...inp(), width: '100%' }}>
              {['daily', 'weekly', 'monthly'].map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>
          {draft.frequency === 'weekly' && (
            <Field label="Day">
              <select value={draft.day_of_week}
                onChange={(e) => setDraft({ ...draft, day_of_week: Number(e.target.value) })}
                style={{ ...inp(), width: '100%' }}>
                {DAYS_OF_WEEK.map((d, i) => <option key={i} value={i}>{d}</option>)}
              </select>
            </Field>
          )}
          <Field label="Hour (UTC)">
            <input type="number" min={0} max={23} value={draft.hour_utc}
              onChange={(e) => setDraft({ ...draft, hour_utc: Number(e.target.value) })}
              style={{ ...inp(), width: '100%' }} />
          </Field>
          <div style={{ gridColumn: '1 / -1' }}>
            <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', marginBottom: 4 }}>
              Sections
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              {DIGEST_SECTIONS.map((s) => (
                <label key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, cursor: 'pointer' }}>
                  <input type="checkbox" checked={draft.sections.indexOf(s.id) >= 0}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...draft.sections, s.id]
                        : draft.sections.filter((x) => x !== s.id);
                      setDraft({ ...draft, sections: next });
                    }} />
                  <span>{s.label}</span>
                </label>
              ))}
            </div>
          </div>
          <button onClick={add} style={btnPrimary()}>+ ADD DIGEST</button>
        </div>
      </div>

      <div className="cd" style={{ padding: 0, marginBottom: 12 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>SUBSCRIPTIONS — {subs.length}</div>
        </div>
        {subs.length === 0 ? (
          <div className="ld">No subscriptions yet.</div>
        ) : (
          <PrintableTable>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Recipients</th>
                  <th>Frequency</th>
                  <th>Sections</th>
                  <th>Last sent</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td style={{ fontWeight: 600 }}>{s.name}</td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>{(s.recipients || []).join(', ')}</td>
                    <td style={{ fontSize: 11 }}>
                      {s.frequency}
                      {s.frequency === 'weekly' && <> · {DAYS_OF_WEEK[s.day_of_week]}</>}
                      {' · '}
                      {String(s.hour_utc).padStart(2, '0')}:00 UTC
                    </td>
                    <td style={{ fontSize: 10, color: 'var(--mt)' }}>{(s.sections || []).join(', ')}</td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>
                      {s.last_sent_at ? new Date(s.last_sent_at).toLocaleString() : '—'}
                    </td>
                    <td>
                      <input type="checkbox" checked={s.is_active} onChange={() => toggle(s)} />
                    </td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button onClick={() => send(s, true)} style={btnSecondary()}>PREVIEW</button>{' '}
                      <button onClick={() => send(s, false)} style={btnPrimary()}>SEND</button>{' '}
                      <button onClick={() => del(s.id)} style={btnDanger()}>×</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PrintableTable>
        )}
      </div>

      {preview && (
        <div className="cd" style={{ padding: 0, marginBottom: 12 }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)', display: 'flex', justifyContent: 'space-between' }}>
            <div className="ct" style={{ margin: 0 }}>PREVIEW — {preview.subject}</div>
            <button onClick={() => setPreview(null)} style={btnSecondary()}>CLOSE</button>
          </div>
          <div style={{ padding: 14, background: '#fff', maxHeight: 600, overflow: 'auto' }}>
            <iframe
              title="digest-preview"
              srcDoc={preview.html}
              style={{ width: '100%', height: 560, border: 0 }}
            />
          </div>
        </div>
      )}

      <div className="cd" style={{ padding: 0 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--bd)' }}>
          <div className="ct" style={{ margin: 0 }}>RECENT SENDS — {logs.length}</div>
        </div>
        {logs.length === 0 ? (
          <div className="ld">No sends logged yet.</div>
        ) : (
          <PrintableTable>
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Subject</th>
                  <th>Recipients</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((l) => (
                  <tr key={l.id}>
                    <td className="mn" style={{ fontSize: 11, color: 'var(--mt)' }}>
                      {l.sent_at ? new Date(l.sent_at).toLocaleString() : '—'}
                    </td>
                    <td style={{ fontSize: 11 }}>{l.subject}</td>
                    <td style={{ fontSize: 11, color: 'var(--mt)' }}>{(l.recipients || []).join(', ')}</td>
                    <td style={{ fontSize: 11 }}>
                      <span
                        className="bg"
                        style={{
                          color:
                            l.status === 'sent'
                              ? 'var(--success)'
                              : l.status === 'failed'
                                ? 'var(--danger)'
                                : 'var(--mt)',
                          borderColor:
                            l.status === 'sent'
                              ? 'var(--success)'
                              : l.status === 'failed'
                                ? 'var(--danger)'
                                : 'var(--bd)',
                        }}
                      >
                        {l.status}
                      </span>
                      {l.error && <span style={{ marginLeft: 6, color: 'var(--rd)' }}>{l.error}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </PrintableTable>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 9, color: 'var(--mt)', textTransform: 'uppercase', marginBottom: 4 }}>
        {label}
      </div>
      {children}
    </div>
  );
}
