-- Pending-invite COUNT/list: (organization_id, status = 'pending').
-- Composite lets those paths skip non-pending rows on long invite histories.

CREATE INDEX IF NOT EXISTS idx_invitation_organization_status
  ON invitation (organization_id, status);
