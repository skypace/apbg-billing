import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

export function Spinner() {
  return (
    <div className="loading-fallback">
      <div className="spinner" />
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <div className="err-note">Something went wrong: {message}</div>;
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return <div className="empty-note">{children}</div>;
}

export function AmberCallout({ children }: { children: ReactNode }) {
  return (
    <div className="callout callout-amber" role="status">
      <AlertTriangle size={18} />
      <div>{children}</div>
    </div>
  );
}

type ChipTone = 'success' | 'warning' | 'info' | 'danger' | 'neutral';

export function Chip({ tone, children }: { tone: ChipTone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>;
}

export function TransferStatusChip({ status }: { status: string }) {
  switch (status) {
    case 'in_transit':
      return <Chip tone="info">In transit</Chip>;
    case 'received':
      return <Chip tone="success">Received</Chip>;
    case 'draft':
      return <Chip tone="neutral">Draft</Chip>;
    case 'void':
      return <Chip tone="danger">Void</Chip>;
    default:
      return <Chip tone="neutral">{status}</Chip>;
  }
}

export function OrderStatusChip({ status }: { status: string }) {
  switch (status) {
    case 'submitted':
      return <Chip tone="info">Submitted</Chip>;
    case 'fulfilled':
      return <Chip tone="success">Fulfilled</Chip>;
    case 'cancelled':
      return <Chip tone="neutral">Cancelled</Chip>;
    default:
      return <Chip tone="neutral">{status}</Chip>;
  }
}

export function AgreementStatusChip({ status }: { status: string }) {
  switch (status) {
    case 'sent':
      return <Chip tone="warning">Awaiting signature</Chip>;
    case 'signed':
      return <Chip tone="success">Signed</Chip>;
    case 'expired':
      return <Chip tone="danger">Expired</Chip>;
    case 'void':
      return <Chip tone="danger">Void</Chip>;
    default:
      return <Chip tone="neutral">{status}</Chip>;
  }
}

export function InvoiceStatusChip({ status, balance }: { status: string | null; balance: number | null }) {
  const open = balance !== null && Number(balance) > 0;
  if (status === 'paid' || (!open && balance !== null)) {
    return <Chip tone="success">Paid</Chip>;
  }
  if (open) return <Chip tone="warning">Open</Chip>;
  return <Chip tone="neutral">{status ?? '—'}</Chip>;
}
