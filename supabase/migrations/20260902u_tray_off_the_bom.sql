-- 20260902u — the 24-pk tray comes off every BOM
--
-- Reconciling the BOM to the vendors' own invoices (20260902s) left one line
-- that could not be justified from any of them: C-TRAY 24 PK SLEEK is on NO
-- Quantum invoice — not 1462, not 1741, not the can bill 171778 — while every
-- other Quantum line on the BOM appears on at least one.  That was flagged
-- rather than guessed at, and the owner's answer is to take it out.
--
-- The likely reading, and the reason removing it is a correction rather than
-- an omission: the tray is inside Quantum's $0.62/can "Basic Fill: Tolling"
-- line, exactly as pack-off turned out to be.  Carrying it separately charged
-- the case for it twice.
--
-- ⚠ If it turns out trays ARE bought separately from somebody, nothing orders
-- them after this — put the line back with that vendor on it, do not re-point
-- it at Quantum, because Quantum has never billed us for one.
--
-- Item 563 is retired in the master, NOT deactivated in QuickBooks: it carries
-- purchase history, and whether a QuickBooks item is live is an accounting
-- decision, not housekeeping (the 20260902 empty-cans lesson).

DELETE FROM ops.product_bom_lines WHERE component_qbo_item_id = '563';

UPDATE ops.production_items
   SET active = FALSE,
       cost_note = 'Retired 2026-09-02: the 24-pk tray appears on no Quantum invoice (1462, 1741, 171778 all checked); it is taken to be inside the $0.62/can tolling line on item 531. Re-activate only with a vendor who actually bills for it.',
       updated_at = now()
 WHERE qbo_item_id = '563';
