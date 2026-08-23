-- AP inbox routing: an emailed bill lands in a person's approval queue, and
-- cannot post to QuickBooks until they approve it.
--
-- The ladder lives in netlify/functions/lib/ap-inbox.mjs resolveBillRouting();
-- these are the knobs it reads. Merged into the existing ap_inbox value so an
-- edit made in the app since 20260823024339 is preserved.
--
-- default_approver is deliberately left NULL. The floor of the ladder is
-- "hold it in the AP Inbox for a human to assign", which is the honest
-- behaviour until somebody decides who owns unattributed vendor mail —
-- inventing an approver here would silently make one person responsible for
-- every invoice a stranger sends us.

update ops.expense_settings
   set value = value || jsonb_build_object(
     'require_approval',     true,
     'sender_routes',        coalesce(value -> 'sender_routes',        '{}'::jsonb),
     'vendor_routes',        coalesce(value -> 'vendor_routes',        '{}'::jsonb),
     'department_approvers', coalesce(value -> 'department_approvers', '{}'::jsonb),
     'default_approver',     coalesce(value -> 'default_approver',     'null'::jsonb)
   )
 where key = 'ap_inbox';
