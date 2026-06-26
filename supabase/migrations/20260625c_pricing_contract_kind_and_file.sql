-- Pricing contracts: type (contract vs exclusivity) + an attached document.
-- Applied to live (gfsdpwiqzshhexkofiif) 2026-06-25 via Supabase MCP.

alter table ops.pricing_contracts
  add column if not exists kind text not null default 'contract'
    check (kind in ('contract','exclusivity')),
  add column if not exists contract_file_path text,
  add column if not exists contract_file_name text;

-- Private bucket for signed contract docs; all access via the service-role
-- pricing-admin function (no client RLS so customer logins can't read them).
insert into storage.buckets (id, name, public)
  values ('pricing-contracts', 'pricing-contracts', false)
  on conflict (id) do nothing;
