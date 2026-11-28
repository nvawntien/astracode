SELECT (current_database()='submission_db' AND
    (SELECT system_identifier::text FROM pg_control_system())=:'expected_system_id' AND
    :'verifier' ~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$') AS target_ok \gset
\if :target_ok
\else
  SELECT 1/0;
\endif
BEGIN;
SELECT pg_advisory_xact_lock(17421,1);
SELECT 'CREATE ROLE astra_drain_submission LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS'
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='astra_drain_submission') \gexec
SELECT count(*)=1 AS valid FROM pg_roles r WHERE rolname='astra_drain_submission' AND rolcanlogin
    AND NOT (rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND NOT EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid)
    AND NOT EXISTS (SELECT FROM pg_database WHERE datdba=r.oid) \gset
\if :valid
  SELECT format('ALTER ROLE astra_drain_submission PASSWORD %L', :'verifier') \gexec
\else
  SELECT 1/0;
\endif
GRANT CONNECT ON DATABASE submission_db TO astra_drain_submission;
GRANT USAGE ON SCHEMA astra_control TO astra_drain_submission;
GRANT EXECUTE ON FUNCTION astra_control.retained_work() TO astra_drain_submission;
COMMIT;
