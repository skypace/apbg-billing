-- 2026-09-02  Two purchase orders, not three: cans and trays belong to Quantum.
--
-- The BOM lines for the printed can body and the 24-pk tray were vendored to
-- Craft Beverage Packaging Solutions (1753).  PO generation groups by whatever
-- vendor is on the line, so a run produced THREE materials POs instead of the
-- two the process actually has.  Craft's own billing history says the same
-- thing: every Craft line is a monthly period charge ("May 2025 hours log",
-- "Oct 20th-31st", "Dec-25"), i.e. labour, never a can or a tray.  Quantum's
-- lines are where the can units appear ("Deposit - 202,000 units @ $0.31",
-- "Cream soda cans").  So the vendor moves; nothing about the components does.
--
-- Six of the seven BOMs also had no can line at all, because their can items
-- are deactivated in QuickBooks.  A BOM missing the single largest packaging
-- component under-states the Quantum PO by ~$6/case, so the lines go on;
-- whether those can designs are current is answered by the pre-flight check
-- in the companion migration, not by leaving the line off.

BEGIN;

-- 1. Trays: Craft -> Quantum, on every BOM that carries one.
UPDATE ops.product_bom_lines
   SET preferred_qbo_vendor_id = '1744'
 WHERE component_qbo_item_id = '563'
   AND preferred_qbo_vendor_id IS DISTINCT FROM '1744';

-- 2. Can bodies: Craft -> Quantum (only Olde Fountain Creme has one today).
UPDATE ops.product_bom_lines
   SET preferred_qbo_vendor_id = '1744'
 WHERE component_qbo_item_id IN ('685','686','687','688','689','690','691')
   AND preferred_qbo_vendor_id IS DISTINCT FROM '1744';

-- 3. The six missing can lines.  Mapped from the BOM's GALLON item, which is
--    unambiguous, rather than from the BOM name -- the same discipline the
--    ingredient seed used.
WITH gallon_to_can(gallon_item, can_item) AS (
  VALUES ('524','685'),  -- Hangar 25 Cola
         ('525','691'),  -- Hangar 25 Diet Cola
         ('526','686'),  -- Cable Car Lemon Lime
         ('527','689'),  -- Oaktown Root Beer
         ('528','690'),  -- Golden Gate Orange
         ('529','688'),  -- Lost Island Ginger Beer
         ('530','687')   -- Olde Fountain Creme (already present)
),
target AS (
  SELECT l.bom_id, m.can_item
    FROM ops.product_bom_lines l
    JOIN gallon_to_can m ON m.gallon_item = l.component_qbo_item_id
   WHERE l.line_type = 'component'
)
INSERT INTO ops.product_bom_lines
  (bom_id, line_type, component_qbo_item_id, qty_per, qty_uom,
   preferred_qbo_vendor_id, notes, sort_order, source)
SELECT t.bom_id, 'component', t.can_item, 24, 'each',
       '1744', 'Printed 12 oz sleek can body', 140, 'manual'
  FROM target t
 WHERE NOT EXISTS (
   SELECT 1 FROM ops.product_bom_lines x
    WHERE x.bom_id = t.bom_id AND x.component_qbo_item_id = t.can_item
 );

COMMIT;
