-- Drop legacy proposals.proposal_content column.
--
-- Applied via Supabase MCP: migration "drop_legacy_proposals_proposal_content_column"
--
-- Background: proposal content historically lived as a JSONB blob on the
-- proposals parent row. The versioning migration introduced the
-- proposal_versions table and added proposals.active_version_id as a
-- pointer to the current version's row. api/generate-proposal.js stopped
-- writing proposals.proposal_content once versioning landed, and the last
-- reader (api/proposal-chat.js's legacy fallback) was removed in commit
-- 9cf3ce0afe28 before this migration ran.
--
-- Pre-flight sanity check run before this migration:
--   SELECT COUNT(*) FILTER (WHERE active_version_id IS NULL) -> 0
--   SELECT COUNT(*) FILTER (WHERE <active_version lookup fails>) -> 0
-- Every proposal has a valid active version row with non-null content.

ALTER TABLE proposals DROP COLUMN IF EXISTS proposal_content;
