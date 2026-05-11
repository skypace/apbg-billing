import { useEffect, useMemo, useState } from 'react';
import { sbq, sbUpdate } from '../../lib/rpc';

// Settings → Fleet Drivers
// ------------------------
// Manual mapping from Unity FleetComplete drivers (synced into
// ops.fleet_drivers) to the APBG operational roster (ops.team_members).
//
// The link lives on team_members.fleet_driver_id (which is what the
// nightly fn_compute_kpi_daily uses to key GPS counts onto team-member
// rows). The dropdown on each row lets Sky pick the matching team_member
// for a fleet_driver; PostgREST writes team_members.fleet_driver_id
// directly via the column-level UPDATE grant added in 20260509h.

interface FleetDriverRow {
  fc_person_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  employee_id: string | null;
}

interface TeamMemberRow {
  id: number;
  name: string | null;
  department: string | null;
  active: boolean | null;
  fleet_driver_id: string | null;
}

export function FleetDriversEditor() {
  const [drivers, setDrivers] = useState<FleetDriverRow[]>([]);
  const [members, setMembers] = useState<TeamMemberRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([
      sbq<FleetDriverRow>(
        'fleet_drivers',
        'select=fc_person_id,first_name,last_name,email,employee_id&order=last_name.asc.nullslast,first_name.asc',
      ),
      sbq<TeamMemberRow>(
        'team_members',
        'select=id,name,department,active,fleet_driver_id&order=name.asc',
      ),
    ])
      .then(([d, m]) => { if (!stopped) { setDrivers(d); setMembers(m); setLoading(false); } })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  // For each fleet_driver, the linked team_member (if any) is the row whose
  // fleet_driver_id equals fc_person_id.
  const linkByFcId = useMemo(() => {
    const m = new Map<string, TeamMemberRow>();
    for (const tm of members) if (tm.fleet_driver_id) m.set(tm.fleet_driver_id, tm);
    return m;
  }, [members]);

  // Sort options: active first, by department, then name.
  const memberOptions = useMemo(() => {
    return [...members].sort((a, b) => {
      const aa = (a.active ? '0' : '1') + ':' + (a.department ?? 'zz') + ':' + (a.name ?? '');
      const bb = (b.active ? '0' : '1') + ':' + (b.department ?? 'zz') + ':' + (b.name ?? '');
      return aa.localeCompare(bb);
    });
  }, [members]);

  async function setLink(fc_person_id: string, newMemberId: number | null) {
    setSaving(fc_person_id);
    setErr(null);
    try {
      // Two writes (sequential is fine — small table):
      // 1. Clear any existing team_member that points to this fc_person_id
      //    (if it's not the new target).
      // 2. Set the new team_member's fleet_driver_id = fc_person_id.
      const prior = linkByFcId.get(fc_person_id);
      if (prior && prior.id !== newMemberId) {
        await sbUpdate<TeamMemberRow>(
          'team_members',
          'id=eq.' + prior.id,
          { fleet_driver_id: null } as Partial<TeamMemberRow>,
        );
      }
      if (newMemberId !== null) {
        await sbUpdate<TeamMemberRow>(
          'team_members',
          'id=eq.' + newMemberId,
          { fleet_driver_id: fc_person_id } as Partial<TeamMemberRow>,
        );
      }
      // Optimistic update: refetch the team_members list so future renders
      // reflect the new state.
      const fresh = await sbq<TeamMemberRow>(
        'team_members',
        'select=id,name,department,active,fleet_driver_id&order=name.asc',
      );
      setMembers(fresh);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(null);
    }
  }

  const linked = drivers.filter((d) => linkByFcId.has(d.fc_person_id)).length;

  return (
    <div>
      <div style={{ marginBottom: 10, fontSize: 12 }}>
        <strong>FLEET DRIVERS</strong>{' '}
        <span style={{ color: 'var(--mt)' }}>
          Map FleetComplete drivers to your APBG team-member roster. The link lives on{' '}
          <code>team_members.fleet_driver_id</code> and powers GPS-confirmed stop counts in <code>kpi_daily</code> and dwell-mismatch flags in the Reconcile tab.
        </span>
      </div>
      {loading ? (
        <div style={{ color: 'var(--mt)' }}>loading…</div>
      ) : err ? (
        <div style={{ color: 'var(--rd)' }}>{err}</div>
      ) : (
        <>
          <div style={{ fontSize: 11, color: 'var(--mt)', marginBottom: 8 }}>
            {linked} of {drivers.length} mapped
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
                <th style={th}>FC driver</th>
                <th style={th}>Email</th>
                <th style={th}>Employee ID</th>
                <th style={th}>→ Team member</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((d) => {
                const fcName = [d.first_name, d.last_name].filter(Boolean).join(' ') || d.fc_person_id.slice(0, 8) + '…';
                const isSaving = saving === d.fc_person_id;
                const current = linkByFcId.get(d.fc_person_id);
                return (
                  <tr key={d.fc_person_id} style={{ borderTop: '1px solid var(--bd)' }}>
                    <td style={td}>{fcName}</td>
                    <td style={td}>{d.email ?? '—'}</td>
                    <td style={td}>{d.employee_id ?? '—'}</td>
                    <td style={td}>
                      <select
                        value={current?.id ?? ''}
                        onChange={(e) => setLink(d.fc_person_id, e.target.value ? Number(e.target.value) : null)}
                        disabled={isSaving}
                        style={{
                          background: 'var(--sf2)',
                          color: 'var(--tx)',
                          border: '1px solid var(--bd)',
                          borderRadius: 3,
                          padding: '3px 6px',
                          fontSize: 11,
                          minWidth: 280,
                        }}
                      >
                        <option value="">— unmapped —</option>
                        {memberOptions.map((tm) => (
                          <option key={tm.id} value={tm.id}>
                            {tm.name}
                            {tm.department ? ' · ' + tm.department : ''}
                            {tm.active === false ? ' (inactive)' : ''}
                          </option>
                        ))}
                      </select>
                      {isSaving && <span style={{ marginLeft: 8, color: 'var(--mt)', fontSize: 10 }}>saving…</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

const th = { padding: '6px 10px', fontWeight: 600 } as const;
const td = { padding: '6px 10px' } as const;
