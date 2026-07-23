-- CLI package version on the session row (schema: session.cliVersion).
-- Written by Better Auth session.additionalFields + CLI POST /update-session
-- after device login / on throttled CLI heartbeats. Displayed on
-- /account/profile sessions without re-parsing user_agent.

ALTER TABLE session ADD COLUMN cli_version TEXT;
