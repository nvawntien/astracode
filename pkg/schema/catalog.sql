WITH app_tables AS (
  SELECT r.* FROM pg_class r JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public' AND r.relkind IN ('r', 'p') AND r.relname <> 'goose_db_version'
),
catalog AS (
  SELECT 1 AS rank, r.relname::text AS object, 0 AS position, '' AS name,
    jsonb_build_object('kind', 'table', 'table', r.relname, 'persistence', r.relpersistence,
      'row_security', r.relrowsecurity, 'force_row_security', r.relforcerowsecurity) AS definition
  FROM app_tables r
  UNION ALL
  SELECT 2, r.relname::text, a.attnum, a.attname::text,
    jsonb_build_object('kind', 'column', 'table', r.relname, 'column', a.attname,
      'position', a.attnum, 'type', format_type(a.atttypid, a.atttypmod),
      'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid),
      'identity', a.attidentity, 'generated', a.attgenerated, 'collation', col.collname)
  FROM app_tables r JOIN pg_attribute a ON a.attrelid = r.oid
  LEFT JOIN pg_attrdef d ON d.adrelid = r.oid AND d.adnum = a.attnum
  LEFT JOIN pg_collation col ON col.oid = a.attcollation
  WHERE a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 3, r.relname::text, 0, c.conname::text,
    jsonb_build_object('kind', 'constraint', 'table', r.relname, 'name', c.conname,
      'type', c.contype, 'definition', pg_get_constraintdef(c.oid, false),
      'validated', c.convalidated, 'deferrable', c.condeferrable, 'initially_deferred', c.condeferred)
  FROM app_tables r JOIN pg_constraint c ON c.conrelid = r.oid
  UNION ALL
  SELECT 4, r.relname::text, 0, ix.relname::text,
    jsonb_build_object('kind', 'index', 'table', r.relname, 'name', ix.relname,
      'definition', pg_get_indexdef(ix.oid), 'valid', i.indisvalid, 'ready', i.indisready,
      'unique', i.indisunique, 'primary', i.indisprimary)
  FROM app_tables r JOIN pg_index i ON i.indrelid = r.oid JOIN pg_class ix ON ix.oid = i.indexrelid
  UNION ALL
  SELECT 5, r.relname::text, 0, '',
    jsonb_build_object('kind', 'sequence', 'name', r.relname, 'type', format_type(s.seqtypid, NULL),
      'increment', s.seqincrement, 'start', s.seqstart, 'minimum', s.seqmin, 'maximum', s.seqmax,
      'cache', s.seqcache, 'cycle', s.seqcycle, 'owned_by_table', t.relname, 'owned_by_column', a.attname)
  FROM pg_sequence s JOIN pg_class r ON r.oid = s.seqrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  LEFT JOIN pg_depend dep ON dep.classid = 'pg_class'::regclass AND dep.objid = r.oid
    AND dep.refclassid = 'pg_class'::regclass AND dep.refobjsubid > 0 AND dep.deptype IN ('a', 'i')
  LEFT JOIN pg_class t ON t.oid = dep.refobjid
  LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = dep.refobjsubid
  WHERE n.nspname = 'public' AND t.relname IS DISTINCT FROM 'goose_db_version'
  UNION ALL
  SELECT 6, c.relname::text, 0, '',
    jsonb_build_object('kind', 'unexpected relation', 'name', c.relname, 'relkind', c.relkind)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind NOT IN ('r', 'p', 'i', 'I', 'S')
  UNION ALL
  SELECT 7, p.proname::text, 0, pg_get_function_identity_arguments(p.oid),
    jsonb_build_object('kind', 'unexpected routine', 'name', p.proname,
      'arguments', pg_get_function_identity_arguments(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT 8, t.typname::text, 0, '',
    jsonb_build_object('kind', 'unexpected type', 'name', t.typname)
  FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = 'public' AND t.typrelid = 0 AND t.typelem = 0
  UNION ALL
  SELECT 9, r.relname::text, 0, tr.tgname::text,
    jsonb_build_object('kind', 'unexpected trigger', 'table', r.relname, 'definition', pg_get_triggerdef(tr.oid))
  FROM app_tables r JOIN pg_trigger tr ON tr.tgrelid = r.oid WHERE NOT tr.tgisinternal
)
SELECT definition FROM catalog ORDER BY rank, object COLLATE "C", position, name COLLATE "C";
