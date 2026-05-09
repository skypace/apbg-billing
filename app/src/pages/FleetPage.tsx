import { useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchFleetMapRows,
  fetchFleetDrivers,
  fetchRecentTrips,
  fetchRecentDriverEvents,
  fetchGeofenceCount,
  type FleetMapRow,
  type FleetDriver,
  type FleetTrip,
  type FleetDriverEvent,
} from '../lib/fleet';

// Live fleet map.
//
// Reads ops.fleet_latest_snapshots (refreshed every 5 min by the
// fleetcomplete-latest-snapshots cron) joined to ops.fleet_vehicles, plots
// each vehicle as a colored marker on a Leaflet+OpenStreetMap canvas.
//
// Leaflet is loaded from a CDN on first render to avoid pulling a ~60KB
// mapping library into the main bundle. The CDN <link>+<script> survive
// across hash navigations (we don't unmount Leaflet's globals).

const LEAFLET_CSS = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
const LEAFLET_JS  = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';

let leafletLoadPromise: Promise<void> | null = null;
function loadLeaflet(): Promise<void> {
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-leaflet]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = LEAFLET_CSS;
      link.setAttribute('data-leaflet', '1');
      document.head.appendChild(link);
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-leaflet]');
    if (existing) {
      if ((window as any).L) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('leaflet load failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = LEAFLET_JS;
    s.async = true;
    s.setAttribute('data-leaflet', '1');
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('leaflet load failed'));
    document.head.appendChild(s);
  });
  return leafletLoadPromise;
}

const REFRESH_MS = 30_000;            // page-side poll interval
const STALE_MS   = 60 * 60 * 1000;    // gray pin if snapshot older than 1 hour

function pinColor(row: FleetMapRow, now: number): string {
  if (!row.snap || !row.snap.gps_fix) return '#888';
  const t = Date.parse(row.snap.snapshot_at);
  if (isNaN(t) || now - t > STALE_MS)  return '#888';
  if (row.snap.ignition_on)            return '#22aa55';   // driving
  return '#3a78d9';                                         // parked, recent
}

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = Date.parse(iso);
  if (isNaN(d)) return '—';
  const sec = Math.round((Date.now() - d) / 1000);
  if (sec < 60)        return sec + 's ago';
  if (sec < 3600)      return Math.round(sec / 60) + 'm ago';
  if (sec < 86400)     return Math.round(sec / 3600) + 'h ago';
  return Math.round(sec / 86400) + 'd ago';
}

function vehicleLabel(v: FleetMapRow): string {
  return v.vehicle_name || (v.year ? v.year + ' ' : '') + (v.make || '') + ' ' + (v.model || '') || v.fc_asset_id;
}

type Tab = 'map' | 'trips' | 'drivers' | 'safety';

export function FleetPage() {
  const [tab, setTab] = useState<Tab>('map');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 70px)' }}>
      <div style={{ padding: '6px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', gap: 4 }}>
        {(['map', 'trips', 'drivers', 'safety'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? 'var(--ac)' : 'transparent',
              color: tab === t ? 'var(--bg)' : 'var(--tx)',
              border: '1px solid ' + (tab === t ? 'var(--ac)' : 'var(--bd)'),
              padding: '4px 12px',
              borderRadius: 4,
              fontSize: 11,
              fontWeight: tab === t ? 700 : 500,
              letterSpacing: 0.5,
              cursor: 'pointer',
            }}
          >
            {t.toUpperCase()}
          </button>
        ))}
      </div>
      {tab === 'map'     && <MapTab />}
      {tab === 'trips'   && <TripsTab />}
      {tab === 'drivers' && <DriversTab />}
      {tab === 'safety'  && <SafetyTab />}
    </div>
  );
}

function MapTab() {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<Map<string, any>>(new Map());

  const [rows, setRows] = useState<FleetMapRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<number | null>(null);

  // Initial map setup once Leaflet is loaded.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapEl.current) return;
      const L = (window as any).L;
      if (mapRef.current) return;
      // Default view: Alameda yard. The first refresh fits to actual data.
      const map = L.map(mapEl.current).setView([37.78, -122.31], 11);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors',
      }).addTo(map);
      mapRef.current = map;
    }).catch((e) => setErr(String(e)));
    return () => { cancelled = true; };
  }, []);

  // Data fetch + interval poll.
  useEffect(() => {
    let stopped = false;
    async function tick() {
      try {
        const data = await fetchFleetMapRows();
        if (stopped) return;
        setRows(data);
        setLastFetch(Date.now());
        setErr(null);
      } catch (e) {
        if (!stopped) setErr((e as Error).message);
      } finally {
        if (!stopped) setLoading(false);
      }
    }
    tick();
    const id = setInterval(tick, REFRESH_MS);
    return () => { stopped = true; clearInterval(id); };
  }, []);

  // Re-paint markers whenever rows change AND the map is ready.
  useEffect(() => {
    const map = mapRef.current;
    const L = (window as any).L;
    if (!map || !L || rows.length === 0) return;

    const now = Date.now();
    const seen = new Set<string>();
    const fitBounds: [number, number][] = [];

    for (const row of rows) {
      const lat = row.snap?.latitude;
      const lon = row.snap?.longitude;
      if (typeof lat !== 'number' || typeof lon !== 'number' || lat === 0 || lon === 0) continue;

      seen.add(row.fc_asset_id);
      fitBounds.push([lat, lon]);

      const color = pinColor(row, now);
      const label = vehicleLabel(row);
      const speedMph = row.snap?.speed_kmh != null
        ? (Number(row.snap.speed_kmh) * 0.621371).toFixed(0)
        : null;
      const popup =
        '<div style="font-size:12px;line-height:1.4">' +
        '<div style="font-weight:700;margin-bottom:4px">' + escapeHtml(label) + '</div>' +
        (row.license_plate ? '<div style="color:#666">' + escapeHtml(row.license_plate) + '</div>' : '') +
        '<div>' + (row.snap?.ignition_on ? 'Engine on' : 'Parked') +
            (speedMph ? ' · ' + speedMph + ' mph' : '') + '</div>' +
        '<div style="color:#666;margin-top:3px">' + relTime(row.snap?.snapshot_at) + '</div>' +
        '</div>';

      let marker = markersRef.current.get(row.fc_asset_id);
      if (!marker) {
        const icon = L.divIcon({
          className: 'fleet-pin',
          html:
            '<div style="' +
            'width:18px;height:18px;border-radius:50%;' +
            'background:' + color + ';' +
            'border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.3)' +
            '"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        });
        marker = L.marker([lat, lon], { icon }).addTo(map);
        markersRef.current.set(row.fc_asset_id, marker);
      } else {
        marker.setLatLng([lat, lon]);
        marker.setIcon(L.divIcon({
          className: 'fleet-pin',
          html:
            '<div style="' +
            'width:18px;height:18px;border-radius:50%;' +
            'background:' + color + ';' +
            'border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,0.3)' +
            '"></div>',
          iconSize: [18, 18],
          iconAnchor: [9, 9],
        }));
      }
      marker.bindPopup(popup);
    }

    // Drop markers for vehicles that disappeared from the data.
    for (const [id, m] of markersRef.current) {
      if (!seen.has(id)) {
        map.removeLayer(m);
        markersRef.current.delete(id);
      }
    }

    // Fit bounds on first paint with data; afterwards leave the user's view alone.
    if (fitBounds.length > 0 && !(map as any)._fittedOnce) {
      map.fitBounds(fitBounds, { padding: [40, 40], maxZoom: 14 });
      (map as any)._fittedOnce = true;
    }
  }, [rows]);

  const stale = rows.filter((r) => {
    if (!r.snap) return true;
    const t = Date.parse(r.snap.snapshot_at);
    return isNaN(t) || (Date.now() - t > STALE_MS);
  });
  const live  = rows.length - stale.length;

  return (
    <>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <Legend />
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 10, color: 'var(--mt)' }}>
          {loading ? 'loading…' :
            err ? <span style={{ color: '#c44' }}>{err}</span> :
            (live + ' live · ' + stale.length + ' stale · refreshed ' + relTime(lastFetch ? new Date(lastFetch).toISOString() : null))}
        </div>
      </div>
      <div ref={mapEl} style={{ flex: 1, background: '#222' }} />
      <SidePanel rows={rows} />
    </>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 10, color: 'var(--mt)' }}>
      <Dot c="#22aa55" /> driving
      <Dot c="#3a78d9" /> parked
      <Dot c="#888"   /> stale (&gt;1h)
    </div>
  );
}

function Dot({ c }: { c: string }) {
  return <span style={{
    display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: c,
    marginLeft: 8, marginRight: 2, verticalAlign: 'middle',
  }} />;
}

function SidePanel({ rows }: { rows: FleetMapRow[] }) {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => {
    const ta = a.snap ? Date.parse(a.snap.snapshot_at) : 0;
    const tb = b.snap ? Date.parse(b.snap.snapshot_at) : 0;
    return tb - ta;
  });
  return (
    <div style={{
      borderTop: '1px solid var(--bd)',
      maxHeight: 180,
      overflow: 'auto',
      fontSize: 11,
      background: 'var(--pn)',
    }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead style={{ position: 'sticky', top: 0, background: 'var(--pn)' }}>
          <tr style={{ color: 'var(--mt)', textAlign: 'left' }}>
            <th style={th}>Vehicle</th>
            <th style={th}>Plate</th>
            <th style={th}>State</th>
            <th style={thR}>Speed</th>
            <th style={thR}>Last seen</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => {
            const t = r.snap ? Date.parse(r.snap.snapshot_at) : NaN;
            const isStale = !r.snap || isNaN(t) || (Date.now() - t > STALE_MS);
            const speedMph = r.snap?.speed_kmh != null
              ? (Number(r.snap.speed_kmh) * 0.621371).toFixed(0)
              : '—';
            return (
              <tr key={r.fc_asset_id} style={{ borderTop: '1px solid var(--bd)' }}>
                <td style={td}>{vehicleLabel(r)}</td>
                <td style={td}>{r.license_plate ?? '—'}</td>
                <td style={td}>
                  <span style={{
                    color: isStale ? '#888'
                      : r.snap?.ignition_on ? '#22aa55' : '#3a78d9',
                  }}>
                    {isStale ? 'stale' : r.snap?.ignition_on ? 'driving' : 'parked'}
                  </span>
                </td>
                <td style={tdR}>{r.snap?.ignition_on ? speedMph + ' mph' : '—'}</td>
                <td style={tdR}>{relTime(r.snap?.snapshot_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const th  = { padding: '4px 10px', fontWeight: 600 } as const;
const thR = { ...th, textAlign: 'right' as const };
const td  = { padding: '4px 10px' } as const;
const tdR = { ...td, textAlign: 'right' as const };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] as string));
}

// ---------- Trips tab ----------
//
// Last-7-days trip list joined to vehicle name and (when available) driver
// name. Sortable by start time desc by default. Displays distance, duration,
// max speed, and harsh-event counts.

function TripsTab() {
  const [trips, setTrips]     = useState<FleetTrip[]>([]);
  const [vehicles, setVeh]    = useState<FleetMapRow[]>([]);
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([fetchRecentTrips(7), fetchFleetMapRows(), fetchFleetDrivers()])
      .then(([t, v, d]) => {
        if (stopped) return;
        setTrips(t); setVeh(v); setDrivers(d);
        setLoading(false);
      })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  const vehicleById = useMemo(() => {
    const m = new Map<string, FleetMapRow>();
    for (const v of vehicles) m.set(v.fc_asset_id, v);
    return m;
  }, [vehicles]);
  const driverById = useMemo(() => {
    const m = new Map<string, FleetDriver>();
    for (const d of drivers) m.set(d.fc_person_id, d);
    return m;
  }, [drivers]);

  const totals = useMemo(() => {
    let miles = 0, drive = 0, idle = 0, brakes = 0, accels = 0, viol = 0;
    for (const t of trips) {
      miles  += Number(t.distance_miles  ?? 0);
      drive  += Number(t.drive_time_min  ?? 0);
      idle   += Number(t.idle_time_min   ?? 0);
      brakes += t.hard_brakes ?? 0;
      accels += t.hard_accels ?? 0;
      viol   += t.speed_violations ?? 0;
    }
    return { miles, drive, idle, brakes, accels, viol };
  }, [trips]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Trips (7d)"     value={String(trips.length)} />
        <Stat label="Miles"          value={totals.miles.toFixed(0)} />
        <Stat label="Drive hours"    value={(totals.drive / 60).toFixed(1)} />
        <Stat label="Idle hours"     value={(totals.idle / 60).toFixed(1)} />
        <Stat label="Hard brakes"    value={String(totals.brakes)} />
        <Stat label="Hard accels"    value={String(totals.accels)} />
        <Stat label="Speed violations" value={String(totals.viol)} />
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       trips.length === 0 ? <div style={{ color: 'var(--mt)' }}>No trips in the last 7 days.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Date</th>
              <th style={th}>Vehicle</th>
              <th style={th}>Driver</th>
              <th style={th}>Start</th>
              <th style={th}>End</th>
              <th style={thR}>Miles</th>
              <th style={thR}>Drive</th>
              <th style={thR}>Idle</th>
              <th style={thR}>Max</th>
              <th style={thR}>Brakes</th>
              <th style={thR}>Accels</th>
              <th style={thR}>Speed</th>
            </tr>
          </thead>
          <tbody>
            {trips.map((t) => {
              const v = t.fc_asset_id ? vehicleById.get(t.fc_asset_id) : null;
              const d = t.fc_driver_id ? driverById.get(t.fc_driver_id) : null;
              return (
                <tr key={t.fc_trip_id} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{t.trip_date}</td>
                  <td style={td}>{v ? vehicleLabel(v) : (t.fc_asset_id ?? '—').slice(0, 8) + '…'}</td>
                  <td style={td}>{d ? (d.first_name + ' ' + (d.last_name ?? '')) : (t.fc_driver_id ? '(unknown)' : '—')}</td>
                  <td style={td}>{shortTime(t.start_time)}</td>
                  <td style={td}>{shortTime(t.end_time)}</td>
                  <td style={tdR}>{Number(t.distance_miles ?? 0).toFixed(1)}</td>
                  <td style={tdR}>{Math.round(Number(t.drive_time_min ?? 0))}m</td>
                  <td style={tdR}>{Math.round(Number(t.idle_time_min ?? 0))}m</td>
                  <td style={tdR}>{Math.round(Number(t.max_speed_mph ?? 0))} mph</td>
                  <td style={tdR}>{(t.hard_brakes ?? 0) || ''}</td>
                  <td style={tdR}>{(t.hard_accels ?? 0) || ''}</td>
                  <td style={tdR}>{(t.speed_violations ?? 0) || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Drivers tab ----------

function DriversTab() {
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    fetchFleetDrivers()
      .then((d) => { if (!stopped) { setDrivers(d); setLoading(false); } })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--mt)' }}>
        Synced from Unity getPeople (isDriver=true). Refreshed hourly.
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       drivers.length === 0 ? <div style={{ color: 'var(--mt)' }}>No drivers synced yet.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Name</th>
              <th style={th}>Email</th>
              <th style={th}>Employee ID</th>
              <th style={th}>Portal user</th>
            </tr>
          </thead>
          <tbody>
            {drivers.map((d) => (
              <tr key={d.fc_person_id} style={{ borderTop: '1px solid var(--bd)' }}>
                <td style={td}>{[d.first_name, d.last_name].filter(Boolean).join(' ') || '—'}</td>
                <td style={td}>{d.email ?? '—'}</td>
                <td style={td}>{d.employee_id ?? '—'}</td>
                <td style={td}>{d.is_user ? 'yes' : 'no'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------- Safety tab ----------
//
// Per-driver event counts, last 7 days. Bucketed by event_type. Score is a
// homegrown 0-100 (Powerfleet's official "Safety Score" comes from a wrapped
// report we can't reach yet).

function SafetyTab() {
  const [events, setEvents] = useState<FleetDriverEvent[]>([]);
  const [drivers, setDrivers] = useState<FleetDriver[]>([]);
  const [trips, setTrips] = useState<FleetTrip[]>([]);
  const [vehicles, setVeh] = useState<FleetMapRow[]>([]);
  const [geofenceCount, setGeofenceCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    Promise.all([
      fetchRecentDriverEvents(7),
      fetchFleetDrivers(),
      fetchRecentTrips(7),
      fetchFleetMapRows(),
      fetchGeofenceCount(),
    ])
      .then(([e, d, t, v, g]) => {
        if (stopped) return;
        setEvents(e); setDrivers(d); setTrips(t); setVeh(v); setGeofenceCount(g);
        setLoading(false);
      })
      .catch((e) => { if (!stopped) { setErr(String(e)); setLoading(false); } });
    return () => { stopped = true; };
  }, []);

  // Bucket events per driver/vehicle. driver may be null on the snapshot —
  // those events get bucketed by vehicle (label 'unknown driver').
  const safetyRows = useMemo(() => {
    interface Row {
      key: string;
      label: string;
      vehicleLabel: string | null;
      total: number;
      counts: Record<string, number>;
    }
    const map = new Map<string, Row>();
    for (const ev of events) {
      const key = ev.fc_driver_id || ('vehicle:' + ev.fc_asset_id);
      let row = map.get(key);
      if (!row) {
        const driver = ev.fc_driver_id ? drivers.find((d) => d.fc_person_id === ev.fc_driver_id) : null;
        const vehicle = vehicles.find((v) => v.fc_asset_id === ev.fc_asset_id);
        row = {
          key,
          label: driver
            ? [driver.first_name, driver.last_name].filter(Boolean).join(' ')
            : '(unknown driver)',
          vehicleLabel: vehicle ? vehicleLabel(vehicle) : null,
          total: 0,
          counts: {},
        };
        map.set(key, row);
      }
      row.total += 1;
      row.counts[ev.event_type] = (row.counts[ev.event_type] ?? 0) + 1;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [events, drivers, vehicles]);

  // Total miles in window (use as denominator for events/100mi).
  const totalMiles = useMemo(() => trips.reduce((s, t) => s + Number(t.distance_miles ?? 0), 0), [trips]);

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 14 }}>
      {geofenceCount === 0 && (
        <div style={{
          background: 'var(--pn)', border: '1px solid var(--bd)',
          padding: 10, borderRadius: 4, marginBottom: 14, fontSize: 11, color: 'var(--mt)',
        }}>
          <strong style={{ color: 'var(--tx)' }}>No geofences yet.</strong>{' '}
          Auto-geofencing from QBO customer addresses is on the roadmap. In the meantime, you can also define them manually in the Powerfleet portal — one per Melt store / depot / fuel station unlocks stop attribution.
        </div>
      )}
      <div style={{ display: 'flex', gap: 18, marginBottom: 14, fontSize: 11 }}>
        <Stat label="Events (7d)"        value={String(events.length)} />
        <Stat label="Miles (7d)"         value={totalMiles.toFixed(0)} />
        <Stat label="Events / 100 mi"    value={totalMiles > 0 ? (100 * events.length / totalMiles).toFixed(1) : '—'} />
      </div>
      <div style={{ marginBottom: 8, fontSize: 11, color: 'var(--mt)' }}>
        Per-driver event counts (last 7 days). Powerfleet's official "Safety Score" comes from a wrapped report that's currently broken upstream — these raw counts are the substitute.
      </div>
      {loading ? <div style={{ color: 'var(--mt)' }}>loading…</div> :
       err     ? <div style={{ color: '#c44' }}>{err}</div> :
       safetyRows.length === 0 ? <div style={{ color: 'var(--mt)' }}>No driver-behavior events in the last 7 days.</div> :
       (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr style={{ color: 'var(--mt)', textAlign: 'left', borderBottom: '1px solid var(--bd)' }}>
              <th style={th}>Driver</th>
              <th style={th}>Vehicle (last)</th>
              <th style={thR}>Events</th>
              <th style={thR}>Brake</th>
              <th style={thR}>Accel</th>
              <th style={thR}>Corner</th>
              <th style={thR}>Speed</th>
              <th style={thR}>Tailgate</th>
              <th style={thR}>Coll/Lane</th>
              <th style={thR}>Other</th>
            </tr>
          </thead>
          <tbody>
            {safetyRows.map((r) => {
              const c = r.counts;
              const speed = (c['MAX_SPEED_EXCEEDED'] ?? 0) + (c['SPEED_SIGN_VIOLATION'] ?? 0);
              const collLane = (c['FORWARD_COLLISION'] ?? 0) + (c['COLLISION'] ?? 0) + (c['LANE_DRIFT'] ?? 0) + (c['ROLL_OVER'] ?? 0);
              const known = (c['HARSH_BRAKING'] ?? 0) + (c['HARSH_ACCELERATION'] ?? 0) + (c['HARSH_CORNERING'] ?? 0) + speed + (c['TAILGATING'] ?? 0) + collLane;
              const other = r.total - known;
              return (
                <tr key={r.key} style={{ borderTop: '1px solid var(--bd)' }}>
                  <td style={td}>{r.label}</td>
                  <td style={td}>{r.vehicleLabel ?? '—'}</td>
                  <td style={tdR}>{r.total}</td>
                  <td style={tdR}>{c['HARSH_BRAKING'] || ''}</td>
                  <td style={tdR}>{c['HARSH_ACCELERATION'] || ''}</td>
                  <td style={tdR}>{c['HARSH_CORNERING'] || ''}</td>
                  <td style={tdR}>{speed || ''}</td>
                  <td style={tdR}>{c['TAILGATING'] || ''}</td>
                  <td style={tdR}>{collLane || ''}</td>
                  <td style={tdR}>{other || ''}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ color: 'var(--mt)', fontSize: 9, letterSpacing: 0.4, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
