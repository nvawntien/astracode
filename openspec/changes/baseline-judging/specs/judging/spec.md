## Purpose

Describe current official judging behaviour: consuming jobs, loading a testcase package, executing a submission in a Sandbox, producing a Verdict for its Attempt, and handling retries and dead-letter delivery.

## ADDED Requirements

### Requirement: J01 Ordered and bounded job consumption

The judging worker SHALL process jobs sequentially within each assigned message partition and share one concurrency limit across its partitions. The default limit SHALL be four jobs; a configured positive integer override SHALL replace that limit, while an absent, invalid, or non-positive override SHALL retain four.

#### Scenario: Multiple partitions have work

- **WHEN** several partitions deliver jobs concurrently
- **THEN** the worker processes at most its configured number of jobs at once and processes each partition's jobs in delivery order

#### Scenario: Invalid concurrency override

- **WHEN** the concurrency override is invalid or zero
- **THEN** the worker uses a concurrency limit of four

### Requirement: J02 Official testcase metadata

Before loading testcases, the worker SHALL obtain the coding problem's testcase package download location, declared testcase count, version, and execution limits. A non-positive problem identity, blank download location, non-positive count, or non-positive version SHALL be a non-retryable processing failure. Metadata retrieval SHALL use the configured timeout, which defaults to five seconds.

#### Scenario: Valid metadata

- **WHEN** the coding problem supplies a download location, positive count and version, and valid limits
- **THEN** the worker loads that testcase package for judging

#### Scenario: Missing metadata or permanent rejection

- **WHEN** metadata retrieval reports an invalid argument, not found, failed precondition, or permission denied, or returns invalid package metadata
- **THEN** the worker treats the failure as non-retryable

#### Scenario: Temporary or incomplete metadata response

- **WHEN** metadata retrieval times out, is unavailable, or returns no response
- **THEN** the worker returns a retryable processing failure

### Requirement: J03 Authoritative official execution limits

The worker SHALL require positive official CPU time and memory limits that can be safely converted to doubled nanoseconds and bytes respectively. A zero time or memory limit SHALL be a retryable failure; a negative or arithmetically unrepresentable nonzero limit SHALL be a non-retryable failure. Judging SHALL not start with substituted default time or memory limits for these failures.

#### Scenario: An official limit is omitted

- **WHEN** either official limit is zero
- **THEN** the worker returns a retryable failure before loading or executing testcases

#### Scenario: Both supplied limits are nonzero but unusable

- **WHEN** a supplied limit is negative or exceeds its safe conversion bound and neither limit is zero
- **THEN** the worker treats the limits as a non-retryable failure

### Requirement: J04 Versioned testcase package reuse

The worker SHALL reuse a locally cached testcase package when its recorded version matches the retrieved version and its retained ZIP has the locally recorded valid SHA-256 checksum. Otherwise it SHALL download a replacement, calculate its SHA-256 checksum, validate its extracted testcases, and retain the ZIP, checksum, and version before using the prepared package.

#### Scenario: Matching cached package

- **WHEN** the version matches and the retained ZIP matches its recorded checksum
- **THEN** the worker loads the cached extracted testcases without another download

#### Scenario: Stale or unverifiable package

- **WHEN** the version differs or the retained ZIP or checksum is missing, invalid, or mismatched
- **THEN** the worker downloads and prepares a replacement package

### Requirement: J05 Bounded and guarded package extraction

The worker SHALL use a 30-second download timeout and reject a downloaded ZIP larger than 64 MiB as non-retryable. During extraction it SHALL reject non-directory entries that are symlinks or whose cleaned paths are absolute or escape the extraction destination. It SHALL extract recognized testcase input and expected-output entries, ignoring other ordinary entries, and reject a sum of recognized entries' declared uncompressed sizes greater than 128 MiB. Extraction failures SHALL be non-retryable; download transport failures and unsuccessful download responses SHALL be retryable.

#### Scenario: Oversized package

- **WHEN** the downloaded ZIP exceeds 64 MiB or recognized entries declare more than 128 MiB uncompressed data
- **THEN** the worker fails processing without executing the submission and treats the failure as non-retryable

#### Scenario: Unsafe archive entry

- **WHEN** a non-directory archive entry is a symlink or its cleaned path escapes the extraction destination
- **THEN** the worker rejects the package as non-retryable

#### Scenario: Download failure

- **WHEN** the download times out or returns an unsuccessful response
- **THEN** the worker returns a retryable processing failure

### Requirement: J06 Testcase pairing and order

The worker SHALL recognize testcase pairs by positive numeric identity, allowing zero padding, require both input and expected output for each recognized identity, and require the number of pairs to equal the declared count. Missing partners, unrepresentable identities, and count mismatches SHALL be non-retryable failures. Valid pairs SHALL be ordered numerically, retain their normalized numeric identity, and receive consecutive result indices starting at one; numeric identities need not be contiguous.

#### Scenario: Padded and noncontiguous identities

- **WHEN** the package contains complete pairs with numeric identities 0002 and 0010 and declares two testcases
- **THEN** the worker orders them as identities 2 and 10 with result indices 1 and 2

#### Scenario: Pairing or count mismatch

- **WHEN** a recognized input lacks an expected output, an expected output lacks an input, or the pair count differs from the declared count
- **THEN** the worker treats the package as a non-retryable failure

### Requirement: J07 Standard mode and supported languages

The worker SHALL judge a submission in Standard mode, running the supplied complete program with each official input on standard input. It SHALL support the exact language identifiers CPP, GO, PYTHON, and JAVA. C++ SHALL compile with C++17 and level-three optimization; Go and Java SHALL compile before execution, while Python SHALL run through Python 3 without a separate compilation step. Blank or unsupported language identifiers, empty source, and an empty testcase list SHALL be non-retryable failures.

#### Scenario: Compiled or interpreted submission

- **WHEN** the language is CPP, GO, or JAVA
- **THEN** the worker compiles the program once before executing testcases

#### Scenario: Python submission

- **WHEN** the language is PYTHON
- **THEN** the worker executes the source directly through Python 3 for each testcase

#### Scenario: Unsupported spelling or empty source

- **WHEN** the language identifier is lowercase go or the source is empty
- **THEN** the worker treats execution preparation as a non-retryable failure

### Requirement: J08 Compilation budget and outcome

Compilation SHALL request CPU time of at least 30 seconds or the official CPU limit, whichever is larger, memory of at least 512 MiB or the official memory limit, whichever is larger, wall time twice its CPU limit, and a process limit of 500. Any returned non-success compilation status SHALL produce COMPILATION_ERROR with no testcase results. Compilation output SHALL prefer standard error, then standard output, then the executor error, with known internal path prefixes removed and surrounding whitespace trimmed. A successful compilation SHALL require a reusable executable artifact.

#### Scenario: Small official limits

- **WHEN** official limits are two seconds CPU time and 256 MiB memory
- **THEN** compilation requests 30 seconds CPU time, 60 seconds wall time, 512 MiB memory, and a process limit of 500

#### Scenario: Non-success compilation status

- **WHEN** the Sandbox returns a compilation failure or an internal-error status for compilation
- **THEN** the worker produces COMPILATION_ERROR and does not run testcases

#### Scenario: Missing compiled artifact

- **WHEN** compilation reports success but provides no executable artifact identity
- **THEN** the worker returns a retryable processing failure

### Requirement: J09 Per-testcase resource requests

Each official testcase execution SHALL request the coding problem's CPU time and memory limits, wall time twice that CPU limit, and a process limit of 50. Each compilation or testcase-batch execution call SHALL have a 120-second timeout bounded by cancellation of the job.

#### Scenario: Official testcase limits

- **WHEN** a testcase has official limits of 1500 milliseconds CPU time and 65536 KiB memory
- **THEN** execution requests those CPU and memory limits, 3000 milliseconds wall time, and a process limit of 50

#### Scenario: Execution call timeout

- **WHEN** an execution call reaches its 120-second timeout
- **THEN** the worker returns a retryable processing failure

### Requirement: J10 Output capture budget

The worker SHALL independently limit standard output and standard error collection during compilation and execution. For official judging, each collector's limit SHALL be the larger of 1 MiB and the largest expected-output byte length in the package plus 64 KiB.

#### Scenario: Small expected outputs

- **WHEN** every expected output plus 64 KiB fits within 1 MiB
- **THEN** each standard-output and standard-error collector has a 1 MiB limit

#### Scenario: Large expected output

- **WHEN** the largest expected output is 2 MiB
- **THEN** each collector's limit increases to 2 MiB plus 64 KiB

### Requirement: J11 Output comparison

For a successfully executed testcase, the worker SHALL compare actual and expected output after converting CRLF and CR line endings to LF, removing trailing spaces and tabs from each line, and removing trailing newlines. Leading whitespace, interior whitespace, and interior blank lines SHALL remain significant. Unequal normalized outputs SHALL produce WRONG_ANSWER.

#### Scenario: Harmless trailing whitespace

- **WHEN** actual and expected output differ only in line-ending style, trailing line spaces or tabs, or trailing newlines
- **THEN** the testcase receives ACCEPTED

#### Scenario: Significant whitespace difference

- **WHEN** actual output adds leading spaces or an interior blank line absent from expected output
- **THEN** the testcase receives WRONG_ANSWER

### Requirement: J12 Testcase Verdict mapping

The worker SHALL map successful execution with zero exit status to ACCEPTED before output comparison; successful execution with a nonzero exit status, execution file error, nonzero-exit status, or signal termination to RUNTIME_ERROR; and CPU-time, memory, and output-limit statuses to TIME_LIMIT_EXCEEDED, MEMORY_LIMIT_EXCEEDED, and OUTPUT_LIMIT_EXCEEDED respectively. Executor internal errors and unrecognized statuses SHALL map to SYSTEM_ERROR. These returned testcase Verdicts SHALL be completed judging outcomes rather than retryable processing errors.

#### Scenario: Resource or runtime failure

- **WHEN** the Sandbox reports an output-limit status or signal termination
- **THEN** the testcase receives OUTPUT_LIMIT_EXCEEDED or RUNTIME_ERROR respectively

#### Scenario: Returned executor internal-error status

- **WHEN** a testcase result carries an executor internal-error status
- **THEN** the worker produces a SYSTEM_ERROR Verdict without invoking processing retries solely for that status

### Requirement: J13 Batching and final Verdict

The worker SHALL submit official testcases in ordered batches of at most four. It SHALL retain results in testcase order only through the first non-Accepted result and use that result's Verdict as the final Verdict, even though other testcases in the already submitted batch can execute. It SHALL submit no later batch after that failure. If all testcases pass, the final Verdict SHALL be ACCEPTED. Aggregate CPU time in whole milliseconds and memory in whole KiB SHALL be the independent maxima over retained testcase results, rather than sums.

#### Scenario: Failure inside the first batch

- **WHEN** the second of eight ordered testcases fails in the first submitted batch
- **THEN** the worker retains only the first two results, uses the second testcase's Verdict, and submits no second batch

#### Scenario: All testcases pass

- **WHEN** every official testcase passes
- **THEN** the worker produces ACCEPTED with all testcase results and the maximum retained CPU time and memory usage

### Requirement: J14 Incomplete Sandbox responses

The worker SHALL return retryable processing failures for an absent Sandbox response, an execution-level error with no returned results, a missing compilation result, a testcase result count different from the submitted count, or a missing individual testcase result encountered before early termination. Such failures SHALL not publish a completed Verdict for that processing attempt.

#### Scenario: Incomplete batch response

- **WHEN** four testcases are submitted and the Sandbox returns three results
- **THEN** the worker returns a retryable processing failure without publishing a partial final Verdict

#### Scenario: Missing individual result

- **WHEN** the next testcase result to inspect is missing and no earlier testcase has caused early termination
- **THEN** the worker returns a retryable processing failure

### Requirement: J15 Bounded official testcase input transfer

The worker SHALL keep inline testcase input bytes in an execution batch within 3 MiB. When a single input or cumulative inline inputs would exceed that budget, it SHALL use a shared local input only if it is an official testcase and both its lexical and resolved paths remain inside the designated official testcase area. Without a safe local input or an applicable cached input, exceeding the inline budget SHALL be a non-retryable processing failure; a single input larger than 3 MiB SHALL require a safe local input.

#### Scenario: Large official input with a safe local source

- **WHEN** an official input exceeds 3 MiB and has a contained shared local source
- **THEN** the worker supplies that source instead of transferring the input inline

#### Scenario: Unsafe local source

- **WHEN** an over-budget input has no safe local source, including a source escaping through a symlink
- **THEN** the worker rejects that execution preparation as non-retryable

### Requirement: J16 Optional Sandbox testcase input reuse

Sandbox input caching SHALL be disabled by default. When enabled, cached inputs SHALL be distinguished by coding problem identity, package version, package SHA-256 checksum, testcase identity, and input SHA-256 checksum. Concurrent population for one identity SHALL be coalesced. Cache population failure or denied admission SHALL fall back to ordinary input transfer within its existing bounds. If a batch reports execution file errors and inspection confirms a bound cached input is absent, the worker SHALL invalidate that missing input and rebuild and retry the batch once.

#### Scenario: Default disabled cache

- **WHEN** the default configuration is used
- **THEN** testcase execution does not populate or reconcile the optional Sandbox input cache

#### Scenario: Changed dataset or changed input

- **WHEN** the package version, package checksum, testcase identity, or input content differs
- **THEN** the worker does not reuse an entry identified by the previous combination

#### Scenario: Cache population failure

- **WHEN** the optional cache cannot populate an input
- **THEN** the worker continues with bounded ordinary input transfer

#### Scenario: Confirmed missing cached input

- **WHEN** execution reports a file error and inspection confirms that a bound cached input no longer exists
- **THEN** the worker invalidates that input and retries the rebuilt batch once

### Requirement: J17 Optional Sandbox cache bounds and cleanup

Enabling the optional input cache SHALL require positive byte and entry budgets, a positive cleanup interval, and a non-negative idle lifetime. Admission SHALL account for retained entries and concurrent reservations and deny new population while a retained entry has unknown size. Reconciliation SHALL recognize only worker-owned cache identities. Cleanup SHALL consider only unused owned entries, selecting least recently used entries when over budget or entries whose configured positive idle lifetime has expired. Failed deletion SHALL retain the entry and its accounting without failing judging.

#### Scenario: Cache budget exhausted

- **WHEN** a new input would exceed the configured byte or entry budget, including concurrent reservations
- **THEN** the worker denies cache population and uses the bounded fallback

#### Scenario: Input is in use or deletion fails

- **WHEN** cleanup examines a pinned input or cannot delete an eligible input
- **THEN** it preserves the pinned input, and retains accounting for the failed deletion without changing the judging outcome

### Requirement: J18 Executable lifecycle

After a successful compilation supplies an executable artifact, the worker SHALL reuse it across the submission's testcase batches and make a best-effort deletion attempt when execution completes, fails, or is canceled. Deletion SHALL use an independent timeout of 500 milliseconds. Deletion failure SHALL not replace the judging outcome or trigger job retries.

#### Scenario: Early stop or canceled execution

- **WHEN** execution stops at a failed testcase or the job is canceled after successful compilation
- **THEN** the worker attempts bounded executable deletion despite the terminal or canceled execution path

#### Scenario: Executable deletion failure

- **WHEN** executable deletion fails
- **THEN** the worker preserves the execution outcome without introducing a retry solely for cleanup

### Requirement: J19 Correlated and restricted official results

For completed execution, the worker SHALL publish the final Verdict correlated with the original Submission and Attempt, together with available aggregate metrics, compilation output or error information, testcase package version, declared total count, and package checksum. Published per-testcase data SHALL contain only the result index, Verdict, and available CPU time and memory usage. Official inputs, expected outputs, actual outputs, standard error, and per-testcase diagnostics SHALL not be included as per-testcase data. Zero CPU-time or memory measurements SHALL be omitted from published metrics.

For a first failing testcase with a RUNTIME_ERROR, the result-level public error message SHALL be derived from its standard error when a nonempty message is available after sanitization, with known internal path prefixes, invalid UTF-8, and control characters other than newline, carriage return, and tab removed, and the message length bounded. This message is separate from the published per-testcase data.

#### Scenario: Failed official testcase

- **WHEN** execution produces WRONG_ANSWER and includes actual and expected output internally
- **THEN** the worker publishes the correlated Verdict and testcase summary without publishing those testcase contents

#### Scenario: Early termination provenance

- **WHEN** execution stops before all testcases are retained
- **THEN** the published package count still describes the declared total, with the package version and checksum and the original Attempt correlation

#### Scenario: Runtime error message

- **WHEN** the first failing testcase has a RUNTIME_ERROR and its standard error yields a nonempty message after sanitization
- **THEN** the worker publishes a sanitized, length-bounded result-level message derived from that standard error, separate from the testcase summary

### Requirement: J20 Non-retryable processing failures

A processing failure classified as non-retryable SHALL cause the worker to publish SYSTEM_ERROR for the original Submission and Attempt, with a generic public error message and a separate processing-error description. Successful publication SHALL complete handling without another processing retry. Failure to publish that result SHALL remain a retryable processing error.

#### Scenario: Permanent testcase failure

- **WHEN** a testcase package fails non-retryable validation and the SYSTEM_ERROR result is published successfully
- **THEN** the job completes without another processing attempt or dead-letter forwarding

#### Scenario: Publishing the permanent failure also fails

- **WHEN** publication of the SYSTEM_ERROR result fails
- **THEN** the worker returns a processing error for retry handling

### Requirement: J21 Retryable job failures

The worker SHALL try processing a decoded job at most three times in total while its session remains active, waiting 500 milliseconds before the second try and one second before the third. Each retry SHALL invoke the full judging flow again. A retryable error SHALL not itself publish SYSTEM_ERROR. A successful result publication SHALL complete handling and mark the source message eligible for acknowledgement; result-publication failures SHALL participate in the same retry policy.

#### Scenario: Temporary failure followed by success

- **WHEN** the first processing try fails temporarily and the second publishes a result successfully
- **THEN** the worker waits 500 milliseconds between tries and marks the source message eligible for acknowledgement after success

#### Scenario: All processing tries fail

- **WHEN** all three processing tries return errors
- **THEN** the worker forwards the job to the DLT with a recorded processing count of three

### Requirement: J22 Undecodable job payloads

The worker SHALL forward a payload that cannot be decoded as a judge job to the DLT without invoking judging, recording a processing count of zero. Decodable jobs SHALL proceed to judging without a separate consumer-level completeness check.

#### Scenario: Malformed payload

- **WHEN** a payload contains malformed JSON or incompatible value types
- **THEN** the worker attempts dead-letter delivery without executing the judging flow

#### Scenario: Omitted job attributes

- **WHEN** an object can be decoded but omits job attributes
- **THEN** the worker passes its decoded default values into judging for subsequent validation

### Requirement: J23 Dead-letter record retention

Dead-letter delivery SHALL retain the source topic, partition, offset, message key, payload, processing error, and processing count, using the original key for delivery. A payload containing valid JSON and valid UTF-8 SHALL be embedded as JSON; otherwise its exact bytes SHALL be retained through base64 with an encoding marker.

#### Scenario: Decoded job exhausts retries

- **WHEN** processing retries are exhausted
- **THEN** the DLT record includes the original job as JSON, its origin and key, the last processing error, and a processing count of three

#### Scenario: Malformed or non-UTF-8 payload

- **WHEN** a payload is not valid JSON or contains invalid UTF-8
- **THEN** the DLT record retains its exact bytes in base64 and identifies that encoding

### Requirement: J24 Acknowledgement and cancellation safety

The worker SHALL mark a failed source message eligible for acknowledgement only after successful DLT publication and only while its session remains active. If dead-letter delivery fails or is unavailable, it SHALL leave that message unacknowledged and stop processing later messages in that partition until cancellation or rebalance ends the session. Cancellation before execution, during processing, between retries, or during dead-letter publication SHALL leave the affected message unacknowledged and stop further processing retries.

#### Scenario: Successful dead-letter delivery

- **WHEN** dead-letter publication succeeds and the session remains active
- **THEN** the worker marks the source message eligible for acknowledgement and can advance within the partition

#### Scenario: Failed dead-letter delivery

- **WHEN** the DLT publisher is unavailable or its publication fails
- **THEN** the worker leaves the source message unacknowledged and does not process later messages from that partition during the session

#### Scenario: Session canceled during processing or publication

- **WHEN** cancellation occurs during judging, retry waiting, or dead-letter publication
- **THEN** the worker leaves the source message unacknowledged and does not start another processing retry
