UPDATE notification_events
SET state = 'sent', updated_at = now()
WHERE state IN ('delivered', 'read');

ALTER TABLE notification_events
  DROP CONSTRAINT IF EXISTS notification_events_state_check;

ALTER TABLE notification_events
  ADD CONSTRAINT notification_events_state_check
  CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'suppressed'));
