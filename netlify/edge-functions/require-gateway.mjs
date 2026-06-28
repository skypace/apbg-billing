// ═══ Domain control — gateway-only access ═══
// This site should only be reached through https://alamedapointbg.com (the
// apbg-gateway proxy). The gateway stamps every proxied request with an
// X-APBG-Proxy header; requests without it — i.e. direct hits on
// apbg-billing.netlify.app — get a 301 to the branded URL.
//
// Activation: enforcement is OFF until the APBG_PROXY_SECRET env var is set
// on this site (same value as the header in apbg-gateway/netlify.toml).
// Merge + deploy order: gateway first (so the header is being stamped), then
// this, then set the env var. Unset the env var to turn it back off.
//
// Always allowed regardless:
//   - deploy previews + branch deploys (hosts containing "--")
//   - /api/* and /.netlify/* — QBO/SF OAuth callbacks, Brixpense v2 function
//     paths, gateway health probes (health-watchdog / pacer-health), and
//     scheduled-function invocations all hit those paths directly and carry
//     their own auth (secrets / JWTs).

const GATEWAY = 'https://alamedapointbg.com';

function mapPath(pathname) {
  // Surfaces with their own branded prefixes on the gateway
  if (pathname.startsWith('/expense/') || pathname === '/expense') return pathname;
  if (pathname.startsWith('/sales-next/')) return pathname;          // /sales-next/* is proxied 1:1
  if (pathname.startsWith('/docs/')) return '/margin' + pathname;    // → /margin/docs/*
  if (pathname === '/control.html') return '/control';
  if (pathname === '/' || pathname === '/index.html') return '/billing/';
  if (pathname.startsWith('/billing/')) return pathname;
  return '/billing' + pathname;                                      // AP tool pages (sync.html, setup.html, …)
}

export default async (request, context) => {
  const secret = Netlify.env.get('APBG_PROXY_SECRET');
  if (!secret) return context.next(); // fail open until configured
  if (request.headers.get('x-apbg-proxy') === secret) return context.next();

  const url = new URL(request.url);
  if (url.hostname.includes('--') || url.hostname === 'localhost') return context.next();

  return Response.redirect(GATEWAY + mapPath(url.pathname) + url.search, 301);
};

export const config = {
  path: '/*',
  excludedPath: ['/api/*', '/.netlify/*'],
};
