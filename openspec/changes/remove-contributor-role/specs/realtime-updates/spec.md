## MODIFIED Requirements

### Requirement: RT-01 Owner-only ticket issuance

The system SHALL issue a stream ticket and its expiration time only to an authenticated owner of an existing Submission with the User, Moderator, or Admin role. It SHALL reject an invalid Submission identifier, missing identity or role, and unsupported roles. Moderator and Admin roles SHALL NOT override stream-ticket ownership; a missing Submission and a Submission owned by someone else SHALL both produce a not-found outcome.

#### Scenario: Owner obtains a ticket

- **WHEN** an authenticated owner with an allowed role requests a ticket for an existing Submission
- **THEN** the system returns a ticket bound to that owner and Submission, together with its expiration time

#### Scenario: Privileged non-owner requests a ticket

- **WHEN** a Moderator or Admin requests a ticket for someone else's Submission
- **THEN** the system returns a not-found outcome and issues no ticket

#### Scenario: Missing Submission

- **WHEN** an authenticated owner requests a ticket for a Submission that does not exist
- **THEN** the system returns a not-found outcome and issues no ticket

#### Scenario: Invalid ticket request or actor

- **WHEN** a ticket request has an invalid Submission identifier, lacks identity or role, or supplies an unsupported role
- **THEN** the system rejects the request and issues no ticket
