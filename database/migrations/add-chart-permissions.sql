-- Migration: Add chart permissions/collaboration system
-- This allows multiple users to edit the same chart

-- Create chart_permissions table to track who can edit each chart
CREATE TABLE IF NOT EXISTS chart_permissions (
  id SERIAL PRIMARY KEY,
  chart_id VARCHAR(12) NOT NULL REFERENCES charts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  permission_level VARCHAR(20) NOT NULL DEFAULT 'edit', -- 'owner' or 'edit'
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  granted_by TEXT, -- user_id of person who granted permission
  UNIQUE(chart_id, user_id)
);

-- Create indexes for faster lookups
CREATE INDEX IF NOT EXISTS idx_chart_permissions_chart_id ON chart_permissions(chart_id);
CREATE INDEX IF NOT EXISTS idx_chart_permissions_user_id ON chart_permissions(user_id);

-- Note:
-- - 'owner' permission: chart creator, can delete chart and manage permissions
-- - 'edit' permission: can edit chart content but not manage permissions
-- - View permission is implicit for everyone with the view link (no DB entry needed)
