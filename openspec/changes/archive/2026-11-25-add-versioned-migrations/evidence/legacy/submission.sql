--
-- PostgreSQL database dump
--

-- Dumped from database version 15.6
-- Dumped by pg_dump version 15.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;

--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: outbox_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.outbox_messages (
    id bigint NOT NULL,
    aggregate_id bigint NOT NULL,
    topic character varying(255) NOT NULL,
    payload jsonb NOT NULL,
    status character varying(20) DEFAULT 'PENDING'::character varying NOT NULL,
    created_at timestamp with time zone NOT NULL,
    published_at timestamp with time zone,
    retry_count bigint DEFAULT 0 NOT NULL,
    error_reason text
);

--
-- Name: outbox_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.outbox_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: outbox_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.outbox_messages_id_seq OWNED BY public.outbox_messages.id;

--
-- Name: submission_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_attempts (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    attempt_id character varying(64) NOT NULL,
    trigger_type character varying(40) NOT NULL,
    triggered_by_user_id character varying(100),
    status character varying(30) NOT NULL,
    testcase_version bigint,
    test_count bigint,
    dataset_checksum character varying(128),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

--
-- Name: submission_attempts_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submission_attempts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: submission_attempts_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submission_attempts_id_seq OWNED BY public.submission_attempts.id;

--
-- Name: submission_results; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submission_results (
    id bigint NOT NULL,
    submission_id bigint NOT NULL,
    attempt_id character varying(64),
    test_index bigint NOT NULL,
    status character varying(30) NOT NULL,
    actual_output text,
    input text,
    expected_output text,
    execution_time bigint,
    memory_used bigint,
    created_at timestamp with time zone
);

--
-- Name: submission_results_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submission_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: submission_results_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submission_results_id_seq OWNED BY public.submission_results.id;

--
-- Name: submissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.submissions (
    id bigint NOT NULL,
    problem_id bigint NOT NULL,
    problem_name character varying(500) NOT NULL,
    user_id character varying(100) NOT NULL,
    username character varying(255) NOT NULL,
    language character varying(20) NOT NULL,
    source_code text NOT NULL,
    current_attempt_id character varying(64),
    status character varying(30) NOT NULL,
    execution_time bigint,
    memory_used bigint,
    compile_output text,
    error_message text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

--
-- Name: submissions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.submissions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: submissions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.submissions_id_seq OWNED BY public.submissions.id;

--
-- Name: outbox_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages ALTER COLUMN id SET DEFAULT nextval('public.outbox_messages_id_seq'::regclass);

--
-- Name: submission_attempts id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_attempts ALTER COLUMN id SET DEFAULT nextval('public.submission_attempts_id_seq'::regclass);

--
-- Name: submission_results id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_results ALTER COLUMN id SET DEFAULT nextval('public.submission_results_id_seq'::regclass);

--
-- Name: submissions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions ALTER COLUMN id SET DEFAULT nextval('public.submissions_id_seq'::regclass);

--
-- Name: outbox_messages outbox_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.outbox_messages
    ADD CONSTRAINT outbox_messages_pkey PRIMARY KEY (id);

--
-- Name: submission_attempts submission_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_attempts
    ADD CONSTRAINT submission_attempts_pkey PRIMARY KEY (id);

--
-- Name: submission_results submission_results_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_results
    ADD CONSTRAINT submission_results_pkey PRIMARY KEY (id);

--
-- Name: submissions submissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submissions
    ADD CONSTRAINT submissions_pkey PRIMARY KEY (id);

--
-- Name: idx_outbox_messages_aggregate_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_messages_aggregate_id ON public.outbox_messages USING btree (aggregate_id);

--
-- Name: idx_outbox_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_outbox_messages_status ON public.outbox_messages USING btree (status);

--
-- Name: idx_submission_attempt_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempt_created ON public.submission_attempts USING btree (submission_id, created_at);

--
-- Name: idx_submission_attempt_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempt_lookup ON public.submission_attempts USING btree (submission_id, attempt_id);

--
-- Name: idx_submission_attempts_attempt_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_submission_attempts_attempt_id ON public.submission_attempts USING btree (attempt_id);

--
-- Name: idx_submission_attempts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempts_created_at ON public.submission_attempts USING btree (created_at);

--
-- Name: idx_submission_attempts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempts_status ON public.submission_attempts USING btree (status);

--
-- Name: idx_submission_attempts_submission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempts_submission_id ON public.submission_attempts USING btree (submission_id);

--
-- Name: idx_submission_attempts_trigger_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempts_trigger_type ON public.submission_attempts USING btree (trigger_type);

--
-- Name: idx_submission_attempts_triggered_by_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_attempts_triggered_by_user_id ON public.submission_attempts USING btree (triggered_by_user_id);

--
-- Name: idx_submission_results_attempt_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_results_attempt_id ON public.submission_results USING btree (attempt_id);

--
-- Name: idx_submission_results_submission_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_results_submission_id ON public.submission_results USING btree (submission_id);

--
-- Name: idx_submission_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submission_user_created ON public.submissions USING btree (user_id, created_at);

--
-- Name: idx_submissions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_created_at ON public.submissions USING btree (created_at);

--
-- Name: idx_submissions_current_attempt_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_current_attempt_id ON public.submissions USING btree (current_attempt_id);

--
-- Name: idx_submissions_language; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_language ON public.submissions USING btree (language);

--
-- Name: idx_submissions_problem_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_problem_id ON public.submissions USING btree (problem_id);

--
-- Name: idx_submissions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_status ON public.submissions USING btree (status);

--
-- Name: idx_submissions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_submissions_user_id ON public.submissions USING btree (user_id);

--
-- Name: submission_attempts fk_submission_attempts_submission; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.submission_attempts
    ADD CONSTRAINT fk_submission_attempts_submission FOREIGN KEY (submission_id) REFERENCES public.submissions(id) ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--
