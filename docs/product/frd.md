# AstraCode — Functional Requirements Document (FRD)

| Field | Value |
|---|---|
| Document ID | FRD |
| Version | 0.2 (draft for team review) |
| Status | Draft |
| Owner | Orchestrator, with capability owners |
| Location | `docs/product/frd.md` |
| Related | `prd.md` (why, scope, features) · `nfr.md` (quality) · `openspec/specs/*` (behaviour) · `../process/glossary.md` |

> **Scope of this document.** The FRD answers *which system capabilities realize the product* and *how actors move
> through them*. It is an **index**: it contains **no requirement text**. Exact behaviour lives in the OpenSpec spec
> of each capability (`openspec/specs/<capability>/spec.md`); until a spec exists, agreed rules are parked in
> PRD Appendix A. Quality requirements live in `nfr.md`.
>
> **How to use it**
> - Planning a feature → §3 shows which capabilities it creates, modifies or uses → one OpenSpec change per capability group.
> - Reviewing a change → §2 gives the capability's owner and spec; §4 shows the end-to-end flows it takes part in.
> - Answering "where is F-xx implemented?" → §3 → §2 → spec → code.

---

## 1. Scope and actors

- **Product scope, goals and non-goals:** `prd.md` Parts 1–2.
- **Actors:** Guest, User, Premium (entitlement), Moderator, Admin — defined in `prd.md` §2.5.
- **External systems:** email delivery, LLM API (for the AI assistant). Integration design: `docs/architecture/integration-events.md`.

---

## 2. Capability map

### 2.1 Business capabilities → system capabilities (OpenSpec domains)

Business capabilities (what the business does) group the system capabilities. Each system capability is one OpenSpec
domain: one folder `openspec/specs/<capability>/`.

```
Learning        → learning-roadmap · ai-assistant
Practice        → problem-catalog · code-run · submission · judging · quiz · problem-leaderboard
Competition     → contest · rating
Community       → content-moderation · discussion · social-follow · notification
Progress        → gamification · statistics · user-profile
Monetization    → membership
Platform        → identity-session · realtime-updates · kpi-analytics
Design practice → system-design-review
```

Merge decisions taken while building this map:
- **Tab-switch deterrent** is part of `contest` (it only affects contest participation and rating eligibility).
- **Track access** (which track a user may read or submit to) is part of `membership`; every capability that serves content *uses* it.
- **Template judge mode** is part of `judging`.
- **Streaks and heatmap counts** are part of `gamification` and `statistics` respectively.

### 2.2 System capabilities

**Owning service** for new capabilities is decided by ADR (data ownership and service boundaries, P2) and recorded
here afterwards. **Owner (team)** is filled when capability owners are assigned.

| Capability | Purpose | Owning service | Spec | Status | Owner (team) |
|---|---|---|---|---|---|
| identity-session | Accounts, sessions, roles, suspension | auth-service | `openspec/specs/identity-session/spec.md` | Exists → Modified (Contributor removal, roles) | TBD |
| user-profile | Public profile, user search, avatar | auth-service | `…/user-profile/spec.md` | Exists → Modified | TBD |
| membership | Premium entitlement, expiry, track access checks | TBD (ADR) | `…/membership/spec.md` | Planned | TBD |
| problem-catalog | Problems by track, tags, difficulty, statements, visibility | problem-service | `…/problem-catalog/spec.md` | Exists → Modified (tracks) | TBD |
| content-moderation | Submission lifecycle, eligibility, auto pre-check, review queue, claim, decisions, for problems, quizzes, posts and design problems | TBD (ADR; today partly problem-service) | `…/content-moderation/spec.md` | Exists (partial) → Modified | TBD |
| code-run | Custom test runs from the editor | judge-worker | `…/code-run/spec.md` | Exists | TBD |
| submission | Official submissions, attempts, history, rejudge | submission-service | `…/submission/spec.md` | Exists | TBD |
| judging | Sandbox execution, verdicts, standard and template modes | judge-worker | `…/judging/spec.md` | Exists → Modified (template mode, Could) | TBD |
| realtime-updates | Push live updates to the browser (verdicts, leaderboards, notifications) | submission-service (today) | `…/realtime-updates/spec.md` | Exists → Modified | TBD |
| quiz | Quiz catalog, answering, explanations | TBD (ADR) | `…/quiz/spec.md` | Planned | TBD |
| problem-leaderboard | Per-problem, per-language ranking and percentiles | TBD (ADR) | `…/problem-leaderboard/spec.md` | Planned | TBD |
| contest | Scheduling, registration, contest window, ranking, tab-switch deterrent | TBD (ADR) | `…/contest/spec.md` | Planned | TBD |
| rating | ELO computation and rating history | TBD (ADR) | `…/rating/spec.md` | Planned | TBD |
| gamification | XP, levels, streaks | TBD (ADR) | `…/gamification/spec.md` | Planned | TBD |
| statistics | Solved/attempted totals, distributions, tag histogram, difficulty counts, activity heatmap | submission-service | `…/statistics/spec.md` | Exists → Modified | TBD |
| social-follow | Follow relationships, follower/following lists | TBD (ADR) | `…/social-follow/spec.md` | Planned | TBD |
| discussion | Posts, tags (incl. premium tags), likes, comments, reports | TBD (ADR) | `…/discussion/spec.md` | Planned | TBD |
| notification | Event-to-notification rules, in-app inbox, email, mute settings | TBD (ADR) | `…/notification/spec.md` | Planned | TBD |
| learning-roadmap | Roadmaps per track, nodes, prerequisites, node content, progress, next-node recommendation | TBD (ADR) | `…/learning-roadmap/spec.md` | Planned | TBD |
| system-design-review | Whiteboard submissions, moderator grading | TBD (ADR) | `…/system-design-review/spec.md` | Planned (Could) | TBD |
| ai-assistant | Question answering with links to AstraCode content, abstention, guardrails | TBD (ADR) | `…/ai-assistant/spec.md` | Planned | TBD |
| kpi-analytics | KPI computation and admin dashboard | TBD (ADR) | `…/kpi-analytics/spec.md` | Planned | TBD |

---

## 3. Feature → capability matrix

**Creates** = the feature introduces the capability · **Modifies** = adds or changes behaviour · **Uses** = depends
on existing behaviour without changing it. A feature usually becomes one OpenSpec change per created/modified
capability (or per tightly coupled group).

| Feature | Priority | Creates | Modifies | Uses |
|---|---|---|---|---|
| F-01 Accounts and identity | Existing | — | identity-session (Contributor removal) | — |
| F-02 Problem catalog, IDE, run and submit | Existing | — | problem-catalog (tracks) | code-run, submission, judging, membership |
| F-03 Community content submission and moderation | Must | — | content-moderation, identity-session | judging (pre-check), problem-catalog, membership, notification |
| F-04 Per-problem leaderboard and percentile | Should | problem-leaderboard | — | submission, problem-catalog |
| F-05 Template judge mode | Could | — | judging, content-moderation | problem-catalog |
| F-06 Quizzes | Must | quiz | content-moderation | membership, notification |
| F-07 XP and levels | Should | gamification | user-profile | submission, quiz, contest, system-design-review |
| F-08 Streaks | Could | — | gamification | statistics |
| F-09 Weekly contests and live leaderboard | Must | contest | realtime-updates | submission, judging, problem-catalog (DSA track only), notification |
| F-10 ELO rating | Must | rating | user-profile | contest |
| F-11 Extended profile and statistics | Should | — | statistics, user-profile | quiz, contest, rating, gamification |
| F-12 Follow users | Should | social-follow | user-profile | notification |
| F-13 Discussion: blog posts | Should | discussion | content-moderation | notification |
| F-14 Premium discussion tags | Should | — | discussion | membership |
| F-15 Learning roadmaps | Must (DSA first) | learning-roadmap | — | problem-catalog, quiz, membership, submission |
| F-16 Premium membership | Must (minimal, with Beyond LeetCode pilot content) | membership | identity-session | notification; problem-catalog, quiz, learning-roadmap (pilot content) |
| F-17 Beyond LeetCode track | Could | — | problem-catalog, quiz, learning-roadmap | membership, judging |
| F-18 System Design track | Could | system-design-review | content-moderation, quiz, learning-roadmap | membership, gamification, notification |
| F-19 AI navigation and learning assistant | Should (minimal) | ai-assistant | — | learning-roadmap, problem-catalog, quiz, membership, contest, identity-session |
| F-20 Admin business KPI dashboard | Must (minimal) | kpi-analytics | — | all capabilities that produce KPI data |
| F-21 Notifications | Must (core events) | notification | realtime-updates | content-moderation, discussion, social-follow, contest, membership |
| F-22 Contest tab-switch deterrent | Could | — | contest, rating | notification |

### 3.1 Capability hotspots

Capabilities modified or used by many features need a single owner and careful sequencing of changes.

| Capability | Touched by | Implication |
|---|---|---|
| membership | F-02, F-03, F-06, F-14, F-15, F-16, F-17, F-18, F-19 | Build the minimal entitlement early (M1, PRD D-17); every content capability enforces track access from its first version |
| content-moderation | F-03, F-05, F-06, F-13, F-18 | Generic lifecycle first (F-03); other content types plug in later |
| notification | F-03, F-06, F-09, F-12, F-13, F-16, F-18, F-21, F-22 | Define the event contract early; producers can be built before the consumer |
| user-profile / statistics | F-07, F-10, F-11, F-12 | Batch profile changes to avoid parallel modifications of the same spec |

---

## 4. Use cases

Only flows that span several capabilities are described here; single-capability behaviour is expressed as spec
scenarios. Steps name the capability responsible in *italics*. Rules and thresholds are not repeated here; they are
in the referenced specs (PRD Appendix A until the specs exist).

### UC-01 Submit community content

| | |
|---|---|
| Actor | Eligible user (premium for premium tracks) |
| Trigger | User submits a problem or quiz for review |
| Preconditions | Signed in; eligible to submit; access to the target track; pending-item limit not reached |
| Related | F-03, F-06, F-21 · NFR (pre-check time) · `security.md` (untrusted content) |

Main flow:
1. User fills in the item and submits it for a chosen track. — *content-moderation*
2. System verifies eligibility, track access and pending-item limit. — *content-moderation, membership*
3. System runs the automatic pre-check; for coding problems the reference solution is judged against the testcases. — *content-moderation, judging*
4. Item enters the review queue as Pending. — *content-moderation*
5. Moderators receive a review digest notification. — *notification*
6. Moderator review continues in UC-08.

Alternatives:
- 2a. Not eligible, no track access or limit reached → submission refused with the reason.
- 3a. Pre-check fails → item returns to Draft with the failure reason; author notified. — *notification*

Postconditions: item is Pending in the review queue, or back in Draft with a reason.

### UC-02 Solve a problem

| | |
|---|---|
| Actor | User |
| Trigger | User submits a solution to a problem |
| Preconditions | Signed in; access to the problem's track |
| Related | F-02, F-04, F-07, F-11, F-15 · NFR (verdict latency) |

Main flow:
1. User optionally runs custom tests from the editor. — *code-run*
2. User submits; a submission and attempt are recorded. — *submission, membership*
3. Submission is judged in the sandbox. — *judging*
4. Verdict is pushed to the user's browser. — *realtime-updates*
5. On first acceptance: XP awarded; statistics and heatmap updated; leaderboard and percentile updated; roadmap node progress updated where the problem is linked. — *gamification, statistics, problem-leaderboard, learning-roadmap*

Alternatives:
- 3a. Not accepted → verdict shown; no XP, leaderboard or roadmap change; statistics record the attempt.
- 3b. Judging infrastructure fails → submission retried and eventually reported as a system error, never as a wrong verdict.

Postconditions: verdict stored; progress data consistent with the verdict.

### UC-03 Answer a quiz

| | |
|---|---|
| Actor | User |
| Trigger | User selects an answer |
| Preconditions | Signed in; access to the quiz's track |
| Related | F-06, F-07, F-15 |

Main flow:
1. User opens a quiz from the catalog or a roadmap node. — *quiz, learning-roadmap*
2. User selects an answer; correctness and explanation are shown. — *quiz*
3. On first correct answer: XP awarded; statistics, heatmap and roadmap progress updated. — *gamification, statistics, learning-roadmap*

Alternatives:
- 2a. Incorrect → explanation shown; user may retry.

Postconditions: answer recorded; progress updated on first success.

### UC-04 Take part in a contest

| | |
|---|---|
| Actors | User (participant), Moderator (scheduler) |
| Trigger | Moderator schedules a contest; users register |
| Preconditions | Contest problems prepared; participant signed in |
| Related | F-09, F-10, F-21, F-22 · NFR (contest load, verdict latency) · `workload-capacity.md` |

Main flow:
1. Moderator schedules the contest and selects problems. — *contest, problem-catalog*
2. User registers; before the start, registrants are reminded. — *contest, notification*
3. During the window, participants submit; submissions are judged; the live leaderboard updates. — *contest, submission, judging, realtime-updates*
4. Tab switches are recorded and warned; past the threshold the participant is flagged. — *contest*
5. At the end, the final ranking is fixed. — *contest*
6. Ratings are computed once for eligible participants; rating history updated. — *rating, user-profile*
7. Contest problems become practice problems. — *contest, problem-catalog*

Alternatives:
- 2a. Late join → user registers after the start and competes for the remaining time.
- 4a. Participant flagged → finishes the contest, excluded from rating, listed for moderator review.
- 6a. Contest author/scheduler or participant with no submissions → not rated.

Postconditions: final ranking and ratings stored exactly once; problems available for practice.

### UC-05 Publish and discuss a post

| | |
|---|---|
| Actors | User (author, reader), Moderator |
| Trigger | User submits a post |
| Preconditions | Signed in; premium entitlement for premium tags |
| Related | F-13, F-14, F-21, F-12 |

Main flow:
1. User writes a post with tags and submits it. — *discussion, content-moderation*
2. Moderator approves it (UC-08); author notified. — *content-moderation, notification*
3. Post becomes visible; followers of the author are notified (Should). — *discussion, notification, social-follow*
4. Readers like and comment; the author is notified. — *discussion, notification*
5. Readers report abusive comments; moderators remove them. — *discussion*

Alternatives:
- 1a. Premium tag without entitlement → refused.
- 2a. Rejected or changes requested → author notified with reason.
- Reader without premium opens a premium-tagged post → sees title and teaser only. — *membership*

Postconditions: published post with its interactions; notifications delivered.

### UC-06 Ask the AI assistant

| | |
|---|---|
| Actor | User (signed in) |
| Trigger | User asks a question in the assistant |
| Preconditions | Signed in |
| Related | F-19 · NFR (availability, latency, AI quality) · `ai.md` |

Main flow:
1. User asks a question (English or Vietnamese). — *ai-assistant*
2. Assistant retrieves relevant AstraCode content the user is allowed to access. — *ai-assistant, membership, learning-roadmap, problem-catalog, quiz*
3. Assistant answers briefly with links to the relevant pages. — *ai-assistant*
4. User optionally rates the answer; the rating is recorded for KPIs. — *ai-assistant, kpi-analytics*

Alternatives:
- 2a. No relevant content → assistant says it does not know and suggests search.
- 2b. Question concerns a running contest's problem, or asks for a solution → assistant refuses. — *contest*
- 2c. AI service unavailable → fallback results shown; the rest of the site is unaffected.

Postconditions: answer and feedback recorded.

### UC-07 Become premium and access a premium track

| | |
|---|---|
| Actors | User, Admin |
| Trigger | User upgrades (mock checkout) or admin grants premium |
| Preconditions | Signed in |
| Related | F-16, F-17, F-18, F-14, F-21 |

Main flow:
1. User upgrades or admin grants premium for the fixed duration. — *membership*
2. User is notified (Should). — *notification*
3. User opens a premium track; full content is shown. — *membership, problem-catalog, quiz, learning-roadmap*
4. Before expiry the user is reminded (Should); at expiry access reverts to locked teasers. — *membership, notification*

Alternatives:
- 3a. Without entitlement → locked teaser shown.
- 4a. Expired author → keeps own content; cannot submit to premium tracks until renewed. — *content-moderation*

Postconditions: entitlement state is the single basis for premium access everywhere.

### UC-08 Moderator review session

| | |
|---|---|
| Actor | Moderator |
| Trigger | Items Pending in the review queue |
| Preconditions | Moderator role |
| Related | F-03, F-06, F-13, F-18, F-21 · KPI: content review time |

Main flow:
1. Moderator opens the review console, filters the queue and claims an item. — *content-moderation*
2. Moderator reviews: correct track, not a duplicate, not copied from a premium track, quality; adjusts tags, difficulty or rubric. — *content-moderation, problem-catalog*
3. Moderator approves; item is published to its track. — *content-moderation, problem-catalog / quiz / discussion*
4. Author is notified. — *notification*

Alternatives:
- 3a. Request changes with a comment → item returns to Draft; author notified.
- 3b. Reject with a reason → final; author notified.
- 3c. Design submission (F-18) → moderator scores it with feedback; XP awarded; author notified. — *system-design-review, gamification, notification*
- Later: moderator hides a published item. — *content-moderation*

Postconditions: every decision recorded with moderator and time (feeds the review-time KPI).

### UC-09 Follow a roadmap node to completion

| | |
|---|---|
| Actor | User |
| Trigger | User opens a roadmap |
| Preconditions | Access to the roadmap's track |
| Related | F-15, F-19 |

Main flow:
1. User opens a roadmap (or the "Continue learning" block on the home page) and sees progress and the recommended next node. — *learning-roadmap*
2. User reads the node's reading and marks it done. — *learning-roadmap*
3. User solves the node's practice items (UC-02, UC-03). — *submission, quiz*
4. When the reading is done and all practice items are solved, the node is marked complete and the next node is recommended. — *learning-roadmap*

Alternatives:
- 1a. Premium roadmap without entitlement → structure visible, content locked. — *membership*

Postconditions: node and roadmap progress reflect the user's activity.

---

## 5. Open points

| # | Point | Resolved by |
|---|---|---|
| FRD-1 | Owning service of each new capability (new services vs extending existing ones) | Data-ownership / service-boundary ADR (P2) |
| FRD-2 | Whether `content-moderation` stays one capability for all content types or splits per content type | First content-moderation change |
| FRD-3 | Capability owners (team members) | Team assignment |
