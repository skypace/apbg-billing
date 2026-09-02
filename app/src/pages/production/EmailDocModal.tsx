import { useEffect, useState } from 'react';
import { Mail, X as XIcon } from 'lucide-react';
import { DocRef, DocSend, emailDoc, fetchDocSends } from '../../lib/productionDocs';
import { useToast } from '../../lib/toast';
import { btnPrimary, btnSecondary, inp } from '../../lib/styles';

function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }
const split = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Email a production document (PO / BOL / batching sheet) as a PDF attachment.
 * Shows what has already been sent for the same document first, because the
 * usual reason to open this twice is "did that go out?", not "send it again".
 */
export function EmailDocModal({ ref, title, defaultTo = [], onClose }: {
  ref: DocRef;
  title: string;
  defaultTo?: string[];
  onClose: () => void;
}) {
  const [to, setTo] = useState(defaultTo.join(', '));
  const [cc, setCc] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [history, setHistory] = useState<DocSend[] | null>(null);
  const toast = useToast();

  useEffect(() => {
    let alive = true;
    fetchDocSends(ref).then((h) => { if (alive) setHistory(h); }).catch(() => { if (alive) setHistory([]); });
    return () => { alive = false; };
  }, [ref.kind, ref.id, ref.wo_id]); // eslint-disable-line react-hooks/exhaustive-deps

  async function send() {
    const toList = split(to);
    if (!toList.length) { toast.error('Add at least one recipient'); return; }
    setSending(true);
    try {
      const s = await emailDoc(ref, { to: toList, cc: split(cc), message: message.trim() || undefined });
      toast.success('Sent to ' + s.recipients.join(', '));
      onClose();
    } catch (e) { toast.error(errMsg(e)); }
    finally { setSending(false); }
  }

  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: 'var(--sf)', border: '1px solid var(--bd)', borderRadius: 6,
        maxWidth: 560, width: '100%', maxHeight: '88vh', overflowY: 'auto', padding: 18,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Mail size={14} style={{ color: 'var(--ac)' }} />
            <strong style={{ fontSize: 13 }}>Email {title}</strong>
          </div>
          <button onClick={onClose} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--mt)' }}>
            <XIcon size={16} />
          </button>
        </div>

        {history && history.length > 0 && (
          <div style={{ marginBottom: 12, padding: 9, borderRadius: 4, background: 'rgba(255,255,255,0.03)', fontSize: 10.5, lineHeight: 1.6 }}>
            <div style={{ fontSize: 9.5, color: 'var(--mt)', letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 }}>Already sent</div>
            {history.slice(0, 5).map((h) => (
              <div key={h.id} style={{ color: h.status === 'sent' ? 'var(--tx)' : 'var(--rd)' }}>
                {new Date(h.sent_at).toLocaleString()} → {h.recipients.join(', ')}
                {h.cc.length ? ' (cc ' + h.cc.join(', ') + ')' : ''}
                {h.status === 'failed' ? ' — failed: ' + (h.error ?? '') : ''}
                {h.sent_by_email ? <span style={{ color: 'var(--mt)' }}> · by {h.sent_by_email}</span> : null}
              </div>
            ))}
          </div>
        )}

        <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>To</label>
        <input style={{ ...inp(), marginBottom: 8 }} value={to} onChange={(e) => setTo(e.target.value)}
          placeholder="name@vendor.com, second@vendor.com" autoFocus />
        <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Cc (optional)</label>
        <input style={{ ...inp(), marginBottom: 8 }} value={cc} onChange={(e) => setCc(e.target.value)} placeholder="service@brixbev.com" />
        <label style={{ fontSize: 10.5, color: 'var(--mt)' }}>Note to the recipient (optional)</label>
        <textarea style={{ ...inp(), minHeight: 70, resize: 'vertical', marginBottom: 10 }} value={message}
          onChange={(e) => setMessage(e.target.value)} placeholder="Anything they should know that is not on the document." />

        <div style={{ fontSize: 10.5, color: 'var(--mt)', lineHeight: 1.6, marginBottom: 12 }}>
          The PDF goes as an attachment and a copy of exactly what was sent is kept, so the record survives
          later price or address changes. Replies go to the company email on the document.
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button style={btnSecondary()} onClick={onClose} disabled={sending}>Cancel</button>
          <button style={btnPrimary()} onClick={send} disabled={sending}>{sending ? 'Sending…' : 'Send'}</button>
        </div>
      </div>
    </div>
  );
}
