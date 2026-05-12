-- v0.9.33b — Add Preventative Maintenance product family.
--
-- PM has different margin economics (contract-based, scheduled, predictable
-- revenue) than ad-hoc service labor, so it gets its own product family for
-- margin reporting.
--
-- Auto-match is name-driven only (explicit "PM" in item name). The income
-- account 'PM and Contract Service Income' lumps PM with general contract
-- service work (SVC-CALL, SV-REPAIR01, PROJ-MAN, etc.), so income-account
-- alone isn't a reliable signal.

INSERT INTO ops.product_families (family_code, label, sort_order, is_active) VALUES
  ('pm', 'Preventative Maintenance', 65, true)
ON CONFLICT (family_code) DO UPDATE
  SET label = EXCLUDED.label, sort_order = EXCLUDED.sort_order;

-- Re-classify auto-tagged items whose name explicitly contains "PM" or
-- "PREVENTATIVE MAINTENANCE". Manual edits (set_by NOT LIKE 'auto-match%')
-- are preserved.
UPDATE ops.item_product_families ipf
   SET family_code = 'pm',
       set_by      = 'auto-match v0.9.33 (pm)',
       set_at      = now()
  FROM ops.qbo_items it
 WHERE it.qbo_item_id = ipf.qbo_item_id
   AND it.name ~* '\m(PM|PREVENTATIVE *MAINTENANCE)\M'
   AND ipf.family_code IN ('service','other')
   AND (ipf.set_by LIKE 'auto-match%' OR ipf.set_by IS NULL);
