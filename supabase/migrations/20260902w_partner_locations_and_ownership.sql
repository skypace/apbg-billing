-- Inventory: one location per partner, and ownership stops being a kind of building.
--
-- Sky, on finding Desert Beverage and Origins each entered twice:
--   "DESERTBEV and DESERT-BEVERAGE can be merged, it is a warehouse and a
--    distributor. not sure how that gets managed. same with origins."
--
-- ⚠ THE REASON "BOTH" HAD NOWHERE TO LIVE: `inventory_locations.kind` was
-- answering two unrelated questions at once —
--   1. what sort of place is this?  (a building, a truck, a virtual counter)
--   2. does the stock in it still count as ours?
-- Origins is a building AND a distributor. Those are not in conflict; they are
-- answers to different questions, and only the first one is about the place.
--
-- OWNERSHIP IS A COMMERCIAL FACT, and it already exists in the data:
-- `ops.sub_distributors.model` ('consignment' | 'sell_in'). On CONSIGNMENT the
-- stock is still ours until the partner sells it — which is precisely why
-- QuickBooks keeps counting it in qty_on_hand — so it belongs in the drift
-- comparison. On SELL-IN they own it the moment it ships, QuickBooks drops it,
-- and it must stop counting. Deriving from the model means that flip happens by
-- itself; a boolean copied onto the location would be a second home for one
-- fact and would drift from it the first time somebody changed one.
--
-- ⚠ IT FAILS CLOSED. A distributor location with no partner record, or one
-- whose model is anything but consignment, does NOT count as ours. Get this
-- backwards and the failure is silent: over-counting inflates our side, which
-- CANCELS real drift and shows green. Under-counting shows as drift, which is
-- amber on the screen and someone goes and looks. Only one of those is safe.

-- ── 1. The merge ────────────────────────────────────────────────────────────
-- Nothing to move: both rows had 0 movements, 0 transfers, were no partner's
-- site, no item's default receiving location, and on no work order or PO —
-- verified before writing this. So it is a retire, not a data migration.
-- Deactivated rather than deleted; a location id is the kind of thing an old
-- document points at.
UPDATE ops.inventory_locations
   SET is_active = false,
       notes = COALESCE(NULLIF(btrim(notes), '') || E'\n', '')
             || 'Retired 2026-09-02: duplicate of ' || CASE code
                  WHEN 'DESERT-BEVERAGE'    THEN 'DESERTBEV'
                  WHEN 'ORIGINS-CRAFT-SODA' THEN 'ORIGINS'
                END
             || ', which is the row wired to the sub-distributor record. Same partner, '
             || 'entered twice in 2026-05 as a warehouse and again in 2026-08 as a distributor. '
             || 'They are both — the place is a warehouse, the relationship is distribution — and '
             || 'whether their stock counts as ours is now derived from the partner''s model, not '
             || 'from the kind of location.',
       updated_at = now()
 WHERE code IN ('DESERT-BEVERAGE', 'ORIGINS-CRAFT-SODA');

-- A partner code is read by humans off a settlement and a BOL.
UPDATE ops.sub_distributors
   SET code = 'NATURALWAVE', name = 'Natural Wave Beverage', updated_at = now()
 WHERE code = 'NATUTALWAVE';

-- ── 2. Locations, with the two questions separated ──────────────────────────
-- Read this instead of the table wherever the answer to either question
-- matters. Writes still go to ops.inventory_locations; a view cannot drift
-- from what it derives.
CREATE OR REPLACE VIEW ops.v_inventory_locations AS
SELECT l.*,
       -- Is this a real place stock can physically sit? The other two kinds are
       -- accounting fictions: TRANSIT is the gap between two docks, ADJUSTMENT
       -- is the counterweight that keeps the ledger double-sided.
       (l.kind NOT IN ('in_transit', 'adjustment'))                    AS is_physical,
       -- Does stock here still belong to us? Our own buildings always; a
       -- partner's only while the agreement is consignment.
       (l.kind = 'warehouse'
        OR (l.kind IN ('distributor', 'customer_consigned')
            AND sd.model = 'consignment'))                             AS counts_as_our_stock,
       sd.code   AS partner_code,
       sd.name   AS partner_name,
       sd.model  AS partner_model
  FROM ops.inventory_locations l
  LEFT JOIN ops.sub_distributors sd ON sd.inventory_location_id = l.id;

GRANT SELECT ON ops.v_inventory_locations TO authenticated;

-- ── 3. Drift, measured against everything that is ours ──────────────────────
-- ⚠ DROP + CREATE, not CREATE OR REPLACE: Postgres refuses to insert a column
-- into the middle of an existing view's column list (42P16), and brix_qty gains
-- two siblings here. The dependent status view has to go first and is rebuilt
-- in section 4; both GRANTs are restated because a drop takes them with it.
DROP VIEW IF EXISTS ops.v_inventory_ledger_status;
DROP VIEW IF EXISTS ops.v_inventory_drift;

-- `brix_qty` is now OUR STOCK WHEREVER IT SITS, not "stock in a warehouse-kind
-- row", which is what made a consignment shipment read as a shortfall. The two
-- halves are broken out so a screen can say where it is rather than only how
-- much there is.
CREATE VIEW ops.v_inventory_drift AS
WITH brix AS (
  SELECT v.qbo_item_id,
         sum(CASE WHEN l.counts_as_our_stock                       THEN v.on_hand ELSE 0::numeric END) AS ours_total,
         sum(CASE WHEN l.kind = 'warehouse'                        THEN v.on_hand ELSE 0::numeric END) AS warehouse_only,
         sum(CASE WHEN l.counts_as_our_stock
                   AND l.kind <> 'warehouse'                       THEN v.on_hand ELSE 0::numeric END) AS consigned,
         sum(CASE WHEN l.kind = 'in_transit'                       THEN v.on_hand ELSE 0::numeric END) AS in_transit,
         sum(CASE WHEN l.kind = 'adjustment'                       THEN v.on_hand ELSE 0::numeric END) AS adjustment_offset,
         sum(v.on_hand)                                                                                AS all_locations
    FROM ops.v_inventory_on_hand v
    JOIN ops.v_inventory_locations l ON l.id = v.location_id
   GROUP BY v.qbo_item_id
)
SELECT it.qbo_item_id,
       COALESCE(it.name, it.fully_qualified_name)                       AS item_name,
       it.type                                                          AS item_type,
       COALESCE(it.active, true)                                        AS active,
       COALESCE(it.qty_on_hand, 0::numeric)                             AS qbo_qty,
       COALESCE(b.ours_total, 0::numeric)                               AS brix_qty,
       COALESCE(b.warehouse_only, 0::numeric)                           AS brix_warehouse_only,
       COALESCE(b.consigned, 0::numeric)                                AS brix_consigned,
       COALESCE(b.in_transit, 0::numeric)                               AS brix_in_transit,
       COALESCE(b.adjustment_offset, 0::numeric)                        AS brix_adjustment_offset,
       COALESCE(it.qty_on_hand, 0::numeric)
         - COALESCE(b.ours_total, 0::numeric)                           AS drift,
       COALESCE(s.track_locations, false)                               AS track_locations,
       COALESCE(s.is_managed, false)                                    AS is_managed,
       COALESCE(s.category_override, it.category_path, 'Uncategorized') AS category_resolved
  FROM ops.qbo_items it
  LEFT JOIN brix b                   ON b.qbo_item_id = it.qbo_item_id
  LEFT JOIN ops.inventory_settings s ON s.qbo_item_id = it.qbo_item_id
 WHERE COALESCE(it.active, true)
   AND COALESCE(it.type, '') <> ALL (ARRAY['Category', 'Group']);

GRANT SELECT ON ops.v_inventory_drift TO authenticated;

-- ── 4. The one-line answer, now saying where the stock is ───────────────────
CREATE VIEW ops.v_inventory_ledger_status AS
SELECT (SELECT count(*) FROM ops.inventory_movements)                       AS movement_count,
       (SELECT max(occurred_at) FROM ops.inventory_movements)               AS last_movement_at,
       (SELECT count(*) FROM ops.v_inventory_drift
         WHERE track_locations AND drift <> 0)                              AS items_drifting,
       (SELECT COALESCE(sum(abs(drift)), 0) FROM ops.v_inventory_drift
         WHERE track_locations)                                             AS abs_drift,
       (SELECT COALESCE(sum(v.on_hand), 0) FROM ops.v_inventory_on_hand v
          JOIN ops.inventory_locations l ON l.id = v.location_id
         WHERE l.kind IN ('co_packer', 'in_transit'))                       AS qty_away_from_warehouse,
       (SELECT COALESCE(sum(v.on_hand), 0) FROM ops.v_inventory_on_hand v
          JOIN ops.v_inventory_locations l ON l.id = v.location_id
         WHERE l.counts_as_our_stock AND l.kind <> 'warehouse')             AS qty_on_consignment;

GRANT SELECT ON ops.v_inventory_ledger_status TO authenticated;
