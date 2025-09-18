-- Create charts table
CREATE TABLE IF NOT EXISTS charts (
  id VARCHAR(12) PRIMARY KEY,
  edit_token VARCHAR(32) NOT NULL UNIQUE,
  chart_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  view_count INTEGER DEFAULT 0
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_edit_token ON charts(edit_token);
CREATE INDEX IF NOT EXISTS idx_created_at ON charts(created_at DESC);

-- Optional: Add a trigger to auto-update the updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_charts_updated_at BEFORE UPDATE
    ON charts FOR EACH ROW EXECUTE PROCEDURE
    update_updated_at_column();