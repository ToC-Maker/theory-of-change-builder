-- Migration: Add user authentication support (backward compatible)
-- Run this in your Neon database console

-- Add user_id column to charts table (nullable - existing charts remain anonymous)
ALTER TABLE charts
ADD COLUMN IF NOT EXISTS user_id TEXT DEFAULT NULL;

-- Create index for faster user chart lookups (only for authenticated charts)
CREATE INDEX IF NOT EXISTS idx_charts_user_id ON charts(user_id) WHERE user_id IS NOT NULL;

-- Create user_token_usage table to track tokens per user
CREATE TABLE IF NOT EXISTS user_token_usage (
  user_id TEXT PRIMARY KEY,
  total_tokens_used INTEGER DEFAULT 0,
  last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add chart_title column for easier listing (nullable - extracted from chart_data when needed)
ALTER TABLE charts
ADD COLUMN IF NOT EXISTS chart_title TEXT DEFAULT NULL;

-- Note: Existing charts will have user_id = NULL and will continue to work as anonymous charts
-- New charts created by logged-in users will have user_id populated
-- Anonymous users can still create charts exactly as before
