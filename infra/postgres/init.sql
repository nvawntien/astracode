\getenv auth_password ASTRA_AUTH_DB_PASSWORD
\getenv problem_password ASTRA_PROBLEM_DB_PASSWORD
\getenv submission_password ASTRA_SUBMISSION_DB_PASSWORD

\if :{?auth_password}
CREATE ROLE auth_app LOGIN PASSWORD :'auth_password';
CREATE ROLE problem_app LOGIN PASSWORD :'problem_password';
CREATE ROLE submission_app LOGIN PASSWORD :'submission_password';
CREATE DATABASE auth_db OWNER auth_app;
CREATE DATABASE problem_db OWNER problem_app;
CREATE DATABASE submission_db OWNER submission_app;
REVOKE CONNECT ON DATABASE auth_db, problem_db, submission_db FROM PUBLIC;
\else
CREATE DATABASE auth_db;
CREATE DATABASE problem_db;
CREATE DATABASE submission_db;
\endif
