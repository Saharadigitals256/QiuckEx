-- Rollback for: 20260828000000_create_teams_tables.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS teams CASCADE;
DROP TABLE IF EXISTS team_members CASCADE;
DROP TABLE IF EXISTS team_invites CASCADE;
DROP FUNCTION IF EXISTS update_teams_updated_at CASCADE;
