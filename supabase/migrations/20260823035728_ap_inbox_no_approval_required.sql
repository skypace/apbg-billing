-- Emailed bills do not need an approval step (Sky, 2026-08-23).
--
-- 20260823034356 turned the gate on; this turns it off, which is the shipped
-- default. Routing is unaffected and still does the work that was asked for:
-- the bill is owned by, notified to, and visible to the right person. It just
-- lands `approved` — the SAME auto-approve every other Brixpense expense gets
-- on submit — so it is immediately postable from that person's "Previous
-- Expenses" instead of waiting on a click only they were going to make.
--
-- Nothing about the QuickBooks gate changes: posting is still an explicit
-- human "Post to QuickBooks" click (the 2026-08-14 rule). Set this back to
-- true to require an approval before that button lights up.

update ops.expense_settings
   set value = value || jsonb_build_object('require_approval', false)
 where key = 'ap_inbox';
