-- Migration: Add user email to chart_permissions for display
-- This allows us to show emails instead of cryptic user IDs

-- Add user_email column to chart_permissions
ALTER TABLE chart_permissions
ADD COLUMN IF NOT EXISTS user_email TEXT;

-- Add email to existing permissions (will need to be populated manually or via script)
-- You can run a script to backfill emails from Auth0 if needed
