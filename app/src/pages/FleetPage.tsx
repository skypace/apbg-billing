import { useEffect, useRef, useState } from 'react';
import { fetchFleetMapRows, type FleetMapRow } from '../lib/fleet';

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

export function FleetPage() {
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
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 70px)' }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--bd)', display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 0.5 }}>FLEET · LIVE MAP</div>
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
    </div>
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
