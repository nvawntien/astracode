SET lock_timeout='5s';
SET statement_timeout='60s';
-- Run with psql -X -v ON_ERROR_STOP=1 -v expected_system_id=... on postgres.
-- All later connections reuse the operator's protected libpq settings.
SELECT current_database() = 'postgres'
   AND (SELECT system_identifier::text FROM pg_control_system()) = :'expected_system_id'
   AND (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS target_ok \gset
\if :target_ok
\else
  \echo 'Managed bootstrap refused the database, cluster identity or bootstrap role.'
  SELECT 1 / 0;
\endif

-- Serialize initial creation and inspect the whole target before creating roles.
SELECT pg_advisory_lock(17421, 0);
SELECT NOT EXISTS (
  SELECT FROM pg_database d
  WHERE datname IN ('auth_db', 'problem_db', 'submission_db')
    AND shobj_description(d.oid, 'pg_database') IS DISTINCT FROM
        'astracode managed database ' || datname || ' on ' || :'expected_system_id'
) AND NOT EXISTS (
  SELECT FROM pg_roles r
  WHERE rolname IN ('auth_owner','auth_runtime','problem_owner','problem_runtime','submission_owner','submission_runtime','astra_fencer')
    AND (shobj_description(r.oid, 'pg_authid') IS DISTINCT FROM
        'astracode managed role ' || rolname || ' on ' || :'expected_system_id'
        OR rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR EXISTS (SELECT FROM pg_auth_members WHERE member=r.oid))
) AS inventory_ok \gset
\if :inventory_ok
\else
  \echo 'Existing unbound database or role requires reviewed adoption.'
  SELECT 1 / 0;
\endif

BEGIN;
WITH roles AS (
  SELECT service || suffix AS role FROM unnest(ARRAY['auth','problem','submission']) AS service
  CROSS JOIN unnest(ARRAY['_owner','_runtime']) AS suffix
  UNION ALL SELECT 'astra_fencer'
)
SELECT format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
               COMMENT ON ROLE %I IS %L', role, role,
               'astracode managed role ' || role || ' on ' || :'expected_system_id')
FROM roles WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role)
\gexec
COMMIT;

-- CREATE DATABASE is nontransactional. An interruption before its identifying
-- comment leaves an unbound target which requires explicit operator recovery.
WITH databases(name) AS (VALUES ('auth_db'), ('problem_db'), ('submission_db'))
SELECT format('CREATE DATABASE %I', name),
       format('COMMENT ON DATABASE %I IS %L', name,
              'astracode managed database ' || name || ' on ' || :'expected_system_id')
FROM databases WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = name)
\gexec
REVOKE ALL ON DATABASE auth_db, problem_db, submission_db FROM PUBLIC;
GRANT CONNECT ON DATABASE auth_db, problem_db, submission_db TO astra_fencer;
GRANT CONNECT ON DATABASE auth_db TO auth_runtime, auth_owner;
GRANT CONNECT ON DATABASE problem_db TO problem_runtime, problem_owner;
GRANT CONNECT ON DATABASE submission_db TO submission_runtime, submission_owner;
\connect auth_db
\set owner auth_owner
\set runtime auth_runtime
\ir owner.sql
\connect problem_db
\set owner problem_owner
\set runtime problem_runtime
\ir owner.sql
\connect submission_db
\set owner submission_owner
\set runtime submission_runtime
\set is_submission true
\ir owner.sql
