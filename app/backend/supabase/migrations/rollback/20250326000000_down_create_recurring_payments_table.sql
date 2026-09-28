-- Rollback for: 20250326000000_create_recurring_payments_table.sql
-- Generated automatically by migration verification engine

DROP TABLE IF EXISTS recurring_payment_links CASCADE;
DROP TABLE IF EXISTS recurring_payment_executions CASCADE;
DROP FUNCTION IF EXISTS update_recurring_link_updated_at CASCADE;
DROP FUNCTION IF EXISTS calculate_next_execution_date CASCADE;
DROP FUNCTION IF EXISTS should_execute_recurring_link CASCADE;
