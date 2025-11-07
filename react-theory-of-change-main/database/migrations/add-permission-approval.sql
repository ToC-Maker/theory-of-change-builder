-- Migration: Add approval workflow for permissions
-- Allows owners to approve or reject access requests

-- Add status column to chart_permissions table
ALTER TABLE chart_permissions
ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'approved';

-- Valid values: 'pending', 'approved', 'rejected'
-- 'pending': User has requested access but not yet approved by owner
-- 'approved': User has been granted access (default for existing permissions)
-- 'rejected': User's access request was denied

-- Add comment to explain the column
COMMENT ON COLUMN chart_permissions.status IS
'Permission status: pending (awaiting approval), approved (active), rejected (denied)';

-- Create index for faster lookups by status
CREATE INDEX IF NOT EXISTS idx_chart_permissions_status ON chart_permissions(status);

-- Create index for finding pending requests by chart
CREATE INDEX IF NOT EXISTS idx_chart_permissions_chart_status ON chart_permissions(chart_id, status);
