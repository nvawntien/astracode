-- +goose Up
CREATE TABLE public.users (
    id uuid NOT NULL,
    full_name character varying(255),
    username character varying(100) NOT NULL,
    email character varying(255) NOT NULL,
    password text NOT NULL,
    role character varying(20) DEFAULT 'user'::character varying,
    rating bigint DEFAULT 0,
    is_active boolean DEFAULT false,
    is_suspended boolean DEFAULT false,
    avatar_url character varying(500),
    avatar_object_key text,
    bio character varying(500),
    country character varying(100),
    school character varying(255),
    company character varying(255),
    github_url character varying(500),
    website_url character varying(500),
    linkedin_url character varying(500),
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);

CREATE UNIQUE INDEX idx_users_email ON public.users USING btree (email);

CREATE UNIQUE INDEX idx_users_username ON public.users USING btree (username);
