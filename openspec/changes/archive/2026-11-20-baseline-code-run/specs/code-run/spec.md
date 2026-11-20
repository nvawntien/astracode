## Purpose

Record current Custom run behaviour for executing a User's program with caller-provided testcases in a Sandbox and returning immediate feedback without creating a Submission.

## ADDED Requirements

### Requirement: User and Problem context

The system SHALL require an authenticated User identity and a positive coding problem identifier for a Custom run. Before executing code, it SHALL resolve the Problem using the User's identity and Role and return any resolution error without executing the program.

#### Scenario: Missing identity or invalid Problem identifier
- **WHEN** a Custom run lacks an authenticated User identity or has a nonpositive Problem identifier
- **THEN** the system rejects the request before execution

#### Scenario: Problem resolution fails
- **WHEN** a valid request's Problem cannot be resolved for the requesting User and Role
- **THEN** the system returns the resolution error without executing the code

### Requirement: Executable languages and Standard mode

The system SHALL accept exactly `CPP`, `GO`, `JAVA`, and `PYTHON` as Custom run language identifiers, without case conversion or whitespace trimming. It SHALL run a complete program using Standard mode with the caller's testcase input as standard input.

#### Scenario: Supported program
- **WHEN** a valid request selects `PYTHON` and supplies a program that reads standard input
- **THEN** the program receives the supplied testcase input in Standard mode

#### Scenario: Unsupported language identifier
- **WHEN** a request selects `C`, `JAVASCRIPT`, `go`, or a language identifier containing surrounding whitespace
- **THEN** the system rejects the language before execution

### Requirement: Source validation and size

The system SHALL reject source that is empty or consists only of whitespace, and source exceeding the configured byte limit, whose default is 262,144 bytes. It SHALL measure and forward the original source without trimming it.

#### Scenario: Source size boundary
- **WHEN** nonblank source contains exactly 262,144 bytes under default limits
- **THEN** source validation accepts it without changing its bytes

#### Scenario: Invalid or oversized source
- **WHEN** source is whitespace-only or contains 262,145 bytes under default limits
- **THEN** the system rejects the request before execution

### Requirement: Testcase count limit

The system SHALL require at least one testcase and reject a Custom run exceeding the configured testcase count limit, whose default is 10.

#### Scenario: Default count boundary
- **WHEN** an otherwise valid request supplies 10 testcases under default limits
- **THEN** the system accepts the testcase count

#### Scenario: Empty or excessive collection
- **WHEN** a request supplies zero or 11 testcases under default limits
- **THEN** the system rejects the testcase collection

### Requirement: Testcase identity and kind

The system SHALL trim surrounding whitespace from testcase identifiers and kinds. It SHALL reject empty identifiers, identifiers duplicated after trimming, and kinds other than the case-sensitive values `sample` and `custom`. It SHALL preserve testcase order and forward the trimmed identifiers and kinds.

#### Scenario: Whitespace normalization
- **WHEN** a testcase has identifier ` case-1 ` and kind ` custom `
- **THEN** the system uses identifier `case-1` and kind `custom` in the run and its returned testcase

#### Scenario: Invalid identity or kind
- **WHEN** identifiers are blank or duplicate after trimming, or a kind is `Custom`
- **THEN** the system rejects the request before execution

### Requirement: Caller-provided expected output

The system SHALL require caller-provided expected output for a `sample` testcase and allow a `custom` testcase with or without it. An explicitly empty expected output SHALL count as supplied. It SHALL use the supplied expected output without fetching or substituting a Problem's sample values.

#### Scenario: Sample expected output omitted
- **WHEN** a `sample` testcase omits expected output
- **THEN** the system rejects the request

#### Scenario: Explicit empty expectation
- **WHEN** a `sample` testcase supplies an empty expected output
- **THEN** expected-output presence validation accepts it

#### Scenario: Custom expectation is optional
- **WHEN** a `custom` testcase supplies or omits expected output
- **THEN** the system accepts either form and preserves the distinction for result classification

### Requirement: Testcase input size limits

The system SHALL reject any testcase whose standard input or supplied expected output exceeds its respective configured byte limit, each defaulting to 65,536 bytes. It SHALL permit empty standard input and forward input and expected output without trimming or rewriting them.

#### Scenario: Per-testcase boundaries
- **WHEN** input and supplied expected output each contain exactly 65,536 bytes under default limits
- **THEN** their size validation succeeds with their original contents preserved

#### Scenario: Oversized testcase content
- **WHEN** either input or supplied expected output contains 65,537 bytes under default limits
- **THEN** the system rejects the request before execution

### Requirement: Problem-derived execution limits

The system SHALL derive execution time and memory limits from resolved Problem metadata. For representable positive values, time below 50 SHALL be interpreted as seconds and time of 50 or greater as legacy milliseconds, with the result truncated to whole milliseconds; memory SHALL be converted from MiB to KiB. Nonpositive metadata SHALL use configured defaults, normally 2 seconds and 262,144 KiB. The Sandbox request SHALL replace any resulting nonpositive time or memory limit with 2,000 milliseconds or 262,144 KiB respectively.

#### Scenario: Time units and memory conversion
- **WHEN** Problem metadata provides time 0.5 and memory 128
- **THEN** the run receives a 500-millisecond CPU limit and a 131,072-KiB memory limit

#### Scenario: Legacy time threshold
- **WHEN** Problem metadata provides time 50
- **THEN** the run receives a 50-millisecond CPU limit

#### Scenario: Missing positive limits
- **WHEN** Problem time and memory are nonpositive and configured defaults are in use
- **THEN** the run receives limits of 2,000 milliseconds and 262,144 KiB

### Requirement: Execution deadline and failures

After Problem resolution, the system SHALL bound the synchronous execution call by the configured run timeout, defaulting to 30 seconds, while respecting any earlier caller deadline. It SHALL return a worker-timeout error for an execution deadline error and a worker-unavailable error for other worker call failures, rather than manufacturing successful testcase results.

#### Scenario: Worker deadline exceeded
- **WHEN** the execution call returns a deadline-exceeded error
- **THEN** the Custom run returns a worker-timeout error

#### Scenario: Worker or execution transport failure
- **WHEN** the worker call fails with an error other than deadline exceeded
- **THEN** the Custom run returns a worker-unavailable error

### Requirement: Compilation before execution

The system SHALL compile C++, Go, and Java programs once before running their testcases and run Python without a separate compilation step. When compilation returns a non-success outcome, it SHALL return `compile_error`, compilation output, available compilation diagnostics, and no testcase results. Compilation output SHALL prefer compiler standard error, then standard output, then the executor's error text.

#### Scenario: Compiled program succeeds
- **WHEN** a valid Go program compiles successfully
- **THEN** all its testcases use the compiled program

#### Scenario: Compilation fails
- **WHEN** compilation returns a non-success outcome with standard error
- **THEN** the run returns `compile_error` with the processed standard error and available diagnostics without running testcases

### Requirement: Compilation resource bounds

The system SHALL request compilation CPU time equal to the greater of the execution CPU limit and 30,000 milliseconds, wall-clock time equal to twice that CPU limit, memory equal to the greater of the execution memory limit and 524,288 KiB, and a process limit of 500. The enclosing Custom run deadline SHALL still apply.

#### Scenario: Compilation under default execution limits
- **WHEN** a compiled-language run uses default execution limits
- **THEN** compilation is requested with 30 seconds of CPU time, 60 seconds of wall-clock time, 524,288 KiB of memory, and a process limit of 500, subject to the enclosing deadline

### Requirement: Testcase resource and output bounds

For each testcase, the system SHALL request the derived execution CPU and memory limits, wall-clock time twice the CPU limit, and a process limit of 50. It SHALL independently bound standard output and standard error capture by a common budget: the greater of the requested output limit and each supplied expected-output byte length plus 65,536 bytes. The normal default output limit SHALL be 1,048,576 bytes; a nonpositive limit reaching execution SHALL fall back to that value.

#### Scenario: Default execution bounds
- **WHEN** a run has default time, memory, and output limits
- **THEN** each testcase is requested with 2 seconds of CPU time, 4 seconds of wall-clock time, 262,144 KiB of memory, a process limit of 50, and separate 1,048,576-byte output collectors

#### Scenario: Expected output raises a smaller capture budget
- **WHEN** the requested output limit is 1,024 bytes and a supplied expectation contains 2,048 bytes
- **THEN** both output collectors use a 67,584-byte budget

### Requirement: Complete ordered testcase feedback

For a run that reaches testcase execution, the system SHALL execute all supplied testcases without stopping at the first testcase failure and return their results in request order, unless an execution-call error prevents a result from being returned.

#### Scenario: Earlier testcase fails
- **WHEN** the first testcase has a runtime error and later testcases execute successfully without an execution-call error
- **THEN** the response includes the first failure and all later results in request order

### Requirement: Expected-output comparison

For a testcase whose Sandbox outcome is successful with zero exit status, the system SHALL compare standard output with supplied expected output when present. Comparison SHALL normalize CRLF and bare CR to LF, remove trailing spaces and tabs from each line, and remove trailing newlines, while preserving leading and internal whitespace. Matching output SHALL produce `accepted`, differing output `wrong_answer`, and an omitted expectation `executed`.

#### Scenario: Equivalent trailing formatting
- **WHEN** a successful testcase produces `10  \r\n` and its expectation is `10\n`
- **THEN** the testcase result is `accepted`

#### Scenario: Internal whitespace differs
- **WHEN** a successful testcase produces `a  b` and its expectation is `a b`
- **THEN** the testcase result is `wrong_answer`

#### Scenario: No expectation
- **WHEN** a successful testcase has no expected output
- **THEN** its result is `executed`

### Requirement: Run-level status

The system SHALL return `completed` for a non-null execution result other than a compilation failure, even when individual testcases fail. It SHALL return `compile_error` for a compilation failure and `system_error` with an empty testcase collection if execution returns no result and no error. An unrecognized run-level status received from the worker SHALL be exposed as `system_error`.

#### Scenario: Testcase failure in a completed run
- **WHEN** execution returns testcase results containing `wrong_answer`, `runtime_error`, or a resource-limit failure
- **THEN** the run-level status is `completed` and the individual failures remain in the testcase results

#### Scenario: Missing execution result
- **WHEN** execution returns no result and no error
- **THEN** the run-level status is `system_error` with no testcase results

### Requirement: Testcase failure statuses

The system SHALL preserve time, memory, and output-limit outcomes as `time_limit_exceeded`, `memory_limit_exceeded`, and `output_limit_exceeded`. It SHALL map a nonzero exit, signal termination, or execution file error to `runtime_error`, including a nominally successful Sandbox outcome with nonzero exit status. Internal or unrecognized outcomes SHALL become `system_error`. Expected-output comparison SHALL not replace these failure statuses.

#### Scenario: Output limit exceeded
- **WHEN** the Sandbox reports an output-limit outcome for a testcase
- **THEN** that testcase returns `output_limit_exceeded`

#### Scenario: Nonzero exit with matching output
- **WHEN** a testcase's output matches its expectation but its exit status is nonzero
- **THEN** that testcase returns `runtime_error`

### Requirement: Returned testcase details

The system SHALL return each testcase's identifier, kind, status, standard output, processed standard error, nullable supplied expected output, execution time in whole milliseconds, memory used in whole KiB, and available diagnostics. It SHALL preserve captured standard output without comparison normalization and represent absent output as an empty string.

#### Scenario: Successful sample feedback
- **WHEN** a sample testcase successfully emits output with trailing spaces and a newline
- **THEN** its feedback retains that captured output, the caller's expectation, its identity and kind, status, execution time, memory use, and available diagnostics

### Requirement: Diagnostic feedback and output processing

The system SHALL remove recognized internal workspace path prefixes and surrounding whitespace from compilation output and standard error. It SHALL extract compilation diagnostics for recognized C++, Go, and Java locations and runtime diagnostics for recognized C++, Go, Java, and Python source locations, using positive line and column values with column 1 as the fallback. Diagnostics SHALL contain kind, error severity, message, and location; runtime diagnostics SHALL identify their testcase and appear both in that testcase and in the run's combined diagnostics. Unrecognized text SHALL remain available as processed output without a synthesized location.

#### Scenario: Recognized runtime location
- **WHEN** standard error contains a recognized Go runtime source location for a testcase
- **THEN** the response includes its runtime diagnostic with testcase identity in both diagnostic collections and processes recognized workspace prefixes in standard error

#### Scenario: No recognized location
- **WHEN** compiler output or standard error contains no recognized source location
- **THEN** the response retains the processed output without inventing a diagnostic location

### Requirement: Synchronous run without a Submission

The system SHALL return Custom run feedback synchronously without creating or updating a Submission or Attempt or persisting its testcase results. It SHALL use only the request's supplied testcase content and SHALL NOT load a Testcase package for the run.

#### Scenario: Run finishes
- **WHEN** a Custom run finishes with results or a compilation failure
- **THEN** its feedback is returned in that request and no Submission, Attempt, or persisted testcase result is created
