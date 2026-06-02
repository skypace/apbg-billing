-- 20260602b_sync_customers_brix.sql
-- Add the Brix warehouse as a third linked customer in the ResQ <-> SF sync.
-- QBO anchor: "BRIX WAREHOUSE EQUIPMENT" (id 1412). Unlike Melt/Starbird this
-- one does NOT have RESQ in its QBO name, but it IS a real SF customer the
-- ResQ warehouse/equipment-storage work orders should sync to.
--
-- sf_customer_name is seeded to the operator-stated SF name ("BRIX BEVERAGE
-- WAREHOUSE"); confirm/adjust the exact SF spelling in sync.html -> Settings.
-- resolveSfCustomerName() self-heals minor drift at job-create time.

insert into ops.sync_customers
  (qbo_customer_id, qbo_customer_name, sf_customer_name, resq_facility_keywords, linked, notes)
values
  ('1412', 'BRIX WAREHOUSE EQUIPMENT', 'BRIX BEVERAGE WAREHOUSE', array['brix','equipment storage','warehouse'], true,
   'Brix warehouse. QBO name has no RESQ; SF name confirmed by operator. Added 2026-06-02.')
on conflict (qbo_customer_id) do update set
  qbo_customer_name      = excluded.qbo_customer_name,
  sf_customer_name       = excluded.sf_customer_name,
  resq_facility_keywords = excluded.resq_facility_keywords,
  linked                 = excluded.linked;
