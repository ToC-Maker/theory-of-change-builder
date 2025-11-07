-- Migration: Add link sharing settings to charts
-- Allows charts to be shared publicly with different access levels

-- Add link_sharing_level column to charts table
ALTER TABLE charts
ADD COLUMN IF NOT EXISTS link_sharing_level VARCHAR(20) DEFAULT 'restricted';

-- Valid values: 'restricted', 'viewer', 'editor'
-- 'restricted': Only people with explicit permissions can access
-- 'viewer': Anyone with the link can view (not implemented for view-only yet)
-- 'editor': Anyone with the edit link can edit

-- Add comment to explain the column
COMMENT ON COLUMN charts.link_sharing_level IS
'Link sharing level: restricted (invite only), viewer (anyone can view), editor (anyone with edit link can edit)';

-- Create index for faster lookups by sharing level
CREATE INDEX IF NOT EXISTS idx_charts_link_sharing_level ON charts(link_sharing_level);
