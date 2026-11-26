SET lock_timeout='5s';
SET statement_timeout='60s';
-- Protected secret loader supplies one verified SCRAM verifier over stdin via
-- psql variables. Run on the intended owner database as the bootstrap operator.
SELECT :'owner' IN ('auth','problem','submission')
    AND current_database()=:'owner' || '_db'
    AND astra_control.target_id()=:'expected_system_id'
    AND :'verifier' ~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$'
    AS target_ok \gset
\if :target_ok
\else
  SELECT 1 / 0;
\endif
BEGIN;
SELECT pg_advisory_xact_lock(17421, 1);
SELECT :'owner' || '_service' AS login, :'owner' || '_runtime' AS runtime \gset
SELECT format('CREATE ROLE %I LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION IN ROLE %I',
              :'login', :'runtime') WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname=:'login') \gexec
SELECT count(*)=1 AS valid FROM pg_roles r WHERE rolname=:'login'
    AND rolcanlogin AND rolinherit AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
    AND (SELECT array_agg(roleid) FROM pg_auth_members WHERE member=r.oid)=ARRAY[(SELECT oid FROM pg_roles WHERE rolname=:'runtime')]
    AND NOT EXISTS (SELECT FROM pg_class WHERE relowner=r.oid)
    AND NOT EXISTS (SELECT FROM pg_database WHERE datdba=r.oid) \gset
\if :valid
  SELECT format('ALTER ROLE %I PASSWORD %L', :'login', :'verifier') \gexec
\else
  SELECT 1 / 0;
\endif
COMMIT;
