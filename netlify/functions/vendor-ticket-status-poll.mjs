// vendor-ticket-status-poll — 5-minute safety net for vendor ticket updates.
//
// SF's notification emails proved unreliable as the only status signal
// (2026-07-22 live testing: status flips produced no email). This scheduled
// function walks every OPEN vendor ticket (ops.vendor_email_tickets, status
// sf_created, non-terminal), reads each SF job, and relays any status change
// through the exact same pipeline as the email trigger — event log + the
// vendor-ticket-update template to the vendor recipients + internal send
// list. Tickets stop polling at a terminal status (invoiced/cancelled) or
// after 60 days. The sf-status@ email path stays live as the instant lane;
// both feed applyStatusChange, which dedupes on last_sf_status, so double
// delivery is impossible.

import { pollVendorTicketStatuses } from './vendor-email-intake.mjs';

export async function handler() {
  try {
    const result = await pollVendorTicketStatuses();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error('[vendor-poll] tick failed:', e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}

export const config = {
  schedule: '*/5 * * * *',
};
