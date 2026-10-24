---
name: test-from-feedback
description: Use when writing tests, planning QA, or verifying a change in a project tracked by Feedback Graph. Turns the developer's approved lessons and past misses for the code you touched into concrete test cases, finds the existing tests that cover it, and reports which lesson each test guards.
---

# Tests and QA from past feedback

Feedback Graph knows what earlier agents got wrong in this project, and which files and tests that touched. Use it so the tests you write catch the misses the developer has already had to point out once.

## 1. Gather what has gone wrong here before

- Call `get_task_context` with `cwd`, the task, and the `files` you changed or will change.
- For the files other code depends on, call `impact` with `cwd` and those `paths`. Note the tests it lists and the lessons and misses on the dependents.
- If the project is not tracked, skip to writing tests the usual way.

## 2. Turn each lesson and miss into a test case

For every approved lesson and past miss that bears on this change, write down one case before writing any test code:

- **Guards:** the lesson or miss id it comes from.
- **Given / when / then:** the concrete input and the outcome the developer expects. Use the developer's own words from the miss to pick the input that broke last time (for example a request from a second tenant, an empty list, a page past the end).
- **Where:** the existing test file `impact` or `get_module_context` named, or a new file beside them.

Skip a lesson only when it plainly does not apply, and say why in one line.

## 3. Write and run them

- Add the cases to the project's existing test suite, in its style. Prefer one focused test per case over one test that checks everything.
- Run each new test against the code as it stands. If the code already handles the case, the test passes; if it fails, you have found the miss again: fix the code, not the test.
- Run every test `impact` listed for the files you changed, plus the project's full test command.

## 4. Report it

- In your summary to the developer, list each case with the lesson or miss it guards and whether it passed.
- Pass the same list in the summary you give `check_before_done`, with `files_changed`, so the check can see the lessons are covered.

Never mark a lesson as covered by a test you did not run.
