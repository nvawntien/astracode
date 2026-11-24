# AstraCode — Product Requirements Document (PRD)

| Field | Value |
|---|---|
| Document ID | PRD |
| Version | 0.7 (draft for team review) |
| Status | Draft |
| Owner | Orchestrator (product owner) |
| Location | `docs/product/prd.md` |
| Related | `frd.md` (capabilities, use cases) · `nfr.md` (quality targets) · `delivery-plan.md` (delivery order) · `../process/glossary.md` · `../architecture/canvas.md` |

> **Scope of this document.** This PRD answers *why* we build, *for whom*, and *what* is in or out of scope.
> It does **not** define exact behaviour rules (→ OpenSpec specs), quality targets (→ `nfr.md`) or technical
> design (→ `docs/architecture/`, ADRs). Items marked **[to confirm]** still need a team decision.

---

## Part 1 — Business context (BRD)

### 1.1 Problem statement

Our organization needs to **turn AstraCode from a competitive-programming judge into a complete interview-preparation
and practice platform**, because learners today split their preparation across several products — a judge for
coding problems, separate sites for quizzes, learning roadmaps, contests, interview-experience sharing and
system-design practice — and lose time, motivation and continuity switching between them.

Primary users are **CS students and job seekers preparing for technical interviews and competitive programming**,
plus the **community members and moderators** who create and curate the content.

Expected business outcome: **one platform where a user can learn a topic, practise it, compete, track progress and
share knowledge**, with content that grows through moderated community contributions, and a premium tier that funds
advanced material.

### 1.2 Stakeholders

| Stakeholder | Interest |
|---|---|
| Learners (free) | Practise problems and quizzes, follow roadmaps, join contests, see progress |
| Learners (premium) | Advanced tracks (Beyond LeetCode, System Design) and premium discussion |
| Community contributors (any eligible user) | Publish problems, quizzes and posts; gain recognition |
| Moderators | Keep content quality and safety; grade system-design submissions |
| Admins / platform operator | Platform health, cost, business KPIs, user management |
| Course lecturer (grader) | Business-to-technical traceability, documentation system, team workflow with coding agents, production-readiness of the cloud application |

### 1.3 Constraints

- **Team:** 6 members; work is agent-assisted following `docs/process/workflow.md`.
- **Brownfield:** we extend the existing AstraCode v0.1.0 codebase.
- **Cloud:** deployment target is **Microsoft Azure**.
- **Budget:** 5 student Azure subscriptions with about **$100 credit each**; credits cannot be pooled across subscriptions. An LLM API must be usable within budget.
- **Payments:** no real payment processing; premium is simulated.
- **Delivery approach:** core features first; the platform runs on Azure from the start rather than being deployed after features are built.
- **Course focus:** documentation, business→technical translation, workflow and production concerns (security, CI/CD, observability, reliability, cost, AI evaluation) are weighted above feature completeness.

---

## Part 2 — Product definition

### 2.1 Vision and structure

AstraCode is organised in three **tracks**:

| Track | Access | Content |
|---|---|---|
| **DSA** | Free | Coding problems, quizzes, roadmaps, contests |
| **Beyond LeetCode** | Premium | Coding problems (OS, networking, computer architecture, low-level design, company-tagged interview questions), quizzes, one roadmap per topic |
| **System Design** | Premium | Whiteboard design problems graded by moderators (no code), quizzes, roadmaps |

Shared across tracks: profiles, follow, discussion, notifications, gamification (XP, ELO, streaks) and an
**AI assistant** that answers short questions and links users to the right page.

Terms used throughout this document — track, roadmap, node, node content (reading, practice, resources), role,
entitlement — are defined in `glossary.md`.

### 2.2 Goals

| ID | Goal |
|---|---|
| G-1 | Users can complete the full learning loop in one product: learn (roadmap) → practise (problems/quizzes) → compete (contests) → track progress (profile). |
| G-2 | Content grows through community contributions while every published item passes moderation, without spam or premium content leaking to free users. |
| G-3 | Users stay engaged through visible progress and timely feedback: XP, ELO, streaks, leaderboards, notifications. |
| G-4 | Users find relevant content quickly via the AI assistant, with answers grounded in AstraCode's own content. |
| G-5 | The operator can see how the business performs (KPIs in §2.4) and how the system performs (SLOs in `nfr.md`). |
| G-6 | The platform runs on Azure within budget, with production-grade delivery, security and observability. |

### 2.3 Non-goals

- Real payment processing, invoicing or refunds.
- Activity feed of followed users.
- Big-O / complexity analysis of user code (percentiles use **measured** runtime and memory).
- Code-similarity plagiarism detection, AI-generated-code detection and multi-account detection in contests (only the tab-switch deterrent in F-22).
- Native mobile apps (responsive web only).
- A separate data warehouse (KPIs come from existing data).

### 2.4 Business KPIs

What the operator needs to know to improve the business. Targets are **hypotheses for an assumed launch scenario**,
to be validated once real usage exists. Measurement design lives in
`docs/architecture/reliability-observability.md`.

**Launch scenario:** 2,000 registered users after the first month, ~300 daily active users,
weekly contests with up to 200 participants. The workload model (`docs/architecture/workload-capacity.md`) uses the
same scenario.

| KPI | Definition | Target | Goal |
|---|---|---|---|
| Active users | DAU ÷ MAU (users with ≥1 meaningful action) | ≥ 20% | G-1, G-3 |
| New signups | Verified registrations per week | ≥ 300/week in month 1 | G-1 |
| Practice volume | Submissions + quiz answers per DAU per day, per track | ≥ 2 | G-1 |
| Acceptance rate | Accepted submissions ÷ total submissions | Monitor only | G-1 |
| Contest participation | Registrants per contest ÷ WAU | ≥ 10% | G-3 |
| D7 retention | % of new users active again 7 days after signup | ≥ 20% | G-3 |
| Content review time | Median time from Pending to moderator decision | ≤ 48 h | G-2 |
| Pre-check effectiveness | Broken submissions stopped by the auto pre-check ÷ all broken submissions | ≥ 30% | G-2 |
| Premium conversion | Monthly active users converting to premium (simulated) | ≥ 3% | G-5 |
| Roadmap progress | New users completing ≥1 node in their first week | ≥ 30% | G-1 |
| AI assistant usefulness (once F-19 is delivered) | Answers rated helpful; abstention rate | ≥ 70%; 5–20% | G-4 |

### 2.5 Users, roles and entitlements

| Actor | Kind | Can do |
|---|---|---|
| Guest | — | Browse the public DSA catalog, roadmaps, published public posts and premium teasers. **Cannot use the AI assistant.** |
| User | Role | Solve problems and quizzes, join contests, follow users, post, comment, like, use the AI assistant; **submit content per §2.6 if eligible** |
| Premium | Entitlement on a User | Access Beyond LeetCode and System Design tracks and premium discussion tags; submit content to premium tracks if eligible |
| Moderator | Role (staff) | Review console: claim, approve, request changes, reject, hide; override tags/difficulty; grade design submissions; author roadmaps, readings and template-mode problems; schedule contests. **Read access to all content, including premium, for review purposes.** May also use the platform as a learner. |
| Admin | Role (staff) | Everything a Moderator can do + user/role management, premium grants, KPI dashboard |

Rules:
- **Role ≠ entitlement.** Moderators do not need premium; premium users gain no moderation powers.
- **Conflict of interest:** a moderator or admin who authored or scheduled a contest cannot be a rated participant in it.
- **Contributor role removed.** Existing contributor accounts become Users and keep ownership of their drafts.
- Free users see premium tracks **visible but locked** (titles, roadmap structure, teasers).

### 2.6 Community contribution model

| Track | Who can submit | What |
|---|---|---|
| DSA | Any eligible user | Coding problems (standard mode), quizzes |
| Beyond LeetCode | Eligible premium users | Coding problems (standard mode), quizzes |
| System Design | Eligible premium users | Design problems (prompt, reference answer, proposed rubric), quizzes |
| Any track | Moderators/admins only | Template-mode problems, roadmaps, readings |

- **Eligible** = verified email + minimum activity + limit on pending items.
- Users can submit only to tracks they can access.
- A premium user whose premium lapses keeps published content and drafts but cannot submit to premium tracks until renewed.
- Every submission is **automatically pre-checked** (broken submissions never reach moderators), then **reviewed by a moderator**, who approves, requests changes or rejects with a reason. The author is notified of every outcome. The detailed flows are use cases UC-01 (submission) and UC-08 (moderator review) in `frd.md`.

### 2.7 Current baseline (AstraCode v0.1.0)

Already implemented (source: repository README and `docs/codebase/*`; verified during baseline specs):

- Registration, email verification, password reset/change, logout and logout-all; account suspension.
- Public problem catalog with search, filters, tags, difficulty and limits; structured statements.
- Browser editor, custom runs, official submissions with live status, verdict detail and history; C++, Go, Python, Java.
- Asynchronous judging; rejudge.
- Contributor drafts with testcase packages; Moderator/Admin publish, hide and tag management.
- Public profiles, user search, solved/attempted totals, verdict and language distribution, 365-day activity heatmap.
- Automated build, release and production deployment with rollback.

---

## Part 3 — Features

Priority: **Must** = required for the final demo · **Should** = after Musts are demoable · **Could** = stretch.
Status: **Existing** (maintained) · **Modified** · **New**.
Acceptance criteria here are **outcome-level**; exact rules are defined in OpenSpec specs (Appendix A until then),
quality requirements in `nfr.md`.

### Summary

| ID | Feature | Module | Priority | Status |
|---|---|---|---|---|
| F-01 | Accounts and identity | M1 Core practice | Existing | Existing |
| F-02 | Problem catalog, IDE, run and submit | M1 Core practice | Existing | Existing |
| F-03 | Community content submission and moderation | M1 Core practice | Must | Modified |
| F-04 | Per-problem leaderboard and percentile | M1 Core practice | Should | New |
| F-05 | Template judge mode | M1 Core practice | Could | New |
| F-06 | Quizzes | M2 Quizzes | Must | New |
| F-07 | XP and levels | M3 Gamification | Should | New |
| F-08 | Streaks | M3 Gamification | Could | New |
| F-09 | Weekly contests and live leaderboard | M4 Contests | Must | New |
| F-10 | ELO rating | M4 Contests | Must | New |
| F-22 | Contest tab-switch deterrent | M4 Contests | Could | New |
| F-11 | Extended profile and statistics | M5 Profile & social | Should | Modified |
| F-12 | Follow users | M5 Profile & social | Should | New |
| F-21 | Notifications | M5 Profile & social | Must (core events) | New |
| F-13 | Discussion: blog posts | M6 Discussion | Should | New |
| F-14 | Premium discussion tags | M6 Discussion | Should | New |
| F-15 | Learning roadmaps | M7 Roadmaps | Must (DSA track first) | New |
| F-16 | Premium membership (simulated) | M8 Premium | Must (minimal, with Beyond LeetCode pilot content) | New |
| F-17 | Beyond LeetCode track | M8 Premium | Could | New |
| F-18 | System Design track | M8 Premium | Could | New |
| F-19 | AI navigation and learning assistant | M9 Platform intelligence | Should (minimal; first Should) | New |
| F-20 | Admin business KPI dashboard | M9 Platform intelligence | Must (minimal) | New |

**Core scope rationale:** each Must feature exercises at least one graded concern — business/workload (contests,
KPIs), data and event-driven integration (moderation, quizzes, contests, notifications, roadmap progress), security
(moderation of untrusted content, premium entitlement) and load and reliability (contests). The Must set closes the
learning loop of G-1 for free users and protects premium content from the start (D-15, D-17).

The AI assistant (F-19) is the **first Should**: its preparation (provider decision, `ai.md`, evaluation set) runs
alongside the Musts, and its implementation starts once the Musts are demoable (D-16).

---

### M1 — Core practice

#### F-01 Accounts and identity — *Existing*
Maintained as implemented. Changes: removal of the Contributor role; premium entitlement.

#### F-02 Problem catalog, IDE, run and submit — *Existing*
Maintained as implemented. Tracks, premium gating, leaderboard and XP are added by other features.

#### F-03 Community content submission and moderation — *Must · Modified*
Implements the contribution model in §2.6 for problems and quizzes (posts follow F-13; design problems follow F-18).

- *As an eligible user, I want to submit a problem with statement, tags, proposed difficulty, testcases and a reference solution to a track I can access.*
- *As an author, I want broken submissions caught automatically, and I want to see the moderator's reason or requested changes.*
- *As a moderator, I want a review console with a queue I can claim from, so that I approve, request changes, reject or hide content efficiently.*

Acceptance (outcome):
- Content becomes visible only after moderator approval, and only to users with access to its track.
- Submissions that fail the automatic pre-check never reach the moderator queue.
- Users cannot submit to tracks they cannot access, when not eligible, or beyond the pending-item limit.
- The Contributor role no longer exists.

#### F-04 Per-problem leaderboard and percentile — *Should · New*
- *As a user, I want to see the fastest accepted solutions for a problem and who wrote them.*
- *As a user, I want to know how my accepted solution's runtime and memory compare with others'.*

Acceptance (outcome):
- Each problem shows a leaderboard of accepted solutions ranked by measured performance, separated by language.
- After an accepted submission, the user sees their runtime and memory percentile.

#### F-05 Template judge mode — *Could · New*
Needed for low-level-design problems in Beyond LeetCode (e.g. implement a queue or a variant type), where the user
implements a component and a hidden driver tests it.

Acceptance (outcome):
- Problems can be authored in standard mode (full program — current behaviour) or template mode.
- Template-mode problems can forbid specific library includes and are authored by moderators/admins only.
- Concurrency problems are offered only if technically feasible **[to confirm]**, and their results are presented as best-effort.

---

### M2 — Quizzes

#### F-06 Quizzes — *Must · New*
- *As a user, I want to browse quizzes by track, tag and difficulty and answer multiple-choice questions.*
- *As a user, I want to see the explanation after answering.*
- *As an eligible user, I want to submit quizzes through the same moderation flow as problems.*

Acceptance (outcome):
- Users can answer quizzes in tracks they can access and see whether they were correct, with an explanation.
- Quizzes follow the contribution model in §2.6.

---

### M3 — Gamification

#### F-07 XP and levels — *Should · New*
- *As a user, I want to earn more XP for harder problems and quizzes, so that my effort is visible.*

Acceptance (outcome):
- Solving a problem or quiz for the first time awards XP that grows with difficulty.
- XP is distinct from ELO and is shown on the profile with a level.

#### F-08 Streaks — *Could · New*
- *As a user, I want to see my current and longest streak of active days.*

Acceptance (outcome):
- The profile shows current and longest streak, based on daily activity.

---

### M4 — Contests

#### F-09 Weekly contests and live leaderboard — *Must · New*
- *As a user, I want to register for a weekly contest and solve its problems within the time window.*
- *As a participant, I want a live leaderboard ranked by problems solved and solve time.*
- *As a moderator, I want to schedule contests and choose their problems.*

Acceptance (outcome):
- Participants submit during the contest window and see their verdicts and the leaderboard update during the contest.
- After the contest, its problems become practice problems and the contest remains viewable.

#### F-10 ELO rating — *Must · New*
- *As a user, I want my rating to change after each contest based on my rank.*

Acceptance (outcome):
- Ratings are updated once per contest after it ends.
- Higher rank yields a larger gain; the same rank yields a smaller gain for higher-rated users.
- Authors/schedulers of a contest and flagged participants (F-22) are not rated in it.
- Rating history is visible on the profile.

#### F-22 Contest tab-switch deterrent — *Could · New*
A simple deterrent, **not** cheating detection: it can be bypassed (second device) and can produce false positives.

- *As a participant, I want to know the tab-switch rule before the contest starts.*
- *As a moderator, I want flagged participants listed for review after the contest.*

Acceptance (outcome):
- The rule is shown before the contest starts.
- Participants are warned on early switches; past the threshold they can finish, but their result is unrated and flagged for moderator review.

---

### M5 — Profile, social and notifications

#### F-11 Extended profile and statistics — *Should · Modified*
- *As a user, I want my profile to show my activity heatmap (problems, quizzes, contests per day), ELO and rating history, XP and level, recent submissions, most-solved tags and solved counts by difficulty.*
- *As a user, I want to view other users' profiles.*

Acceptance (outcome):
- Heatmap cells show per-day counts on hover; colour intensity grows with activity.
- Tag histogram is sorted from most to least solved.
- Profiles are public.

#### F-12 Follow users — *Should · New*
- *As a user, I want to follow other users and see my followers and who I follow.*

Acceptance (outcome):
- Following is one-way and needs no approval.
- Profiles show follower and following lists. No activity feed (non-goal).

#### F-21 Notifications — *Must (core events) · New*
- *As a user, I want to be notified when something relevant to me happens, without being spammed.*
- *As a moderator, I want to know when content is waiting for review.*

| Event | Recipient | Channel | Priority |
|---|---|---|---|
| Problem/quiz approved, changes requested or rejected (with reason/comment) | Author | In-app | Must |
| Post approved, changes requested or rejected; someone liked or commented on your post | Author | In-app | Should (with F-13) |
| Someone followed you | Followed user | In-app | Should (with F-12) |
| Registered contest starts soon | Registrant | In-app + email | Must |
| Content waiting for review | Moderators | In-app digest (counts) | Must |
| New post by someone you follow | Followers of the author | In-app | Should |
| Premium granted / about to expire | User | In-app + email | Should |
| Design submission graded (score + feedback) | Author | In-app | Could (with F-18) |

Acceptance (outcome):
- In-app notifications appear while the user is on the site, with an unread count.
- Users can mute notification types (Should).

---

### M6 — Discussion

#### F-13 Discussion: blog posts — *Should · New*
- *As a user, I want to publish knowledge-sharing posts with tags, and like and comment on others' posts.*
- *As a moderator, I want to approve posts before they are public and remove reported comments.*

Acceptance (outcome):
- Posts are visible to others only after approval.
- Comments are published immediately and can be reported and removed.

#### F-14 Premium discussion tags — *Should · New*
- *As a premium user, I want to read and share interview experiences under premium-only tags (e.g. interview, company tags).*

Acceptance (outcome):
- Only premium users can read full posts and post under premium tags; others see title and teaser.

---

### M7 — Learning roadmaps

#### F-15 Learning roadmaps — *Must (DSA track first) · New*
Must because roadmaps close the learning loop of G-1 (learn → practise → track progress). Their readings are also
the main content the AI assistant (F-19) answers from. A pilot roadmap for the Beyond LeetCode track is authored with
the premium pilot content (F-16); full premium-track roadmaps follow F-17/F-18.
Each track has one or more roadmaps (e.g. DSA: basics of programming → stack → queue → hash map → linked list …;
Beyond LeetCode: separate OS, Networking, Computer Architecture and Low-Level Design roadmaps).

- *As a user, I want a visual roadmap of sub-topics with prerequisites, so that I know what to learn next.*
- *As a user, I want each node to give me a reading, practice items and external resources.*
- *As a user, I want to track my progress and continue where I left off.*
- *As a signed-in user, I want my home page to show where to continue learning.*

Acceptance (outcome):
- A roadmap is a graph of nodes with prerequisite links (a node may have several prerequisites).
- Each node has Reading, Practice and Resources blocks; a practice item can belong to several nodes.
- A node is completed when its reading is marked done and **all** its practice items are solved; roadmap progress shows completed nodes.
- Each roadmap recommends the next node for the user.
- Signed-in users see a "Continue learning" block on their home page: the roadmap they are following, its
  completion percentage and the recommended next node.
- Roadmaps and readings are authored by moderators/admins; premium-track roadmaps are visible but locked for free users.
- The AI assistant (F-19) uses readings to answer questions.

---

### M8 — Premium

#### F-16 Premium membership (simulated) — *Must (minimal) · New*
Minimal scope: the entitlement itself, plus a small **Beyond LeetCode pilot**: moderator-authored problems,
quizzes and one roadmap in the Beyond LeetCode track, built with the same features as the DSA track. The full
premium tracks are F-17/F-18. Premium is delivered early (M1) so that every content feature enforces track access
from its first version (D-17).

- *As a user, I want to upgrade to premium so that I can access premium tracks and discussion.*
- *As an admin, I want to grant or revoke premium.*

Acceptance (outcome):
- Premium is granted without real payment (admin grant or mock checkout) for a fixed duration and expires automatically.
- Premium content is never accessible to users without an active entitlement.
- The Beyond LeetCode pilot content is locked (visible as teasers) for free users and unlocked for premium users.

#### F-17 Beyond LeetCode track — *Could · New*
The pilot content of this track is part of F-16 (Must); this feature is the full track.

- *As a premium user, I want coding problems, quizzes and one roadmap per topic (OS, networking, computer architecture, low-level design), including interview questions tagged by company.*

Acceptance (outcome):
- Each topic has its own roadmap, problems and quizzes.
- Low-level-design problems may use template mode (F-05).
- Eligible premium users can contribute problems and quizzes (§2.6).

#### F-18 System Design track — *Could · New*
- *As a premium user, I want design problems, quizzes and roadmaps for system design.*
- *As a premium user, I want to solve a design problem by placing components on a whiteboard, connecting them and explaining my design.*
- *As a moderator, I want to grade design submissions with a score and feedback.*

Acceptance (outcome):
- Design problems are not code problems; a submission is a diagram plus a written explanation.
- Users receive a moderator score and feedback; XP reflects the score.
- Eligible premium users can contribute design problems (with a proposed rubric finalized by the moderator) and quizzes.

---

### M9 — Platform intelligence

#### F-19 AI navigation and learning assistant — *Should (minimal; first Should) · New*
An assistant for signed-in users that answers short questions and points them to the right AstraCode page.

Minimal scope: single-turn questions; corpus of approved readings and approved problem/quiz statements (no
solutions); answers in English, with Vietnamese questions handled best-effort; helpful/not-helpful rating. Out of
scope: multi-turn conversation, streaming answers, site pages in the corpus, link-click tracking.

- *As a new user, I want to ask "where do I start?" and get a short answer with a link to the right page (e.g. the first node of the DSA roadmap).*
- *As a learner, I want to ask "what is a hash map?" and get a brief explanation with a link to the hash map reading and related problems.*
- *As a user, I want the assistant to say when it does not know rather than invent an answer.*

Acceptance (outcome):
- Available to signed-in users only; answers in English.
- Answers are short, grounded in AstraCode's own content, and include at least one link to AstraCode content when relevant content exists; otherwise the assistant says it does not know.
- Never reveals solutions, and refuses questions about problems of a running contest.
- Never exposes premium content to users without the entitlement.

Design, guardrails, evaluation and cost are owned by `docs/architecture/ai.md`.

#### F-20 Admin business KPI dashboard — *Must (minimal) · New*
- *As an admin, I want a dashboard of the business KPIs in §2.4 against their targets, so that I can see how the platform is used and where to improve.*

Acceptance (outcome):
- Shows each KPI over time and against its target, derived from existing platform data.

---

## Part 4 — Release scope

### 4.1 Milestones

Dates are not fixed; milestones are ordered by dependency. How work is delivered (environments, pipeline,
feature flags) is described in `delivery-plan.md` and `docs/architecture/deployment.md`.

| Milestone | Product content | Course parts exercised |
|---|---|---|
| M0 Foundation | Product documents and baseline specs; existing platform running on Azure | P1, P2, P3 |
| M1 Community core and premium | F-03 (incl. Contributor removal), F-06, F-16 minimal with Beyond LeetCode pilot content, F-21 core events | P2, P3 |
| M2 Competition and learning | F-09, F-10, F-15 (DSA track, with its readings and "Continue learning"); AI preparation (provider decision, `ai.md`, evaluation set) | P2, P4, P5 |
| M3 KPIs and production readiness | F-20; SLOs, security hardening, drills | P3, P4 |
| M4 Extensions | F-19 (minimal) first, then the other Should features (F-12, F-13, F-04, F-07, F-11, F-14), then Could features as capacity allows | P2, P5 |

### 4.2 Definition of release-ready

- All Must features demoable end-to-end on Azure production.
- Every NFR in `nfr.md` verified or explicitly explained.
- AI assistant evaluation report published (`docs/evidence/ai-eval/`) if F-19 is delivered.
- Load-test results on the contest critical path published (`docs/evidence/load-tests/`).

---

## Part 5 — Assumptions, risks, open questions

### 5.1 Assumptions

- Existing v0.1.0 features behave as documented; verified during baseline specs.
- Azure student credits remain available for the whole semester.
- An LLM API is available within budget.

### 5.2 Product and business risks

Technical risks are tracked in ADRs and `docs/codebase/TECH_DEBT.md`.

| Risk | Impact | Mitigation (owner doc) |
|---|---|---|
| Scope is large for a 6-person team | Must features unfinished | Core-first priorities; Must set reduced (D-15, D-16); pilot change first (`delivery-plan.md`) |
| Spam and review-queue flooding | Moderators overwhelmed; low-quality catalog | Eligibility, pending-item limit, automatic pre-check, reporting, suspension (`security.md`) |
| Premium content reaches free users (through product defects or users copying it into free tracks or comments) | Premium loses value | Entitlement enforcement (`nfr.md`, `security.md`); moderator checklist; reports; content policy |
| Malicious community content (harmful testcases or solutions) | Platform abuse or outage | Sandboxed execution and limits (`security.md`) |
| Contest unfairness (slow verdicts under load, tab-switch false positives) | Users lose trust in rating | Load-tested contest path (`workload-capacity.md`); warnings before flags (F-22) |
| AI gives wrong guidance or leaks solutions | Wrong learning, unfair advantage | Grounding, abstention, guardrails, evaluation (`ai.md`) |
| Cloud or AI cost exceeds credits | Platform goes offline | Cost model and budget alerts (`finops.md`) |

### 5.3 Open questions

None at this version.

---

## Appendix A — Agreed product rules (temporary)

These are **behaviour rules**; their permanent home is the OpenSpec spec of the listed capability. When the first
change touching that capability is archived, the rule is moved into the spec and deleted here. **Once moved, the
spec is the source of truth.**

| Capability | Agreed rule |
|---|---|
| content-moderation | Lifecycle: Draft → auto pre-check → Pending → In review (claimed) → Approved/Published, Changes requested (back to Draft) or Rejected (final, with a reason category — broken, quality, duplicate, policy or other — plus a free-text reason; "broken" rejections count toward the pre-check effectiveness KPI); moderator may Hide published items. Moderators may override tags, difficulty and rubric. Published items change only through a new review. |
| content-moderation | Eligibility to submit: verified email + ≥5 accepted problems; max 3 pending items per user. Submission allowed only to tracks the user can access. Template-mode problems, roadmaps and readings: moderators/admins only. |
| content-moderation | Coding problem submission requires statement, examples, constraints, tags, proposed difficulty, testcase ZIP and reference solution; auto pre-check runs the reference solution against all testcases in the sandbox. Design problem submission requires prompt, reference answer and proposed rubric. |
| content-moderation | Lapsed premium: author keeps published content and drafts; cannot submit to premium tracks until renewed. |
| identity-session | Contributor role removed; existing contributor accounts become Users and keep ownership of their drafts. Deleted accounts: published content stays, author shown as "deleted user". |
| membership | Premium is simulated (admin grant or mock checkout), lasts 30 days, expires automatically. Free users see premium tracks visible but locked (titles, structure, teasers). |
| problem-leaderboard | One leaderboard per problem **and language**; each user's best accepted submission; sort runtime ↑, memory ↑, submit time ↑. Percentile = share of accepted submissions for the same problem and language that the user's submission beats. |
| quiz | Single correct answer from 4 options; unlimited retries; XP only for the first correct attempt; explanation shown after answering. |
| gamification | XP: problems Easy/Medium/Hard = 10/20/40; quizzes = 2/5/10; first success only; contest solves award normal problem XP. XP drives a displayed level only. |
| gamification | Streak = consecutive UTC days with ≥1 accepted problem, correct quiz or contest participation. Heatmap day count = problems submitted + quizzes answered + contests joined. |
| contest | Weekly, fixed start, 90 minutes, 4 problems (easy → hard), scheduled by moderators/admins. Problems only. Registration required; late join allowed. Ranking: solved ↓, then penalty ↑ (sum of solve times + 5 min per wrong attempt before acceptance). Live leaderboard, no freeze. Afterwards problems become public practice, so contest problems come from the free DSA track only. |
| contest | Visibility: contest problems are hidden until the contest starts; from the start anyone can read the statements, but only registered participants' submissions count (late registration allowed). Afterwards they are normal practice problems. |
| contest | Tab-switch deterrent: rule shown before start; warning on 1st and 2nd switch; from the 3rd switch the participant may finish but is unrated and flagged for moderator review. |
| rating | Codeforces-style Elo based on expected vs actual rank; initial 1500; only participants with ≥1 submission are rated; contest authors/schedulers and flagged participants are not rated. |
| social-follow | One-way follow without approval; follower and following lists on profile; no activity feed. |
| notification | Channels: in-app for all events; email additionally for contest reminders and premium expiry. "New post" notifications go only to followers of the author. Moderator review notifications are digests of counts, sent once a day at 09:00 (Asia/Ho_Chi_Minh) only when items are waiting. Contest reminder 30 minutes before the start. Premium expiry notice 3 days before. |
| discussion | Posts require moderator approval; comments are flat with one reply level, not pre-moderated, rate-limited, reportable and removable by moderators; editing an approved post is not allowed (delete and repost). Premium tags: only premium users read full posts and post; others see title and teaser. |
| learning-roadmap | Roadmap = DAG of nodes (multiple prerequisites allowed); one level only (no sub-roadmaps). Node blocks: Reading, Practice (many-to-many), Resources (external links only). Node complete = reading marked done + 100% of practice items solved. Each roadmap recommends the next node. Authored by moderators/admins. |
| judging | Template mode: C++ first; moderator/admin-authored only; banned-include check; concurrency problems run repeated stress tests and are best-effort. |
| system-design-review | Predefined components (load balancer, cache, database, queue, CDN, …), arrows and notes; submission = diagram + written explanation; moderator score 0–10 + feedback; XP = difficulty XP × score ÷ 10. |
| ai-assistant | Signed-in users only; answers in English, Vietnamese questions best-effort; single-turn; corpus = approved readings, approved problem/quiz statements (no solutions); no site pages, no community posts; refuses running-contest problems. |

## Appendix B — Decision log

| ID | Decision | Date |
|---|---|---|
| D-01 | Remove Contributor role; community contribution with moderation in all tracks, gated by track access | 2026-11-17 |
| D-02 | Moderator is a staff role separate from premium entitlement; read-all for review | 2026-11-17 |
| D-03 | Big-O analysis and plagiarism detection are non-goals; tab-switch deterrent is Could | 2026-11-17 |
| D-04 | Template judge mode moved to Could, tied to Beyond LeetCode | 2026-11-17 |
| D-05 | KPIs have targets as hypotheses for an assumed launch scenario (revises earlier "definitions only") | 2026-11-17 |
| D-06 | AI assistant: navigation and learning help, signed-in users only, curated content | 2026-11-17 |
| D-07 | Core-first scope; platform runs on Azure from M0 | 2026-11-17 |
| D-08 | Roadmap node completion requires 100% of practice items | 2026-11-17 |
| D-09 | Budget: 5 student Azure subscriptions × ~$100, not poolable | 2026-11-17 |
| D-10 | PRD limited to product scope; technical content handed off (Appendix C) | 2026-11-17 |
| D-11 | Launch scenario and KPI targets confirmed as proposed | 2026-11-18 |
| D-12 | Quality guarantees moved to `nfr.md`; flows to `frd.md`; definitions to `glossary.md` | 2026-11-18 |
| D-13 | Learning roadmaps (DSA track) promoted to Must, because they provide the AI assistant's main content | 2026-11-18 |
| D-14 | Team works in the original repository (`nvawntien/astracode`) and keeps its develop → main → tag release flow; agents: Claude Code and Codex | 2026-11-18 |
| D-15 | Follow users (F-12) and Discussion (F-13) moved from Must to Should; their notification events move with them | 2026-11-24 |
| D-16 | AI assistant (F-19) moved from Must to Should with a minimal scope; it is the first Should, and its preparation (provider ADR, `ai.md`, evaluation set) stays in M2 | 2026-11-24 |
| D-17 | Premium (F-16) stays Must and early (M1), so that every content feature enforces track access from its first version; launch premium content is a moderator-authored Beyond LeetCode pilot; the full F-17 stays Could | 2026-11-24 |
| D-18 | Roadmaps (F-15) add a "Continue learning" block on the home page; contest problems come from the free DSA track only; roadmaps stay Must because they close the learning loop (G-1), not only because they feed the AI | 2026-11-24 |
| D-19 | Agreed while preparing ADR-0007: contest problems hidden until start, then readable by anyone with only registered participants' submissions counting; rejection reason categories; moderator digest daily at 09:00 (Asia/Ho_Chi_Minh); contest reminder 30 minutes before start | 2026-11-24 |

## Appendix C — Hand-off to other documents (temporary)

Content removed from the PRD in v0.3 because it belongs elsewhere. Each row is deleted once the target document
contains it.

| Content | Target document |
|---|---|
| Premium entitlement threat model (beyond NFR-S03) | `security.md` |
| AI corpus composition (approved readings, problem/quiz statements without solutions; no site pages, no community posts) | `ai.md` |
| LLM provider choice (Gemini) and vector storage (pgvector) | ADR; `ai.md` |
| Azure topology: subscription layout, VM-centric vs managed services, DR target subscription | ADRs; `deployment.md`; `finops.md` |
| Walking skeleton, IaC-provisioned staging, auto-deploy to staging, feature flags, judge-worker scaling | `delivery-plan.md`; `deployment.md`; `reliability-observability.md` |
| Known technical limits: in-process SSE fan-out, no DLT replay consumer, runtime schema auto-migration, logging-only observability | `docs/codebase/TECH_DEBT.md`; ADRs |
| Sandbox may need privileged containers (affects Azure hosting); multi-threaded submission support unverified | ADR (Azure topology); F-05 change |
| Existing production topology: separate App Node and Judge Node; release flow develop → main → immutable tag → manual deploy | `deployment.md`; ADR (Azure topology) |
