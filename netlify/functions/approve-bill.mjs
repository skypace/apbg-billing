import { qboRequest, qboQuery, corsHeaders } from './qbo-helpers.mjs';
import { sendEmail, confirmationEmailHtml, APPROVAL_EMAIL } from './email-helpers.mjs';

export async function handler(event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders(), body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders(), body: JSON.stringify({ error: 'POST only' }) };
  }

  try {
    const payload = JSON.parse(event.body);
    const {
      vendorId, vendorName, customerId, customerName,
      accountId, accountName, jobNumber, billNumber,
      dueDate, memo, lineItems,
    } = payload;

    if (!vendorId) return err400('Vendor is required');
    if (!customerId) return err400('Location/Customer is required');
    if (!accountId) return err400('Account is required');
    if (!jobNumber) return err400('Job number is required');
    if (!lineItems?.length) return err400('At least one line item is required');

    // ── 1. Create the Bill in QBO ──
    const billLines = lineItems.map(item => ({
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: round((item.quantity || 1) * (item.unitCost || 0)),
      Description: item.description || '',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: accountId },
        CustomerRef: { value: customerId },
        BillableStatus: 'NotBillable',
      },
    }));

    const billTotal = lineItems.reduce((s, li) => s + round((li.quantity || 1) * (li.unitCost || 0)), 0);

    const billPayload = {
      VendorRef: { value: vendorId },
      Line: billLines,
      PrivateNote: `Job #${jobNumber}${memo ? ' — ' + memo : ''}`,
    };

    if (billNumber) billPayload.DocNumber = billNumber;
    if (dueDate) billPayload.DueDate = dueDate;

    const billResult = await qboRequest('POST', '/bill', billPayload);
    const createdBill = billResult.Bill;

    // ── 2. Search QBO for matching invoice by job number ──
    // Strategy: Search broadly — pull recent invoices and scan ALL fields
    // including DescriptionOnly lines (where Service Fusion puts job numbers)
    let matchedInvoice = null;
    let invoiceLines = [];
    let invoiceTotal = 0;

    try {
      const jobStr = jobNumber.toString().trim();

      // Build search queries — start with selected customer, then broaden
      // Get invoices from last 6 months across multiple customer groups
      const sixMonthsAgo = new Date();
      sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
      const dateFilter = sixMonthsAgo.toISOString().split('T')[0];

      const searchQueries = [
        // 1. Selected customer first
        `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}' ORDERBY TxnDate DESC MAXRESULTS 200`,
        // 2. ALL recent invoices (broad search)
        `SELECT * FROM Invoice WHERE TxnDate >= '${dateFilter}' ORDERBY TxnDate DESC MAXRESULTS 500`,
      ];

      for (const query of searchQueries) {
        if (matchedInvoice) break;

        try {
          const result = await qboQuery(query);
          const invoices = result.QueryResponse?.Invoice || [];

          for (const inv of invoices) {
            if (invoiceContainsJob(inv, jobStr)) {
              matchedInvoice = inv;
              break;
            }
          }
        } catch (queryErr) {
          console.warn('Invoice search query failed:', queryErr.message);
        }
      }

      // Extract invoice details if matched
      if (matchedInvoice) {
        invoiceTotal = matchedInvoice.TotalAmt || 0;
        invoiceLines = (matchedInvoice.Line || [])
          .filter(l => l.DetailType === 'SalesItemLineDetail')
          .map(l => ({
            description: l.Description || '—',
            amount: l.Amount || 0,
            quantity: l.SalesItemLineDetail?.Qty || 1,
            unitPrice: l.SalesItemLineDetail?.UnitPrice || 0,
          }));
      }
    } catch (searchErr) {
      console.error('Invoice search error:', searchErr.message);
    }

    // ── 3. Calculate margin ──
    const margin = matchedInvoice ? invoiceTotal - billTotal : 0;
    const marginPct = matchedInvoice && invoiceTotal > 0 ? (margin / invoiceTotal) * 100 : 0;

    // ── 4. Send confirmation email (if email configured) ──
    const billInfo = {
      vendorName: vendorName || 'Unknown',
      total: billTotal,
      date: dueDate || new Date().toISOString().split('T')[0],
      accountName: accountName || 'COGS',
      jobNumber,
      locationName: customerName || 'Unknown Location',
      billNumber: createdBill.DocNumber || createdBill.Id,
    };

    const invoiceInfo = matchedInvoice ? {
      number: matchedInvoice.DocNumber || matchedInvoice.Id,
      customerName: matchedInvoice.CustomerRef?.name || customerName,
      total: invoiceTotal,
      lines: invoiceLines,
    } : null;

    if (process.env.SENDGRID_API_KEY || process.env.RESEND_API_KEY) {
      try {
        const emailSubject = matchedInvoice
          ? `✓ Bill Created & Matched — ${vendorName} Job #${jobNumber} — $${margin.toFixed(2)} margin`
          : `⚠ Bill Created — NO MATCHING INVOICE — ${vendorName} Job #${jobNumber}`;

        await sendEmail({
          to: APPROVAL_EMAIL,
          subject: emailSubject,
          html: confirmationEmailHtml({
            bill: billInfo, invoice: invoiceInfo, margin, marginPct, matched: !!matchedInvoice,
          }),
        });
      } catch (e) {
        console.warn('Confirmation email failed (non-fatal):', e.message);
      }
    }

    // ── 5. Return result ──
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        bill: {
          id: createdBill.Id,
          number: createdBill.DocNumber,
          total: billTotal,
        },
        invoiceMatch: matchedInvoice ? {
          id: matchedInvoice.Id,
          number: matchedInvoice.DocNumber,
          customerName: matchedInvoice.CustomerRef?.name,
          total: invoiceTotal,
          margin,
          marginPct: round(marginPct),
        } : null,
        message: matchedInvoice
          ? `Bill created and matched to Invoice #${matchedInvoice.DocNumber || matchedInvoice.Id} (${matchedInvoice.CustomerRef?.name}). Margin: ${marginPct.toFixed(1)}% ($${margin.toFixed(2)})`
          : `Bill created but NO matching invoice found for Job #${jobNumber}. Please invoice this job separately.`,
      }),
    };
  } catch (err) {
    console.error('approve-bill error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}

// ── Search helper: checks ALL fields on an invoice for the job number ──
function invoiceContainsJob(inv, jobStr) {
  // Check DocNumber
  if (inv.DocNumber && inv.DocNumber.includes(jobStr)) return true;
  // Check PrivateNote
  if (inv.PrivateNote && inv.PrivateNote.includes(jobStr)) return true;
  // Check CustomerMemo
  if (inv.CustomerMemo?.value && inv.CustomerMemo.value.includes(jobStr)) return true;
  // Check ALL line items — both SalesItemLineDetail AND DescriptionOnly
  if (inv.Line) {
    for (const line of inv.Line) {
      const desc = line.Description || '';
      if (desc.includes(jobStr)) return true;
    }
  }
  return false;
}

function round(n) { return Math.round(n * 100) / 100; }
function err400(msg) {
  return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
