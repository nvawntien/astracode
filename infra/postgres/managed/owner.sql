BEGIN;
SELECT pg_advisory_xact_lock(17421, 1);
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO :"owner";
GRANT USAGE ON SCHEMA public TO :"runtime";

-- Only the protected control connection can change an operation marker. A lost
-- advisory-lock session leaves a committed marker intact across a DB restart.
CREATE SCHEMA IF NOT EXISTS astra_control;
REVOKE ALL ON SCHEMA astra_control FROM PUBLIC;
CREATE TABLE IF NOT EXISTS astra_control.migration_fence (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    operation uuid NOT NULL,
    writer name NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
REVOKE ALL ON astra_control.migration_fence FROM PUBLIC;
COMMIT;

-- The bootstrap operator supplies the one protected fencer login by granting
-- membership in astra_fencer. Application and migration Pods never receive it.
BEGIN;
ALTER TABLE astra_control.migration_fence
    ADD COLUMN IF NOT EXISTS deadline timestamptz,
    ADD COLUMN IF NOT EXISTS lease_until timestamptz,
    ADD COLUMN IF NOT EXISTS claimed boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS lock_pid integer,
    ADD COLUMN IF NOT EXISTS lock_start timestamptz;

CREATE OR REPLACE FUNCTION astra_control.prepare(attempt uuid, expires timestamptz, password text)
RETURNS name LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    service text := split_part(current_database(), '_', 1);
    writer name := service || '_m_' || replace(attempt::text, '-', '');
BEGIN
    IF service NOT IN ('auth','problem','submission') OR current_database() <> service || '_db'
       OR expires <= clock_timestamp() OR expires > clock_timestamp() + interval '10 minutes'
       OR password IS NULL OR password !~ '^SCRAM-SHA-256[$]4096:[A-Za-z0-9+/]{22}==[$][A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$' THEN
        RAISE EXCEPTION 'invalid target, deadline or writer credential';
    END IF;
    IF NOT EXISTS (
        SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted
          AND mode='ExclusiveLock' AND classid=17421 AND objid=1 AND objsubid=2
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
    ) THEN RAISE EXCEPTION 'protected preflight session lock required'; END IF;
    INSERT INTO astra_control.migration_fence(operation, writer, deadline, lease_until, lock_pid, lock_start)
        SELECT attempt,writer,expires,least(expires,clock_timestamp()+interval '15 seconds'),pid,backend_start FROM pg_stat_activity WHERE pid=pg_backend_pid();
    EXECUTE format('CREATE ROLE %I LOGIN NOINHERIT NOCREATEDB NOCREATEROLE NOSUPERUSER PASSWORD %L VALID UNTIL %L',
                   writer,password,expires);
    EXECUTE format('GRANT %I TO %I', service || '_owner',writer);
    EXECUTE format('ALTER ROLE %I SET lock_timeout = %L',writer,'3s');
    EXECUTE format('ALTER ROLE %I SET statement_timeout = %L',writer,'60s');
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),writer);
    EXECUTE format('GRANT USAGE ON SCHEMA astra_control TO %I',writer);
    EXECUTE format('GRANT EXECUTE ON FUNCTION astra_control.claim(uuid) TO %I',writer);
    RETURN writer;
END $$;

CREATE OR REPLACE FUNCTION astra_control.claim(attempt uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE astra_control.migration_fence SET claimed = true
        WHERE singleton AND operation = attempt AND writer = session_user
          AND NOT claimed AND deadline > clock_timestamp();
    IF NOT FOUND THEN RAISE EXCEPTION 'missing, expired or already consumed writer fence'; END IF;
    PERFORM astra_control.assert_holder(session_user);
END $$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA astra_control FROM PUBLIC;
GRANT USAGE ON SCHEMA astra_control TO astra_fencer;
GRANT SELECT ON astra_control.migration_fence TO astra_fencer;
GRANT EXECUTE ON FUNCTION astra_control.prepare(uuid,timestamptz,text) TO astra_fencer;
COMMIT;

BEGIN;
-- Queue a deferred check in the same transaction as reviewed DDL. A Goose
-- transaction may stay open after its final DDL statement has finished.
CREATE TABLE IF NOT EXISTS astra_control.commit_checks (writer name NOT NULL);
CREATE OR REPLACE FUNCTION astra_control.assert_holder(login name) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM astra_control.migration_fence f JOIN pg_locks l ON l.pid=f.lock_pid
        JOIN pg_stat_activity a ON a.pid=l.pid AND a.backend_start=f.lock_start
        WHERE f.writer=login AND f.claimed AND least(f.deadline,f.lease_until)>clock_timestamp() AND f.lease_until IS NOT NULL
          AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
          AND l.locktype='advisory' AND l.granted AND l.mode='ExclusiveLock'
          AND l.classid=17421 AND l.objid=1 AND l.objsubid=2
    ) THEN RAISE EXCEPTION 'writer fence lost'; END IF;
END $$;

CREATE OR REPLACE FUNCTION astra_control.check_ddl()
RETURNS event_trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    IF session_user !~ '^(auth|problem|submission)_m_[0-9a-f]{32}$' THEN RETURN; END IF;
    PERFORM astra_control.assert_holder(session_user);
    IF tg_event = 'ddl_command_end' THEN
        INSERT INTO astra_control.commit_checks VALUES (session_user);
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_event_trigger WHERE evtname='astra_ddl_start') THEN
        CREATE EVENT TRIGGER astra_ddl_start ON ddl_command_start EXECUTE FUNCTION astra_control.check_ddl();
        CREATE EVENT TRIGGER astra_ddl_end ON ddl_command_end EXECUTE FUNCTION astra_control.check_ddl();
    END IF;
END $$;
CREATE OR REPLACE FUNCTION astra_control.check_commit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    PERFORM astra_control.assert_holder(NEW.writer);
    DELETE FROM astra_control.commit_checks WHERE writer=NEW.writer;
    RETURN NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_trigger WHERE tgrelid='astra_control.commit_checks'::regclass AND tgname='writer_at_commit') THEN
        CREATE CONSTRAINT TRIGGER writer_at_commit AFTER INSERT ON astra_control.commit_checks
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION astra_control.check_commit();
    END IF;
END $$;

CREATE OR REPLACE FUNCTION astra_control.seal(attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    login name;
BEGIN
    SELECT writer INTO STRICT login FROM astra_control.migration_fence WHERE operation=attempt FOR UPDATE;
    UPDATE astra_control.migration_fence SET deadline=clock_timestamp() WHERE operation=attempt;
    EXECUTE format('ALTER ROLE %I NOLOGIN',login);
    EXECUTE format('REVOKE %I FROM %I',split_part(current_database(),'_',1) || '_owner',login);
    PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=login;
END $$;

CREATE OR REPLACE FUNCTION astra_control.finish(attempt uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    login name;
BEGIN
    SELECT writer INTO STRICT login FROM astra_control.migration_fence WHERE operation=attempt FOR UPDATE;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=login AND rolcanlogin)
      OR EXISTS (SELECT FROM pg_stat_activity WHERE usename=login)
      OR pg_has_role(login,split_part(current_database(),'_',1) || '_owner','MEMBER')
    THEN RAISE EXCEPTION 'writer has not been fenced'; END IF;
    EXECUTE format('REVOKE EXECUTE ON FUNCTION astra_control.claim(uuid) FROM %I',login);
    EXECUTE format('REVOKE USAGE ON SCHEMA astra_control FROM %I',login);
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I',current_database(),login);
    EXECUTE format('DROP ROLE %I',login);
    DELETE FROM astra_control.migration_fence WHERE operation=attempt;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA astra_control FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra_control.seal(uuid),astra_control.finish(uuid) TO astra_fencer;

-- The dedicated drain login can read only aggregate retained-work counts.
\if :{?is_submission}
CREATE OR REPLACE FUNCTION astra_control.retained_work() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,astra_control,pg_temp AS $$
DECLARE attempts bigint; outbox bigint;
BEGIN
  IF to_regclass('public.submission_attempts') IS NULL OR to_regclass('public.outbox_messages') IS NULL THEN
    RAISE EXCEPTION 'submission schema is not available';
  END IF;
  SELECT count(*) INTO attempts FROM public.submission_attempts WHERE status IN ('PENDING','JUDGING');
  SELECT count(*) INTO outbox FROM public.outbox_messages WHERE status <> 'PUBLISHED';
  RETURN jsonb_build_object('attempts',attempts,'outbox',outbox);
END;
$$;
REVOKE ALL ON FUNCTION astra_control.retained_work() FROM PUBLIC;
\endif

COMMIT;

-- The protected verifier invokes this only after checking the complete release
-- history and schema. Grant by object so ledger ownership and writes stay private.
CREATE OR REPLACE FUNCTION astra_control.allow_runtime() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    runtime name := split_part(current_database(),'_',1) || '_runtime';
    rel record;
BEGIN
    FOR rel IN SELECT oid::regclass AS obj, relkind, relname FROM pg_class
               WHERE relnamespace='public'::regnamespace AND relkind IN ('r','S')
    LOOP
        IF rel.relname='goose_db_version' THEN
            EXECUTE format('GRANT SELECT ON %s TO %I',rel.obj,runtime);
        ELSIF rel.relname='goose_db_version_id_seq' THEN
            CONTINUE;
        ELSIF rel.relkind='S' THEN
            EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO %I',rel.obj,runtime);
        ELSE
            EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON %s TO %I',rel.obj,runtime);
        END IF;
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION astra_control.allow_runtime() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra_control.allow_runtime() TO astra_fencer;

CREATE OR REPLACE FUNCTION astra_control.history() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
    history jsonb;
BEGIN
    IF to_regclass('public.goose_db_version') IS NULL THEN RETURN '[]'; END IF;
    SELECT jsonb_agg(jsonb_build_array(version_id,is_applied) ORDER BY id)
        INTO history FROM public.goose_db_version;
    RETURN history;
END $$;
CREATE OR REPLACE FUNCTION astra_control.target_id() RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
    SELECT system_identifier::text FROM pg_control_system()
$$;
REVOKE ALL ON FUNCTION astra_control.history(),astra_control.target_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra_control.history(),astra_control.target_id() TO astra_fencer;

CREATE OR REPLACE FUNCTION astra_control.renew(attempt uuid, valid_until timestamptz) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
    UPDATE astra_control.migration_fence SET lease_until=least(deadline,valid_until)
      WHERE operation=attempt AND lock_pid=pg_backend_pid()
        AND lease_until>clock_timestamp() AND deadline>clock_timestamp()
        AND valid_until>clock_timestamp() AND valid_until<=clock_timestamp()+interval '30 seconds';
    IF NOT FOUND THEN RAISE EXCEPTION 'writer lease expired or session changed'; END IF;
END $$;
REVOKE ALL ON FUNCTION astra_control.renew(uuid,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra_control.renew(uuid,timestamptz) TO astra_fencer;

-- Keep the file identities for the verified prefix and for an interrupted
-- attempt outside the service-owned schema. Only the fenced coordinator
-- records hashes, after validating them against the approved OCI artifact.
CREATE TABLE IF NOT EXISTS astra_control.migration_files (
    filename text PRIMARY KEY,
    sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    operation uuid NOT NULL
);
REVOKE ALL ON astra_control.migration_files FROM PUBLIC;
GRANT SELECT ON astra_control.migration_files TO astra_fencer;
CREATE OR REPLACE FUNCTION astra_control.record_file(attempt uuid, file_name text, file_hash text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
    IF NOT EXISTS (SELECT FROM astra_control.migration_fence WHERE operation=attempt
                   AND lock_pid=pg_backend_pid() AND deadline>clock_timestamp())
       OR file_name !~ '^[0-9]{5}_[a-z0-9_]+[.]sql$' THEN
        RAISE EXCEPTION 'current migration fence required';
    END IF;
    INSERT INTO astra_control.migration_files VALUES (file_name,file_hash,attempt)
    ON CONFLICT (filename) DO NOTHING;
    IF NOT EXISTS (SELECT FROM astra_control.migration_files WHERE filename=file_name AND sha256=file_hash) THEN
        RAISE EXCEPTION 'previous migration file differs';
    END IF;
END $$;
REVOKE ALL ON FUNCTION astra_control.record_file(uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION astra_control.record_file(uuid,text,text) TO astra_fencer;
