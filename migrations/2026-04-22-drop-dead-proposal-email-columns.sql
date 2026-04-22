-- Phase 3 of the 2026-04-22 proposals dead-column sweep.
-- sent_from: constant value across all rows ('proposals@clients.moonraker.ai'), no reader.
-- email_subject: written by send-proposal-email.js only, no reader.
-- email_body: full HTML body stored per-send, no reader, largest-waste column.
-- Writer (api/send-proposal-email.js) stopped writing these in commit 448013fa3c53.
-- Phase 1 verification (code grep across api/ admin/ _templates/ shared/) found zero
-- live readers. pg_depend check confirmed no views/functions/triggers/constraints
-- reference these columns.
-- sent_at, sent_to, view_count, viewed_at, and notes are intentionally retained
-- (load-bearing for approve-followups.js and displayed in admin UI).

ALTER TABLE public.proposals
  DROP COLUMN sent_from,
  DROP COLUMN email_subject,
  DROP COLUMN email_body;
