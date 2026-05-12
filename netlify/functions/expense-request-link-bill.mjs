import { createClient } from '@supabase/supabase-js';
import { qboRequest, qboQuery, corsHeaders } from './qbo-helpers.mjs';
import { requireAuth } from './lib/auth.mjs';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Require authenticated user
  const auth = await requireAuth(event, ['superadmin', 'admin', 'manager']);
  if (!auth.ok) return auth.response;

  try {
    const { request_id } = JSON.parse(event.body || '{}');
    if (!request_id) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'request_id required' }) };
    }

    // Load expense request
    const { data: request, error: fetchErr } = await supabase
      .from('expense_requests')
      .select('*')
      .eq('id', request_id)
      .single();

    if (fetchErr || !request) {
      return { statusCode: 404, headers: corsHeaders(), body: JSON.stringify({ error: 'Request not found' }) };
    }

    // Must be approved
    if (request.status !== 'approved') {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Request must be approved before creating a bill' }) };
    }

    // Don't create duplicate bills
    if (request.qbo_bill_id) {
      return {
        statusCode: 200,
        headers: corsHeaders(),
        body: JSON.stringify({ qbo_bill_id: request.qbo_bill_id, already_linked: true }),
      };
    }

    // Build QBO bill lines from line_items
    const lineItems = request.line_items || [];
    const billLines = lineItems.map((li, idx) => ({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: Number(li.amount),
      Description: li.description || `Line ${idx + 1}`,
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: String(li.cogs_account_id) },
      },
    }));

    if (billLines.length === 0) {
      // Fallback: single line from total
      billLines.push({
        DetailType: 'AccountBasedExpenseLineDetail',
        Amount: Number(request.total_amount),
        Description: request.notes || 'Expense',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: '101' }, // Default: Service COGS
        },
      });
    }

    // Build private note
    const noteParts = [];
    if (request.job_number) noteParts.push(`Job: ${request.job_number}`);
    if (request.department) noteParts.push(`Dept: ${request.department}`);
    if (request.tag_type) noteParts.push(`Tag: ${request.tag_type}${request.tag_value ? ` — ${request.tag_value}` : ''}`);
    noteParts.push(`Submitted by: ${request.submitter_name || request.submitter_email}`);
    noteParts.push(`Expense ID: ${request.id}`);

    // Build bill payload
    const billPayload = {
      Line: billLines,
      PrivateNote: noteParts.join(' | '),
    };

    // Look up vendor in QBO if vendor_name provided
    if (request.vendor_name) {
      try {
        const vendorQuery = `SELECT Id, DisplayName FROM Vendor WHERE DisplayName = '${request.vendor_name.replace(/'/g, "\\'")}'`;
        const vendorResult = await qboQuery(vendorQuery);
        const vendors = vendorResult?.QueryResponse?.Vendor;
        if (vendors && vendors.length > 0) {
          billPayload.VendorRef = { value: vendors[0].Id, name: vendors[0].DisplayName };
        }
      } catch (vendorErr) {
        console.warn('Vendor lookup failed, creating bill without vendor ref:', vendorErr.message);
      }
    }

    // Set transaction date
    if (request.expense_date) {
      billPayload.TxnDate = request.expense_date;
    }

    // Create the bill in QBO
    const billResult = await qboRequest('POST', '/bill', billPayload);
    const qboBillId = billResult?.Bill?.Id;

    if (!qboBillId) {
      console.error('QBO bill creation response:', JSON.stringify(billResult));
      return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Failed to create QBO bill' }) };
    }

    // Try to match invoice by job number
    let invoiceMatch = null;
    if (request.job_number) {
      try {
        // Search invoices by job number in PrivateNote or DocNumber
        const invoiceQuery = `SELECT Id, DocNumber, TotalAmt, CustomerRef, PrivateNote FROM Invoice WHERE PrivateNote LIKE '%${request.job_number}%' ORDERBY MetaData.CreateTime DESC MAXRESULTS 5`;
        const invoiceResult = await qboQuery(invoiceQuery);
        const invoices = invoiceResult?.QueryResponse?.Invoice;

        if (invoices && invoices.length > 0) {
          const inv = invoices[0];
          const margin = Number(inv.TotalAmt) - Number(request.total_amount);
          const marginPct = Number(inv.TotalAmt) > 0
            ? ((margin / Number(inv.TotalAmt)) * 100).toFixed(1)
            : '0.0';

          invoiceMatch = {
            invoice_id: inv.Id,
            invoice_number: inv.DocNumber,
            invoice_total: inv.TotalAmt,
            customer: inv.CustomerRef?.name,
            margin,
            margin_pct: marginPct,
          };
        }
      } catch (invErr) {
        console.warn('Invoice match failed:', invErr.message);
      }
    }

    // Update the expense request with QBO bill ID
    await supabase
      .from('expense_requests')
      .update({
        qbo_bill_id: qboBillId,
        status: 'billed',
        invoice_match: invoiceMatch,
        billed_at: new Date().toISOString(),
      })
      .eq('id', request_id);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        qbo_bill_id: qboBillId,
        invoice_match: invoiceMatch,
      }),
    };
  } catch (err) {
    console.error('expense-request-link-bill error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message || 'Internal server error' }),
    };
  }
};
