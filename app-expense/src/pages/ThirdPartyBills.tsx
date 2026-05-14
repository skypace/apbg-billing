import { useNavigate } from 'react-router-dom';
import { ArrowLeft, ExternalLink, Mail, FileText, Inbox } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const LOADER_URL = 'https://alamedapointbg.com/billing/approve.html';
const FORWARD_TO = 'bills@alamedapointbg.com';

export default function ThirdPartyBills() {
  const navigate = useNavigate();

  return (
    <div className="space-y-6 pb-4">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => navigate('/')}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h1 className="text-lg font-semibold">3rd Party Bills</h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            Vendor invoices that didn't come out of your pocket. Use the
            Billing Loader instead of filing them as a personal expense.
          </p>
        </div>
      </div>

      {/* Quick-link to the existing 3rd Party Billing Loader */}
      <a
        href={LOADER_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="cta-card"
        style={{ textDecoration: 'none' }}
      >
        <div className="cta-icon-tile">
          <FileText className="h-6 w-6" />
        </div>
        <div className="cta-body">
          <div className="cta-title">Open 3rd Party Billing Loader →</div>
          <div className="cta-desc">
            Review a vendor bill, attach a Job # (Service Fusion / ResQ),
            and post to QBO. The loader matches the bill against the
            invoice and shows margin %.
          </div>
        </div>
        <ExternalLink className="cta-arrow h-5 w-5" />
      </a>

      {/* Email-forward path */}
      <a
        href={`mailto:${FORWARD_TO}`}
        className="cta-card"
        style={{ textDecoration: 'none' }}
      >
        <div className="cta-icon-tile amber">
          <Mail className="h-6 w-6" />
        </div>
        <div className="cta-body">
          <div className="cta-title">Forward a bill by email</div>
          <div className="cta-desc">
            Forward any vendor invoice to{' '}
            <span className="font-mono">{FORWARD_TO}</span> — Claude reads
            the PDF or image and emails an approval link to the bill
            approver.
          </div>
        </div>
        <ExternalLink className="cta-arrow h-5 w-5" />
      </a>

      {/* Explainer */}
      <Card>
        <CardContent className="p-4 space-y-3 text-sm">
          <div className="flex items-start gap-3">
            <Inbox className="h-5 w-5 text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <div className="font-medium text-foreground mb-1">
                When to use the Billing Loader vs. BRIXPENSE
              </div>
              <ul className="text-muted-foreground space-y-1.5 list-disc list-inside">
                <li>
                  <strong className="text-foreground">Billing Loader</strong> — a vendor sent
                  the company an invoice (parts, subcontractor, materials, fuel
                  card statement) and we owe them money. The bill posts as a QBO
                  Bill against AP.
                </li>
                <li>
                  <strong className="text-foreground">BRIXPENSE</strong> — you personally paid
                  for something on your card or in cash and need to be
                  reimbursed, or you need approval before buying.
                </li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
