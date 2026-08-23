// tests/ap-inbox.test.mjs — the AP bill inbox (bills@alamedapointbg.com).
//
// Written against the SHAPES the live Resend receiving API actually returned
// for the first two invoices emailed to bills@ (2026-08-22): the email read
// does NOT inline attachment content, the attachment endpoint hands back a
// signed download_url, and one of the two PDFs arrived with an UPPERCASE
// .PDF extension.
//
// Run: npm test
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'https://gfsdpwiqzshhexkofiif.supabase.co';

const {
  fetchResendAttachments, rankAttachments, makeDiag, guessMediaType, OCRABLE,
  safeFilename, stripHtml,
} = await import('../netlify/functions/lib/resend-inbound.mjs');

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`); pass++; }
  catch (e) { console.log(`  FAIL ${name}\n       ${e.message}`); process.exitCode = 1; }
};

// A minimal but genuine PDF — enough to prove the bytes survive the
// metadata -> download_url -> base64 -> Buffer round trip intact.
const realPdf = Buffer.from(
  '%PDF-1.6\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
  + '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n'
  + '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\n'
  + 'trailer<</Root 1 0 R>>\n%%EOF\n', 'latin1');
const EMAIL_ID = '93306f1f-3749-4ab2-a1e0-5aa090f70a06';
const ATT_ID = 'b1cfe60f-2abb-45c7-9198-1cadeb9e8f93';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

console.log('\n— reading a real inbound bill —');

await t('pulls the PDF via the attachments endpoint + download_url (the live shape)', async () => {
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.endsWith(`emails/receiving/${EMAIL_ID}`)) {
      // Live shape: the email read does NOT inline attachment content.
      return json({ data: { id: EMAIL_ID, subject: 'Fwd: Invoice',
        attachments: [{ id: ATT_ID, filename: 'Western Pacific Distributors Inc Invoices - MGM2YIPNEH.pdf',
                        content_type: 'application/pdf', size: 179273 }] } });
    }
    if (u.includes(`/attachments/${ATT_ID}`)) {
      return json({ data: { download_url: 'https://cdn.resend.app/signed/blob' } });
    }
    if (u === 'https://cdn.resend.app/signed/blob') {
      return new Response(realPdf, { status: 200, headers: { 'content-type': 'application/pdf' } });
    }
    return new Response('not found', { status: 404 });
  };
  process.env.RESEND_INBOUND_API_KEY = 'full_access_key';
  const diag = makeDiag();
  const out = await fetchResendAttachments(EMAIL_ID, { diag });
  assert.equal(out.length, 1);
  assert.equal(out[0].mediaType, 'application/pdf');
  assert.equal(Buffer.from(out[0].base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.equal(Buffer.from(out[0].base64, 'base64').length, realPdf.length, 'byte-exact round trip');
  assert.equal(diag.text(), null, 'a clean read records no diagnostics');
});

console.log('\n— the failure that cost brix-order a day —');

await t('a send-only key is NAMED, not silently read as "no attachment"', async () => {
  globalThis.fetch = async (url) => json(
    { statusCode: 401, message: 'This API key is restricted to only send emails', name: 'restricted_api_key' },
    401,
  );
  delete process.env.RESEND_INBOUND_API_KEY;
  process.env.RESEND_API_KEY = 'send_only_key';
  const diag = makeDiag();
  const out = await fetchResendAttachments(EMAIL_ID, { diag });
  assert.equal(out.length, 0);
  const d = diag.text();
  assert.match(d, /401/, 'quotes the literal status');
  assert.match(d, /restricted_api_key/);
  assert.match(d, /RESEND_INBOUND_API_KEY/, 'names the variable to set');
  assert.match(d, /send-only/, 'says the fallback key is the problem');
});

await t('"no attachment" and "could not read it" stay distinguishable', async () => {
  globalThis.fetch = async () => json({ data: { id: EMAIL_ID, attachments: [] } });
  process.env.RESEND_INBOUND_API_KEY = 'full_access_key';
  const diag = makeDiag();
  const out = await fetchResendAttachments(EMAIL_ID, { diag });
  assert.equal(out.length, 0);
  // No failed reads → no diagnostics → the processor files `no_attachment`,
  // not `attachment_fetch_failed`. That branch is the whole point.
  assert.equal(diag.text(), null);
});

console.log('\n— picking the right file —');

await t('a real PDF beats four inline signature logos', () => {
  const ranked = rankAttachments([
    { filename: 'img-9f2c1a4b8e01.png', mediaType: 'image/png', base64: 'x', approxBytes: 67_000 },
    { filename: 'image-0a1b2c3d4e5f.png', mediaType: 'image/png', base64: 'x', approxBytes: 4_000 },
    { filename: 'Invoice 44821.pdf', mediaType: 'application/pdf', base64: 'x', approxBytes: 179_273 },
    { filename: 'img-77aa11bb22cc.jpg', mediaType: 'image/jpeg', base64: 'x', approxBytes: 12_000 },
  ]);
  assert.equal(ranked[0].filename, 'Invoice 44821.pdf');
  assert.equal(ranked.length, 1, 'signature art is dropped once a PDF is present');
});

await t('a photographed receipt still works when there is no PDF', () => {
  const ranked = rankAttachments([
    { filename: 'IMG_4432.jpg', mediaType: 'image/jpeg', base64: 'x', approxBytes: 2_100_000 },
  ]);
  assert.equal(ranked.length, 1);
  assert.ok(OCRABLE.has(ranked[0].mediaType));
});

await t('media type recovers from octet-stream via the real filename', () => {
  // The live email used an UPPERCASE .PDF extension.
  assert.equal(guessMediaType('application/octet-stream', '00ALASO_SO_0301000IN_20260819_000.PDF'), 'application/pdf');
  assert.equal(guessMediaType(null, 'scan.JPG'), 'image/jpeg');
});

await t('storage filenames survive a vendor\'s spaces and punctuation', () => {
  assert.equal(
    safeFilename('Western Pacific Distributors Inc Invoices - MGM2YIPNEH.pdf'),
    'Western_Pacific_Distributors_Inc_Invoices_-_MGM2YIPNEH.pdf',
  );
});

console.log('\n— who is allowed to mail us a bill —');

const { senderAllowed, looksAutomated, addr, displayName, recipientsOf,
        resolveBillRouting, hasBrixpenseAccess } =
  await import('../netlify/functions/lib/ap-inbox.mjs');

await t('an empty allow list accepts a vendor mailing us directly', () => {
  const s = { allow_senders: [], block_senders: [] };
  assert.equal(senderAllowed('ar@westernpacific.com', s).ok, true);
  assert.equal(senderAllowed('skypace@brixbev.com', s).ok, true);
});

await t('the block list wins and says why', () => {
  const r = senderAllowed('spam@junk.example', { allow_senders: [], block_senders: ['junk.example'] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /block list/);
});

await t('a populated allow list keeps everyone else out', () => {
  const s = { allow_senders: ['brixbev.com'], block_senders: [] };
  assert.equal(senderAllowed('joel@brixbev.com', s).ok, true);
  assert.equal(senderAllowed('someone@elsewhere.com', s).ok, false);
});

await t('auto-replies and bounces never become bill drafts', () => {
  assert.equal(looksAutomated({ from: 'mailer-daemon@x.com', subject: 'Undeliverable' }), true);
  assert.equal(looksAutomated({ from: 'a@b.com', subject: 'Automatic reply: Invoice' }), true);
  assert.equal(looksAutomated({ from: 'a@b.com', subject: 'Invoice', headers: { 'Auto-Submitted': 'auto-replied' } }), true);
  assert.equal(looksAutomated({ from: 'ar@vendor.com', subject: 'Invoice 44821' }), false);
});

await t('routes on the real recipient shapes', () => {
  assert.equal(addr('Sky Pace <skypace@brixbev.com>'), 'skypace@brixbev.com');
  assert.equal(displayName('Sky Pace <skypace@brixbev.com>'), 'Sky Pace');
  assert.deepEqual(
    recipientsOf({ to: ['bills@alamedapointbg.com'], cc: 'AP <ap@alamedapointbg.com>' }),
    ['bills@alamedapointbg.com', 'ap@alamedapointbg.com'],
  );
  // The domain-wide webhook fan-out: other channels' mail must not match.
  assert.equal(recipientsOf({ to: ['themelt@alamedapointbg.com'] }).includes('bills@alamedapointbg.com'), false);
});

await t('html-only vendor mail still yields readable body text', () => {
  assert.equal(stripHtml('<p>Invoice&nbsp;44821</p><div>Total $1,204.50</div>'), 'Invoice 44821\nTotal $1,204.50');
});

console.log('\n— whose approval queue it lands in —');

// The shape loadApInboxSettings() produces, with nothing configured.
const bare = {
  sender_routes: {}, vendor_routes: {}, department_approvers: {},
  default_approver: null,
};
const internal = (email) => ({ id: 'u1', email, name: email });

await t('an internal sender owns their own bill', () => {
  const r = resolveBillRouting({
    fromEmail: 'joel@brixbev.com',
    internalUser: internal('joel@brixbev.com'),
    settings: bare,
  });
  assert.equal(r.owner_email, 'joel@brixbev.com');
  assert.equal(r.assigned, true);
  assert.equal(r.self_review, true, 'flagged as a self review, not silently equated to approval');
  assert.match(r.reason, /internal Brixpense user/);
});

await t('an explicit sender_route outranks the sender — the separation-of-duties escape hatch', () => {
  const r = resolveBillRouting({
    fromEmail: 'joel@brixbev.com',
    internalUser: internal('joel@brixbev.com'),
    settings: { ...bare, sender_routes: { 'joel@brixbev.com': 'anthonyv@brixbev.com' } },
  });
  assert.equal(r.owner_email, 'anthonyv@brixbev.com');
  assert.equal(r.self_review, false);
});

await t('a vendor mailing in matches the vendor route', () => {
  const r = resolveBillRouting({
    fromEmail: 'ar@promechanical.com',
    internalUser: null,
    ocrVendor: 'PRO MECHANICAL SERVICES INC',
    settings: { ...bare, vendor_routes: { 'pro mechanical': 'anthonyv@brixbev.com' } },
  });
  assert.equal(r.owner_email, 'anthonyv@brixbev.com');
  assert.match(r.reason, /vendor route/);
});

await t('falls through to the department when no vendor rule matches', () => {
  const r = resolveBillRouting({
    fromEmail: 'billing@somevendor.com',
    internalUser: null,
    ocrVendor: 'Some Vendor LLC',
    ocrAccountLabel: 'Service - Direct Labor (COGS)',
    settings: { ...bare, department_approvers: { service: 'anthonyv@brixbev.com' } },
  });
  assert.equal(r.owner_email, 'anthonyv@brixbev.com');
  assert.match(r.reason, /service approver/);
});

await t('then the default approver', () => {
  const r = resolveBillRouting({
    fromEmail: 'billing@somevendor.com',
    internalUser: null,
    ocrVendor: 'Some Vendor LLC',
    settings: { ...bare, default_approver: 'ap@brixbev.com' },
  });
  assert.equal(r.owner_email, 'ap@brixbev.com');
});

await t('and the floor is a visible pile, never a silent drop', () => {
  const r = resolveBillRouting({
    fromEmail: 'billing@somevendor.com',
    internalUser: null,
    ocrVendor: 'Some Vendor LLC',
    settings: bare,
  });
  assert.equal(r.owner_email, null);
  assert.equal(r.assigned, false, 'unassigned rows stay in the AP Inbox for triage');
  assert.match(r.reason, /triage/);
});

console.log('\n— the approval gate —');

// The status an emailed bill lands with, mirroring the processor's rule.
const landingStatus = (assigned, requireApproval) =>
  assigned && requireApproval ? 'pending' : (assigned ? 'approved' : 'draft');

await t('with the gate OFF (the default) an owned bill is immediately postable', () => {
  const st = landingStatus(true, false);
  assert.equal(st, 'approved');
  // link-bill's LINKABLE_STATUSES — the actual gate on posting.
  assert.ok(['approved', 'awaiting_invoice', 'fulfilled'].includes(st));
});

await t('with the gate ON it waits in the approver\'s queue', () => {
  const st = landingStatus(true, true);
  assert.equal(st, 'pending');
  assert.equal(['approved', 'awaiting_invoice', 'fulfilled'].includes(st), false,
    'cannot post until approved');
});

await t('unassigned mail stays a draft either way', () => {
  assert.equal(landingStatus(false, false), 'draft');
  assert.equal(landingStatus(false, true), 'draft');
});

console.log('\n— the shared-project trap —');

await t('only a Brixpense login counts as internal', () => {
  // The Supabase project is shared. A brix-order customer emailing an invoice
  // must NOT be handed a staff owner and an approval queue.
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'superadmin' } }), true);
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'finance' } }), true);
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'admin' } }), true);
  assert.equal(hasBrixpenseAccess({ user_metadata: {} }), false, 'a bare customer login');
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'customer' } }), false);
  // An explicit modules list wins over the legacy role map, in both directions.
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'admin', modules: ['orders'] } }), false);
  assert.equal(hasBrixpenseAccess({ user_metadata: { role: 'driver', modules: ['billing'] } }), true);
});

console.log(`\n${pass} passed\n`);
