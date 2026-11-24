-- +goose Up
CREATE TABLE public.problem_tags (
    problem_id bigint NOT NULL,
    tag_id bigint NOT NULL
);

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

CREATE SEQUENCE public.problems_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.problems_id_seq OWNED BY public.problems.id;

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

CREATE SEQUENCE public.tags_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.tags_id_seq OWNED BY public.tags.id;

CREATE TABLE public.test_cases (
    id bigint NOT NULL,
    problem_id bigint NOT NULL,
    zip_object_key character varying(500) NOT NULL,
    test_count bigint NOT NULL,
    version bigint NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

CREATE SEQUENCE public.test_cases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

ALTER SEQUENCE public.test_cases_id_seq OWNED BY public.test_cases.id;

ALTER TABLE ONLY public.problems ALTER COLUMN id SET DEFAULT nextval('public.problems_id_seq'::regclass);

ALTER TABLE ONLY public.tags ALTER COLUMN id SET DEFAULT nextval('public.tags_id_seq'::regclass);

ALTER TABLE ONLY public.test_cases ALTER COLUMN id SET DEFAULT nextval('public.test_cases_id_seq'::regclass);

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT problem_tags_pkey PRIMARY KEY (problem_id, tag_id);

ALTER TABLE ONLY public.problems
    ADD CONSTRAINT problems_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.test_cases
    ADD CONSTRAINT test_cases_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX idx_problem_tag ON public.problem_tags USING btree (problem_id, tag_id);

CREATE INDEX idx_problems_author_id ON public.problems USING btree (author_id);

CREATE INDEX idx_problems_deleted_at ON public.problems USING btree (deleted_at);

CREATE UNIQUE INDEX idx_problems_title_slug ON public.problems USING btree (title_slug);

CREATE INDEX idx_tags_deleted_at ON public.tags USING btree (deleted_at);

CREATE INDEX idx_tags_is_active ON public.tags USING btree (is_active);

CREATE UNIQUE INDEX idx_tags_slug ON public.tags USING btree (slug);

CREATE UNIQUE INDEX idx_test_cases_problem_id ON public.test_cases USING btree (problem_id);

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT fk_problem_tags_problem FOREIGN KEY (problem_id) REFERENCES public.problems(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE ONLY public.problem_tags
    ADD CONSTRAINT fk_problem_tags_tag FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON UPDATE CASCADE ON DELETE CASCADE;
