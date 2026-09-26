-- Rollback for: 20260331000000_create_jobs_table.sql
-- Generated automatically by migration verification engine

DROP VIEW IF EXISTS dead_letter_queue CASCADE;
DROP TABLE IF EXISTS jobs CASCADE;
