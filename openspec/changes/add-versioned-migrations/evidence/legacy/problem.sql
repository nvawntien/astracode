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
-- Name: problem_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.problem_tags (
    problem_id bigint NOT NULL,
    tag_id bigint NOT NULL
);

--
-- Name: problems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.problems (
    id bigint NOT NULL,
    title_slug character varying(500) NOT NULL,
    title character varying(500) NOT NULL,
    description text NOT NULL,
    input_format text DEFAULT ''::text NOT NULL,
    output_format text DEFAULT ''::text NOT NULL,
    difficulty character varying(20) NOT NULL,
    examples jsonb DEFAULT '[]'::jsonb NOT NULL,
    constraints jsonb DEFAULT '[]'::jsonb NOT NULL,
    hints jsonb DEFAULT '[]'::jsonb NOT NULL,
    time_limit numeric NOT NULL,
    memory_limit bigint NOT NULL,
    author_id character varying(100) NOT NULL,
    is_hidden boolean DEFAULT true,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);

--
-- Name: problems_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.problems_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: problems_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.problems_id_seq OWNED BY public.problems.id;

--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id bigint NOT NULL,
    name character varying(100) NOT NULL,
    slug character varying(120) NOT NULL,
    description text,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    deleted_at timestamp with time zone
);

--
-- Name: tags_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tags_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;

--
-- Name: test_cases; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.test_cases (
    id bigint NOT NULL,
    problem_id bigint NOT NULL,
    zip_object_key character varying(500) NOT NULL,
    test_count bigint NOT NULL,
    version bigint NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

--
-- Name: test_cases_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.test_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: test_cases_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.test_cases_id_seq OWNED BY public.test_cases.id;

--
-- Name: problems id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problems ALTER COLUMN id SET DEFAULT nextval('public.problems_id_seq'::regclass);

--
-- Name: tags id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);

--
-- Name: test_cases id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases ALTER COLUMN id SET DEFAULT nextval('public.test_cases_id_seq'::regclass);

--
-- Name: problem_tags problem_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT problem_tags_pkey PRIMARY KEY (problem_id, tag_id);

--
-- Name: problems problems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problems
    ADD CONSTRAINT problems_pkey PRIMARY KEY (id);

--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

--
-- Name: test_cases test_cases_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_pkey PRIMARY KEY (id);

--
-- Name: idx_problem_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_problem_tag ON public.problem_tags USING btree (problem_id, tag_id);

--
-- Name: idx_problems_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_problems_author_id ON public.problems USING btree (author_id);

--
-- Name: idx_problems_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_problems_deleted_at ON public.problems USING btree (deleted_at);

--
-- Name: idx_problems_title_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_problems_title_slug ON public.problems USING btree (title_slug);

--
-- Name: idx_tags_deleted_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_deleted_at ON public.tags USING btree (deleted_at);

--
-- Name: idx_tags_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tags_is_active ON public.tags USING btree (is_active);

--
-- Name: idx_tags_slug; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_tags_slug ON public.tags USING btree (slug);

--
-- Name: idx_test_cases_problem_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_test_cases_problem_id ON public.test_cases USING btree (problem_id);

--
-- Name: problem_tags fk_problem_tags_problem; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT fk_problem_tags_problem FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- Name: problem_tags fk_problem_tags_tag; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT fk_problem_tags_tag FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE CASCADE;

--
-- PostgreSQL database dump complete
--
