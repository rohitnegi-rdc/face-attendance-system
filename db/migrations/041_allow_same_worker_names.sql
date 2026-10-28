-- Two workers at one pump may share a name (two Rajus on one crew is normal). Migration 033 made
-- names unique per pump on the guess that a repeated name is one person split in two; that made
-- the operator invent a tell-apart name. The face is the identity and the worker number (#N, shown
-- beside every name) tells same-named workers apart; a real split stays the admin's merge review.
DROP INDEX IF EXISTS persons_pump_name_idx;
