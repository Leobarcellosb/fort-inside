-- 005_delete_event.sql
-- Deletes an event and all its dependents in a single transaction.
-- SECURITY DEFINER runs as function owner so it can reach auth.users.
-- Callable only from service_role.

CREATE OR REPLACE FUNCTION delete_event_cascade(event_uuid UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  deleted_participants INT;
  deleted_responses INT;
  deleted_prognostics INT;
  deleted_logs INT;
  participant_user_ids UUID[];
BEGIN
  -- Collect user_ids of event participants (for auth.users cleanup).
  SELECT ARRAY_AGG(user_id) INTO participant_user_ids
  FROM participants
  WHERE event_id = event_uuid AND user_id IS NOT NULL;

  DELETE FROM event_logs WHERE event_id = event_uuid;
  GET DIAGNOSTICS deleted_logs = ROW_COUNT;

  DELETE FROM quiz_responses
  WHERE participant_id IN (SELECT id FROM participants WHERE event_id = event_uuid);
  GET DIAGNOSTICS deleted_responses = ROW_COUNT;

  DELETE FROM prognostics
  WHERE participant_id IN (SELECT id FROM participants WHERE event_id = event_uuid);
  GET DIAGNOSTICS deleted_prognostics = ROW_COUNT;

  DELETE FROM participants WHERE event_id = event_uuid;
  GET DIAGNOSTICS deleted_participants = ROW_COUNT;

  -- Delete auth.users ONLY for this event's participants, never admins.
  -- CRITICAL: parens around the OR clause. Without them, AND/OR precedence
  -- makes the OR branch unbound and deletes every non-admin row in auth.users.
  IF participant_user_ids IS NOT NULL THEN
    DELETE FROM auth.users
    WHERE id = ANY(participant_user_ids)
      AND (
        raw_app_meta_data->>'role' IS NULL
        OR raw_app_meta_data->>'role' != 'admin'
      );
  END IF;

  DELETE FROM events WHERE id = event_uuid;

  RETURN json_build_object(
    'deleted_logs', deleted_logs,
    'deleted_responses', deleted_responses,
    'deleted_prognostics', deleted_prognostics,
    'deleted_participants', deleted_participants,
    'deleted_users', COALESCE(ARRAY_LENGTH(participant_user_ids, 1), 0)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_event_cascade TO service_role;
