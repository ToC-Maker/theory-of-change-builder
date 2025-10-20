-- Migration: Add token tracking to existing charts table
-- Run this on your existing database

ALTER TABLE charts ADD COLUMN IF NOT EXISTS total_tokens_used INTEGER DEFAULT 0;
