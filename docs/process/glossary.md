# AstraCode — Glossary

| Field | Value |
|---|---|
| Document ID | GLOSSARY |
| Version | 0.1 |
| Location | `docs/process/glossary.md` |
| Rule | Definitions only. Rules, thresholds and formulas live in specs (PRD Appendix A until specs exist). Add a term by PR when it first appears in a document or spec. |

## Product structure

| Term | Definition |
|---|---|
| Track | Top-level area of the site: **DSA** (free), **Beyond LeetCode** (premium), **System Design** (premium). Every content item belongs to exactly one track. |
| Roadmap | A visualized graph of learning topics inside a track. A track can have several roadmaps (e.g. OS, Networking). |
| Node | One sub-topic in a roadmap (e.g. Stack, Hash map). |
| Prerequisite | A link from one node to another meaning "learn this first". A node may have several prerequisites. |
| Node content | The three blocks of a node: Reading, Practice, Resources. |
| Reading | Explanatory text for a node, authored by moderators/admins. |
| Practice item | A problem, quiz or design problem linked to a node. One item can be linked to several nodes. |
| Resource | An external link (video, blog) attached to a node. |
| Node completion | State of a node once its reading is marked done and all its practice items are solved. |
| Recommended next node | The node a roadmap suggests the user study next. |

## Content

| Term | Definition |
|---|---|
| Content item | Anything that goes through moderation: coding problem, quiz, design problem, post. |
| Coding problem | A problem solved by writing a program that is judged automatically. |
| Design problem | A System Design problem solved with a whiteboard diagram and written explanation, graded by a moderator. Not judged automatically. |
| Quiz | A multiple-choice question with one correct answer and an explanation. |
| Testcase package | The set of hidden inputs and expected outputs used to judge a coding problem. |
| Reference solution | The author's correct solution to a coding problem, used by the automatic pre-check. |
| Rubric | Grading criteria for a design problem, proposed by the author and finalized by a moderator. |
| Standard mode | Judging mode where the user writes a complete program reading from standard input (current behaviour). |
| Template mode | Judging mode where the user writes a component and hidden driver code supplied by the problem is compiled with it. |
| Banned include | A library a template-mode problem forbids the user to use. |
| Post | A knowledge-sharing article in the discussion area. |
| Comment | A reply on a post; published immediately, can be reported. |
| Premium tag | A discussion tag (e.g. interview, company name) whose posts only premium users can read in full or post under. |
| Teaser | The limited preview (title, short excerpt, structure) shown to users without access to premium content. |

## Moderation

| Term | Definition |
|---|---|
| Eligible user | A user allowed to submit content: meets the verification, activity and pending-limit conditions. |
| Draft | A content item being edited by its author, not yet submitted or returned for changes. |
| Automatic pre-check | System checks run on submission before any moderator sees the item (format, size, reference solution against testcases). |
| Pending | Submitted item waiting in the review queue. |
| Review queue | The list of Pending items in the review console. |
| Review console | The moderator workspace for claiming and deciding on content items. |
| Claim | A moderator taking an item for review so no one else reviews it at the same time. |
| In review | State of an item claimed by a moderator. |
| Changes requested | Moderator decision returning an item to Draft with a comment. |
| Rejected | Final moderator decision with a reason. |
| Published | Approved item visible to users with access to its track. |
| Hidden | Published item withdrawn from view by a moderator. |
| Content laundering | Copying premium content into a free track or public comments. |

## Practice and judging

| Term | Definition |
|---|---|
| Custom run | Running code against user-provided input from the editor; does not count as a submission. |
| Submission | An official attempt to solve a coding problem. |
| Attempt | One judging execution of a submission; a rejudge creates a new attempt. |
| Verdict | The judging result of an attempt (e.g. Accepted, Wrong Answer, Time Limit Exceeded). |
| Accepted | Verdict meaning the submission passed all testcases. |
| Rejudge | Re-running judging for existing submissions, by a moderator/admin. |
| Sandbox | The isolated execution environment where user code runs with resource limits. |
| Problem leaderboard | Ranking of users' best accepted solutions for one problem and language. |
| Percentile | Share of accepted submissions (same problem and language) that a user's submission beats on runtime or memory. |

## Competition and progress

| Term | Definition |
|---|---|
| Contest | A timed event with a fixed set of problems where registered participants are ranked. |
| Registration | Signing up to take part in a contest. |
| Contest window | The period during which contest submissions count. |
| Contest leaderboard | Live ranking of participants during and after a contest. |
| Penalty | Time-based tie-breaker in contest ranking that grows with solve time and wrong attempts. |
| Rating (ELO) | A skill score updated after each rated contest based on rank relative to expectation. |
| Rated participant | A participant whose rating changes after the contest. |
| Flagged participant | A participant who exceeded the tab-switch threshold; finishes the contest but is not rated and is reviewed by a moderator. |
| Tab-switch deterrent | The rule that warns and then flags participants who leave the contest page; a deterrent, not cheating detection. |
| XP | Experience points earned for first-time successes; grows with difficulty. Distinct from rating. |
| Level | A display tier derived from XP. |
| Streak | Number of consecutive active days. |
| Activity heatmap | Calendar grid on the profile showing activity counts per day. |
| Tag histogram | Profile chart of solved problems per tag, most to least. |

## Users and access

| Term | Definition |
|---|---|
| Guest | A visitor who is not signed in. |
| User | A signed-in account with the base role. |
| Role | What actions an account may perform: User, Moderator, Admin. |
| Entitlement | What content an account may access as a learner; currently only Premium. |
| Premium | Time-limited entitlement granting access to premium tracks and premium tags. Simulated, no real payment. |
| Moderator | Staff role that reviews content, grades design submissions, authors roadmaps and schedules contests. |
| Admin | Staff role with all moderator powers plus user, role and premium management and the KPI dashboard. |
| Contributor | **Deprecated** role from v0.1.0 that could author problems; removed, replaced by community contribution. |
| Follow | One-way subscription of one user to another, without approval. |
| Notification | A message to a user about an event relevant to them, shown in-app and for some events by email. |
| Digest | A grouped notification summarizing several events (e.g. number of items waiting for review). |

## AI assistant

| Term | Definition |
|---|---|
| AI assistant | Chat helper for signed-in users that answers briefly and links to AstraCode pages. |
| Corpus | The set of AstraCode content the assistant may use to answer. |
| Grounding | Basing an answer on retrieved corpus content rather than the model's general knowledge. |
| Retrieval | Finding the corpus content relevant to a question. |
| Abstention | The assistant stating it does not know instead of inventing an answer. |
| Guardrail | A control limiting what the assistant may answer (e.g. no solutions, no premium content without access). |
| Prompt injection | Text crafted to make the model ignore its instructions. |

## Business and quality

| Term | Definition |
|---|---|
| KPI | Business metric with a definition and target (PRD §2.4). |
| Launch scenario | The assumed user base used to set KPI targets and workload estimates. |
| NFR | Non-functional requirement: how well the system must do something (`nfr.md`). |
| SLI / SLO / SLA | Measured indicator / internal objective for it / formal commitment to customers. |
| RTO / RPO | Maximum acceptable recovery time / maximum acceptable data loss after a failure. |
| Error budget | Allowed unreliability implied by an SLO (e.g. 0.1% for 99.9%). |

## Architecture and platform (existing system)

| Term | Definition |
|---|---|
| Transactional outbox | Pattern where a database change and the event announcing it are saved in one transaction, then published to Kafka. |
| DLT | Dead-letter topic: where messages go after retries are exhausted. |
| SSE | Server-Sent Events: one-way live updates from server to browser. |
| Idempotency | Processing the same request or event twice has the same effect as once. |
| Feature flag | Switch that hides unfinished features in deployed code. |
| Walking skeleton | Minimal end-to-end deployed version used to prove the delivery pipeline before adding features. |

## Documentation and workflow

| Term | Definition |
|---|---|
| Capability | A coherent area of system behaviour with one OpenSpec spec (e.g. `contest`). Same as an OpenSpec **domain**: one folder under `openspec/specs/`. |
| Business capability | A group of capabilities representing what the business does (e.g. Competition). |
| Spec | `openspec/specs/<capability>/spec.md`: the source of truth for current behaviour, as requirements and scenarios. |
| Requirement / Scenario | A normative behaviour rule (SHALL) / a concrete WHEN–THEN example of it. |
| Change | An OpenSpec change folder: proposal, delta specs, design, tasks. |
| Delta spec | The ADDED / MODIFIED / REMOVED requirements a change applies to a spec. |
| Archive | Merging a finished change's delta specs into the specs. |
| ADR | Architecture Decision Record: one decision with context, options and trade-offs. |
| Gate 1 / Gate 2 | Human review of a change's proposal and specs / of the pull request. |
| ID conventions | `F-xx` feature (PRD) · `UC-xx` use case (FRD) · `NFR-xx` non-functional requirement · `ADR-NNNN` decision · `D-xx` product decision (PRD Appendix B). |
