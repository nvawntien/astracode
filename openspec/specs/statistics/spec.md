# statistics Specification

## Purpose
Define access to personal and public competitive statistics and the submission counts, verdicts, languages, and UTC activity those statistics represent.

## Requirements

### Requirement: Own profile statistics access

The system SHALL require a signed-in account with a supported role for own profile statistics and scope the aggregates to that authenticated account.

#### Scenario: Read own statistics
- **WHEN** a signed-in account with a supported role requests its statistics
- **THEN** the response aggregates that account's submissions

#### Scenario: Request without authentication
- **WHEN** a Guest requests own profile statistics
- **THEN** the system denies the request without returning counts

### Requirement: Public profile statistics eligibility

The system SHALL let Guests and signed-in viewers request public aggregate statistics by username. For each request it SHALL resolve the username to an active, non-suspended account before reading statistics, and use that account's stable identity for the aggregates. Missing, unverified and suspended accounts SHALL produce the same public not-found outcome.

#### Scenario: Read statistics for a visible account
- **WHEN** a requested username resolves to a visible account
- **THEN** the system returns the aggregates for that resolved account

#### Scenario: The requested account is not visible
- **WHEN** the username does not exist or belongs to an unverified or suspended account at eligibility check time
- **THEN** the response is not found and statistics are not read for the account

#### Scenario: Visibility cannot be verified
- **WHEN** the identity lookup fails because it is unavailable or reaches its own timeout while the request is still active, other than a cancellation response
- **THEN** the request reports temporary unavailability without reading or returning aggregates

#### Scenario: Identity lookup returns cancellation
- **WHEN** the identity lookup returns a cancellation response while the request is still active
- **THEN** the request reports an internal error without reading or returning aggregates

### Requirement: Statistics response contains aggregates

Own and public statistics SHALL return submission totals, attempted and solved problem totals, acceptance rate, verdict counts, language counts and daily activity counts. The statistics SHALL omit individual submissions, source code, testcase data, ranking, and rating.

#### Scenario: Read statistics for an account with submissions
- **WHEN** an eligible statistics request succeeds for an account with stored submissions
- **THEN** the response contains aggregate metrics without individual records or their details

### Requirement: Submission totals and acceptance rate

The system SHALL count all of the account's submissions in the submission total and each distinct submitted problem in the attempted total. It SHALL count currently Accepted submissions for the accepted total and distinct problems with at least one currently Accepted submission as solved. The acceptance rate SHALL be accepted submissions divided by total submissions as a percentage rounded to two decimal places, or zero when there are no submissions.

#### Scenario: Repeated submissions and a pending submission
- **WHEN** an account has a Wrong Answer and an Accepted submission on one problem and a Pending submission on another
- **THEN** it has three submissions, two attempted problems, one Accepted submission, one solved problem and a 33.33 percent acceptance rate

#### Scenario: An Accepted verdict is no longer current
- **WHEN** a submission's current status ceases to be Accepted and it was the only currently Accepted submission for its problem
- **THEN** the contribution to accepted and solved totals is removed while the submission remains counted in total submissions and attempted problems

#### Scenario: Account has no submissions
- **WHEN** the account has no submissions
- **THEN** the totals and acceptance rate are zero, and the distributions and activity are empty

### Requirement: Verdict distribution

The system SHALL count current terminal verdicts from the account's submissions. The terminal verdicts included are Accepted, Wrong Answer, Time Limit Exceeded, Memory Limit Exceeded, Output Limit Exceeded, Runtime Error, Compilation Error and System Error. The system SHALL omit unfinished statuses and return represented verdicts in descending count order, with ties sorted by verdict code ascending.

#### Scenario: Unfinished and terminal submissions coexist
- **WHEN** an account has Pending, Judging, and terminal submissions
- **THEN** only terminal verdicts contribute to the distribution

#### Scenario: Verdict counts tie
- **WHEN** two represented verdicts have the same count
- **THEN** the verdict whose code sorts first appears first

### Requirement: Language distribution

The system SHALL count all of the account's submissions by their recorded language, regardless of status. It SHALL return represented languages in descending count order, with ties sorted by language code ascending.

#### Scenario: Language counts include unfinished submissions
- **WHEN** an account has two submissions in one language, including a Pending submission, and one submission in a second language
- **THEN** the two languages are returned with counts of two and one in that order

#### Scenario: Language counts tie
- **WHEN** two represented languages have the same count
- **THEN** the language whose code sorts first appears first

### Requirement: Daily submission activity

The system SHALL count submissions by UTC creation date beginning at midnight on the UTC date 364 days before the current UTC date. It SHALL include submissions regardless of status and return dates containing submissions in ascending order.

#### Scenario: UTC window boundary
- **WHEN** one submission was created exactly at the first included UTC midnight and another was created just before it
- **THEN** the first submission is counted on its UTC date and the earlier submission is excluded

#### Scenario: Dates without submissions
- **WHEN** there are submissions on two dates separated by a date with none
- **THEN** the system returns counts for the two populated dates in chronological order without adding a zero row for the intervening date
