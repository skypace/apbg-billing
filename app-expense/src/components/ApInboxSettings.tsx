import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AlertTriangle, ChevronDown, ChevronRight, Loader2, Save } from 'lucide-react';

// The AP inbox's configuration, editable.
//
// Every one of these knobs already existed and was already honoured by
// bill-email-process-background's routing ladder — the `settings` action on
// bills-inbox.mjs has accepted them since the routing work shipped. What was
// missing was any way to SET them short of hand-writing a POST, which meant
// the two levers that decide who owns an emailed bill (default_approver and
// sender_routes) were effectively frozen at their seeded values.
//
// It lives here rather than in Settings because the config and its
// consequences belong on one screen: you can see the queue it produces
// directly below. Collapsed by default — the queue is the page, this is the
// bit you touch a few times a year.

export interface ApInboxSettingsValue {
  enabled: boolean;
  inbox: string;
  notify: string[];
  allow_senders: string[];
  block_senders: string[];
  ack_sender: boolean;
  require_approval: boolean;
  default_approver: string | null;
  sender_routes: Record<string, string>;
}

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);
const joinList = (a: string[] | undefined) => (a ?? []).join(', ');

/** "someone@x.com -> owner@y.com" per line, which is how a routing override
 *  reads out loud. A map editor with add/remove rows would be more clicks for
 *  a thing that is edited rarely and mostly by pasting. */
function parseRoutes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [from, to] = line.split(/->|=>|:/).map((x) => (x || '').trim().toLowerCase());
    if (from && to) out[from] = to;
  }
  return out;
}
const formatRoutes = (r: Record<string, string> | undefined) =>
  Object.entries(r ?? {}).map(([k, v]) => `${k} -> ${v}`).join('\n');

export function ApInboxSettings({
  value, onSave,
}: {
  value: ApInboxSettingsValue;
  onSave: (next: ApInboxSettingsValue) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ApInboxSettingsValue>(value);
  const [notify, setNotify] = useState(joinList(value.notify));
  const [allow, setAllow] = useState(joinList(value.allow_senders));
  const [block, setBlock] = useState(joinList(value.block_senders));
  const [routes, setRoutes] = useState(formatRoutes(value.sender_routes));
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ApInboxSettingsValue>(k: K, v: ApInboxSettingsValue[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...draft,
        notify: splitList(notify),
        allow_senders: splitList(allow),
        block_senders: splitList(block),
        sender_routes: parseRoutes(routes),
        default_approver: (draft.default_approver || '').trim().toLowerCase() || null,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2 p-4 text-left"
        >
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          <span className="text-sm font-semibold">Inbox settings</span>
          <span className="text-[11px] text-muted-foreground truncate">
            {draft.enabled ? 'On' : 'Off'} · {draft.inbox}
            {draft.require_approval ? ' · approval required' : ' · no approval'}
            {draft.default_approver ? ` · unassigned → ${draft.default_approver}` : ' · unassigned held for triage'}
          </span>
        </button>

        {open && (
          <div className="px-4 pb-4 space-y-4 text-sm">
            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Inbox address</Label>
                <Input
                  value={draft.inbox}
                  onChange={(e) => set('inbox', e.target.value)}
                  placeholder="bills@alamedapointbg.com"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Must be on alamedapointbg.com — that is the domain with inbound mail enabled.
                </p>
              </div>
              <div>
                <Label>Who to notify</Label>
                <Input
                  value={notify}
                  onChange={(e) => { setNotify(e.target.value); setSaved(false); }}
                  placeholder="ap@…, finance@…"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Gets every drafted bill and every one we could not read.
                </p>
              </div>
            </div>

            <div className="grid sm:grid-cols-2 gap-3">
              <div>
                <Label>Allowed senders</Label>
                <Input
                  value={allow}
                  onChange={(e) => { setAllow(e.target.value); setSaved(false); }}
                  placeholder="leave empty to accept anyone"
                />
                <p className="text-[11px] text-muted-foreground mt-1">
                  Empty means vendors can invoice us directly. That is safe because nothing
                  posts to QuickBooks without a human — the worst a stranger achieves is a row
                  in this queue.
                </p>
              </div>
              <div>
                <Label>Blocked senders</Label>
                <Input
                  value={block}
                  onChange={(e) => { setBlock(e.target.value); setSaved(false); }}
                  placeholder="noreply@…, a domain to ignore"
                />
              </div>
            </div>

            <div>
              <Label>Owner for mail nobody matches</Label>
              <Input
                value={draft.default_approver ?? ''}
                onChange={(e) => set('default_approver', e.target.value)}
                placeholder="leave empty — held here for triage"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Empty on purpose. Naming someone here makes them responsible for every invoice a
                stranger sends us; a visible pile in this queue beats a wrong owner.
              </p>
            </div>

            <div>
              <Label>Sender overrides</Label>
              <textarea
                className="w-full rounded-lg bg-white/[0.04] border border-white/10 px-3 py-2 text-sm font-mono min-h-[80px]"
                value={routes}
                onChange={(e) => { setRoutes(e.target.value); setSaved(false); }}
                placeholder={'joel@brixbev.com -> ap@brixbev.com\nacme.com -> service@brixbev.com'}
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                One per line, <span className="font-mono">from -&gt; owner</span>. This is the lever that
                buys real separation of duties: without an override, a bill forwarded by a member of
                staff is owned — and posted — by that same person.
              </p>
            </div>

            <div className="space-y-2">
              {([
                ['enabled', 'Process bills sent to this address',
                 'Off means mail is still recorded, but nothing is read or drafted.'],
                ['ack_sender', 'Reply to the sender confirming we got it',
                 'A receipt confirmation only — never an approval or a payment.'],
                ['require_approval', 'Require an approval before a bill can be posted',
                 'Off (the default) lands an owned bill ready to post. On sends it to the owner’s approvals queue first — the same machinery, one more click.'],
              ] as [keyof ApInboxSettingsValue, string, string][]).map(([k, label, hint]) => (
                <label key={String(k)} className="flex items-start gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={!!draft[k]}
                    onChange={(e) => set(k, e.target.checked as never)}
                  />
                  <span>
                    {label}
                    <span className="block text-[11px] text-muted-foreground">{hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {!draft.require_approval && (
              <div className="text-[12px] text-amber-200/90 bg-amber-500/10 rounded px-3 py-2 flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0" />
                <span>
                  With approval off there is no second pair of eyes on an emailed bill — whoever
                  forwarded it posts it. Sender overrides above, or turning approval on, are the two
                  ways to change that, and neither needs a deploy.
                </span>
              </div>
            )}

            {error && (
              <div className="text-[12px] text-red-300 bg-red-500/10 rounded px-3 py-2">{error}</div>
            )}

            <div className="flex items-center gap-2">
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Save className="h-4 w-4 mr-1.5" />}
                Save settings
              </Button>
              {saved && <span className="text-[12px] text-emerald-300">Saved.</span>}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
