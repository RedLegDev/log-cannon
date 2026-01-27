-- Add scopes column to api_keys table
-- Default to 'ingest' for backward compatibility with existing keys
ALTER TABLE logs.api_keys ADD COLUMN IF NOT EXISTS scopes String DEFAULT 'ingest';
