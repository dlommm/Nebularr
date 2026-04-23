DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'arrapp') THEN
    CREATE ROLE arrapp LOGIN PASSWORD 'arrapp';
  END IF;
END
$$;

ALTER ROLE arrapp SET search_path = app, warehouse, public;
GRANT CREATE ON DATABASE arranalytics TO arrapp;

CREATE SCHEMA IF NOT EXISTS app AUTHORIZATION arrapp;
CREATE SCHEMA IF NOT EXISTS warehouse AUTHORIZATION arrapp;

GRANT USAGE ON SCHEMA app TO arrapp;
GRANT USAGE ON SCHEMA warehouse TO arrapp;
