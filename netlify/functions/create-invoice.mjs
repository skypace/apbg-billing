import { qboRequest, corsHeaders } from './qbo-helpers.mjs';

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
      customerId, customerName, departmentId, departmentName,
      lineItems, markupPct, jobNumber, billRef,
      accountId, itemId,
    } = payload;

    if (!customerId) return err400('Customer is required');
    if (!lineItems?.length) return err400('At least one line item is required');
    if (markupPct == null || markupPct < 0) return err400('Markup percentage is required');

    // Determine QBO item + income account
    // Default: "Sales" item (388) â Equipment Sales income (32)
    // If service: "Service Provided" (365) â Service Income (35)
    const useItemId = itemId || '388';
    const useAccountId = accountId || '32';

    const multiplier = 1 + (markupPct / 100);

    // Build invoice lines
    const invoiceLines = lineItems.map((item, idx) => {
      const qty = item.quantity || 1;
      const costEach = item.unitCost || 0;
      const markedUpPrice = round(costEach * multiplier);
      const lineAmount = round(qty * markedUpPrice);

      return {
        DetailType: 'SalesItemLineDetail',
        Amount: lineAmount,
        Description: item.description || '',
        SalesItemLineDetail: {
          ItemRef: { value: useItemId },
          Qty: qty,
          UnitPrice: markedUpPrice,
        },
      };
    });

    const invoiceTotal = invoiceLines.reduce((s, l) => s + l.Amount, 0);
    const billTotal = lineItems.reduce((s, li) => s + round((li.quantity || 1) * (li.unitCost || 0)), 0);

    // Build the invoice payload
    const invoicePayload = {
      CustomerRef: { value: customerId },
      Line: invoiceLines,
    };

    // Set department (location) if provided
    if (departmentId) {
      invoicePayload.DepartmentRef = { value: departmentId };
    }

    // Private note with job reference and bill reference
    const notes = [];
    if (jobNumber) notes.push(`Job #${jobNumber}`);
    if (billRef) notes.push(`From Bill #${billRef}`);
    notes.push(`Markup: ${markupPct}%`);
    invoicePayload.PrivateNote = notes.join(' â ');

    // Customer memo (visible on invoice)
    if (jobNumber) {
      invoicePayload.CustomerMemo = { value: `Job #${jobNumber}` };
    }

    // Create the invoice in QBO
    const result = await qboRequest('POST', '/invoice', invoicePayload);
    const createdInvoice = result.Invoice;

    // Calculate margin
    const margin = round(invoiceTotal - billTotal);
    const marginPct = billTotal > 0 ? round((margin / invoiceTotal) * 100) : 0;

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        success: true,
        invoice: {
          id: createdInvoice.Id,
          number: createdInvoice.DocNumber,
          total: invoiceTotal,
          customerName: customerName || createdInvoice.CustomerRef?.name,
          departmentName: departmentName || '',
        },
        margin: {
          billTotal,
          invoiceTotal,
          profit: margin,
          pct: marginPct,
          markup: markupPct,
        },
        message: `Invoice #${createdInvoice.DocNumber || createdInvoice.Id} created for $${invoiceTotal.toFixed(2)} (${markupPct}% markup). Margin: $${margin.toFixed(2)} (${marginPct.toFixed(1)}%)`,
      }),
    };
  } catch (err) {
    console.error('create-invoice error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err.message }),
    };
  }
}

function round(n) { return Math.round(n * 100) / 100; }
function err400(msg) {
  return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: msg }) };
}
