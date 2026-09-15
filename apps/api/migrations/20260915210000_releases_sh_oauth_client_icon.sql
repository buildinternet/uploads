-- Backfill the official releases-sh client icon. Prod already has the row
-- from 20260915200000 (issue #984), so INSERT OR IGNORE on that seed will
-- not write icon. Fresh installs get the URL from the seed INSERT; this
-- UPDATE is a no-op when the column is already that URL.
UPDATE oauth_client
SET icon = 'https://releases.sh/icon.svg'
WHERE client_id = 'releases-sh';
