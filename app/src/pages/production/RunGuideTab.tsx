import { useMemo, useState } from 'react';
import { BookOpen, Download, ExternalLink, Copy, Check } from 'lucide-react';
import { btnPrimary, btnSecondary } from '../../lib/styles';

// The guide itself lives in the APBG Handbook (docs/handbook/10a-production-run-guide.md),
// rendered by the viewer at public/docs/handbook/index.html. This tab does NOT hold a
// second copy of the text — one guide, one home, or the two drift the first time
// somebody edits one. It frames the real viewer and hands out the link.
//
// The path differs by how the app was reached: through the gateway the SPA is served at
// /margin/ and the handbook at /margin/docs/handbook/; hitting Netlify directly the SPA
// is /sales-next/ and the handbook is /docs/handbook/. Derive it rather than hardcoding,
// or the link is dead on one of the two.
const GUIDE_SLUG = '10a-production-run-guide';

function docsBase(): string {
  const path = typeof location === 'undefined' ? '' : location.pathname;
  return path.includes('/margin/') ? '/margin/docs' : '/docs';
}

export function guideUrl(): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return `${origin}${docsBase()}/handbook/#/${GUIDE_SLUG}`;
}

// The framed copy asks the viewer to drop its own sidebar and Back-to-the-Hub —
// chrome inside chrome, and a hub link in a frame strands a hub in a tab. The
// viewer also detects framing on its own; the flag is the explicit half.
function embedUrl(): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  return `${origin}${docsBase()}/handbook/?embed=1#/${GUIDE_SLUG}`;
}

// The PDF sits beside the guide's screenshots in public/production-guide/. Behind the
// gateway that tree is reached at /billing/... (the same prefix the guide's own <img>
// tags use); hitting Netlify directly it is at the root. /margin/* proxies to the Vite
// bundle, NOT to the site root, so /margin/production-guide/ would 404 — do not "tidy"
// this to match docsBase().
function pdfUrl(): string {
  const origin = typeof location === 'undefined' ? '' : location.origin;
  const path = typeof location === 'undefined' ? '' : location.pathname;
  const base = path.includes('/margin/') ? '/billing/production-guide' : '/production-guide';
  return `${origin}${base}/Brix-Production-Run-Guide.pdf`;
}

export function RunGuideTab() {
  const url = useMemo(guideUrl, []);
  const framed = useMemo(embedUrl, []);
  const pdf = useMemo(pdfUrl, []);
  const [copied, setCopied] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard is blocked in plenty of contexts; the URL is on screen either way.
      setFrameFailed(false);
    }
  }

  return (
    <div>
      <div className="card" style={{ padding: 16, marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
          <BookOpen size={18} style={{ color: 'var(--ac)', marginTop: 2, flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <div style={{ fontSize: 13.5, fontWeight: 600 }}>
              Running a Production Run — Click by Click
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--mt)', marginTop: 3, lineHeight: 1.5 }}>
              One run of Hangar 25 Cola from “we need 500 cases” to received stock — 15 screenshots
              of these screens, plus a 20-step QC test script with the expected result at every step.
              Send the PDF to whoever is testing; the online copy is the one that stays current.
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ ...btnPrimary(), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <ExternalLink size={13} /> Open the guide in a new tab
          </a>
          <a href={pdf} target="_blank" rel="noopener noreferrer" style={{ ...btnSecondary(), textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Download size={13} /> Download the PDF (22 pages)
          </a>
          <button onClick={copyLink} style={{ ...btnSecondary(), display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Link copied' : 'Copy the link'}
          </button>
        </div>

        <div style={{ fontSize: 10.5, color: 'var(--mt)', marginTop: 10, wordBreak: 'break-all', fontFamily: 'ui-monospace, monospace' }}>
          {url}
        </div>
      </div>

      {frameFailed ? (
        <div className="card" style={{ padding: 16, fontSize: 12, color: 'var(--mt)' }}>
          The guide could not be shown inside this page. Use{' '}
          <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--ac)' }}>Open the guide in a new tab</a>.
        </div>
      ) : (
        <iframe
          title="Running a Production Run — Click by Click"
          src={framed}
          onError={() => setFrameFailed(true)}
          style={{
            width: '100%', height: 'calc(100vh - 360px)', minHeight: 520,
            border: '1px solid var(--bd)', borderRadius: 10, background: 'var(--bg)',
          }}
        />
      )}
    </div>
  );
}
