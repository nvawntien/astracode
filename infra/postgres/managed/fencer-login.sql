-- The infrastructure operator connects to the already-bound PostgreSQL instance.
SELECT (current_database()='postgres' AND
    (SELECT system_identifier::text FROM pg_control_system())=:'expected_system_id' AND
    :'verifier' ~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$') AS target_ok \gset
\if :target_ok
\else
  SELECT 1/0;
\endif
BEGIN;
SELECT pg_advisory_xact_lock(17421,0);
SELECT 'CREATE ROLE astra_fence_service LOGIN INHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER NOREPLICATION NOBYPASSRLS IN ROLE astra_fencer'
    WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='astra_fence_service') \gexec
SELECT count(*)=1 AS valid FROM pg_roles r WHERE rolname='astra_fence_service'
    AND rolcanlogin AND rolinherit AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND (SELECT array_agg(roleid) FROM pg_auth_members WHERE member=r.oid)=ARRAY[(SELECT oid FROM pg_roles WHERE rolname='astra_fencer')]
    AND NOT EXISTS (SELECT FROM pg_database WHERE datdba=r.oid) \gset
\if :valid
  SELECT format('ALTER ROLE astra_fence_service PASSWORD %L', :'verifier') \gexec
\else
  SELECT 1/0;
\endif
COMMIT;
