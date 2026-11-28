-- Canonical catalog of the managed public schema. Fail closed on an object
-- class outside the reviewed SQL profile until its definition is covered.
SET search_path=pg_catalog;
WITH relations AS (
    SELECT * FROM pg_class WHERE relnamespace='public'::regnamespace
), entries AS (
    SELECT jsonb_build_array('relation',relname,relkind,relpersistence,relrowsecurity,
            relforcerowsecurity,relispartition,reloptions,relreplident) AS entry FROM relations
    UNION ALL SELECT jsonb_build_array('column',r.relname,a.attnum,a.attname,
            format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,
            a.attisdropped,c.collname,pg_get_expr(d.adbin,d.adrelid))
        FROM relations r JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum>0
        LEFT JOIN pg_collation c ON c.oid=a.attcollation
        LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
    UNION ALL SELECT jsonb_build_array('constraint',r.relname,c.conname,c.convalidated,pg_get_constraintdef(c.oid))
        FROM relations r JOIN pg_constraint c ON c.conrelid=r.oid
    UNION ALL SELECT jsonb_build_array('index',r.relname,i.indisvalid,i.indisready,pg_get_indexdef(r.oid))
        FROM relations r JOIN pg_index i ON i.indexrelid=r.oid
    UNION ALL SELECT jsonb_build_array('sequence',r.relname,s.seqstart,s.seqincrement,s.seqmin,s.seqmax,s.seqcache,s.seqcycle,
            t.relname,a.attname) FROM relations r JOIN pg_sequence s ON s.seqrelid=r.oid
        LEFT JOIN pg_depend d ON d.classid='pg_class'::regclass AND d.objid=r.oid AND d.deptype IN ('a','i')
        LEFT JOIN relations t ON t.oid=d.refobjid LEFT JOIN pg_attribute a ON a.attrelid=t.oid AND a.attnum=d.refobjsubid
    UNION ALL SELECT jsonb_build_array('trigger',r.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid))
        FROM relations r JOIN pg_trigger t ON t.tgrelid=r.oid WHERE NOT t.tgisinternal
    UNION ALL SELECT jsonb_build_array('rule',r.relname,pg_get_ruledef(w.oid))
        FROM relations r JOIN pg_rewrite w ON w.ev_class=r.oid
    UNION ALL SELECT jsonb_build_array('other',d.classid::regclass::text,pg_describe_object(d.classid,d.objid,d.objsubid))
        FROM pg_depend d WHERE d.refclassid='pg_namespace'::regclass AND d.refobjid='public'::regnamespace
        AND (d.classid NOT IN ('pg_class'::regclass,'pg_constraint'::regclass,'pg_type'::regclass)
            OR d.classid='pg_type'::regclass AND NOT EXISTS (
                SELECT FROM pg_type t JOIN relations r ON t.typrelid=r.oid WHERE t.oid=d.objid))
)
SELECT encode(sha256(convert_to(coalesce(jsonb_agg(entry ORDER BY entry::text COLLATE "C"),'[]')::text,'UTF8')),'hex')
FROM entries;
