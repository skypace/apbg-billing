-- 20260818d — short labels for the one-page TV board.
--
-- A 65-inch 1080p screen is 56.7 x 31.9 inches. At the 1:200 legibility rule a
-- 28px label has a 0.59-inch cap height, which reads from about ten feet — and
-- 30 notices on one screen leaves roughly 640 x 94 px per cell, i.e. two lines.
-- Full official titles run past 90 characters, so the board needs its own label.
-- Falls back to title when null. Applied live 2026-08-18.

alter table ops.compliance_postings add column if not exists short_title text;

comment on column ops.compliance_postings.short_title is
  'Short label for the one-page TV board, where a 65-inch screen only affords about two lines at readable size. Falls back to title when null.';

-- The per-row labels were applied live against the titles seeded in 20260818a.
