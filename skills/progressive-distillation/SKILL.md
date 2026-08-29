# Progressive Distillation Thinking Skill

## Purpose

Use this skill to improve decision quality during software development by turning completed actions, problems, mistakes, experiments, and successful solutions into reusable development principles.

This skill follows the learning loop:

**Experience → Reflection → Principle → Experiment → Save**

The objective is not merely to solve the current problem. The objective is to make future decisions faster, safer, and more consistent.

## Trigger

Run Progressive Distillation after any meaningful development event, including:

- A bug is solved
- A build, test, deployment, or CI check fails
- Code review identifies a meaningful issue
- A security issue is discovered
- A database or architecture decision is made
- A UI workflow changes materially
- A prompt produces unexpectedly good or bad results
- An agent makes an incorrect assumption
- A workaround is required
- A reusable pattern is discovered
- A user workflow becomes confusing
- A feature takes significantly longer than expected
- A major decision must be made with incomplete information

Do not run this process for trivial formatting changes or routine mechanical edits.

## 1. Experience

Describe what actually happened before interpreting it.

Capture:

1. What task were we attempting?
2. What happened?
3. What succeeded?
4. What failed?
5. What files, components, services, or systems were involved?
6. What was the user trying to accomplish?
7. What was at stake?

Use concrete evidence whenever available: error messages, test results, console logs, build output, screenshots, database state, API responses, code-review findings, GitHub checks, and user feedback.

Output: **Experience Summary**

## 2. Reflect

Determine why the outcome occurred.

Ask:

1. Why did we choose the approach we used?
2. What assumptions were made?
3. Which assumptions were correct?
4. Which assumptions were wrong?
5. What information was missing?
6. What trade-offs were made?
7. Was the decision driven by speed, simplicity, cost, UX, security, maintainability, available information, previous patterns, agent recommendation, or framework limitations?
8. Could the problem have been detected earlier?
9. Was there a safer or simpler approach?

Output: **Reflection**

## 3. Distill

Extract a reusable lesson and convert it into a general development rule.

The rule must be short, actionable, applicable beyond the current task, and useful for preventing repeated mistakes or improving repeated decisions.

Examples:

- Never modify production data rules without running emulator security tests first.
- When requirements are ambiguous, prefer a small reversible implementation before committing to architecture.
- Never assume a database field exists; verify the schema before writing application logic.
- Before debugging UI behavior, confirm the underlying data state.
- Never begin coding until the repository and active branch are confirmed.
- When an external API fails intermittently, separate application bugs from provider availability before changing working code.

Output:

**Principle:** one sentence.

## 4. Experiment

Define how the principle will be tested.

Ask:

1. What should we do differently next time?
2. What small change can test this principle?
3. What evidence would prove it useful?
4. Can the new behavior be automated?

Possible experiments include tests, preflight checks, GitHub workflows, checklists, `AGENTS.md` changes, validation logic, schema verification, logging, monitoring, deployment gates, or code-review rules.

Output: **Next Experiment**

## 5. Save

Determine whether the lesson should become persistent project knowledge.

### Project Rule

Use when the lesson applies only to this application. Save to the most relevant project documentation, such as `DECISIONS.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_LOG.md`, specs/plans, or a project-specific skill.

### Agent Rule

Use when the lesson should control coding-agent behavior. Save to the relevant `AGENTS.md`.

### Universal Development Rule

Use when the principle applies across multiple applications. Save to this skill or the user's shared development-skills repository.

### Temporary Observation

Use when the principle has not been validated yet. Mark it **Experimental** and test it again before promoting it.

## Confidence

Every distilled principle receives one confidence rating:

- **Low** — observed once; do not enforce automatically.
- **Medium** — observed multiple times or strongly supported by evidence; recommend using it.
- **High** — repeatedly validated or clearly prevents significant failures; suitable for automation or enforcement.

## Decision Mode Under Uncertainty

When a decision must be made before enough information is available:

1. Identify what is known.
2. Identify what is unknown.
3. Identify assumptions.
4. Estimate the cost of being wrong.
5. Determine whether the decision is reversible.

For reversible decisions, prefer **small experiment → measure → adjust**.

For hard-to-reverse decisions such as database architecture, authentication architecture, destructive migrations, production security rules, payment architecture, or permanent deletion, gather more evidence first.

## Productivity Under Pressure

When many tasks appear urgent, rank them by:

1. User impact
2. Production risk
3. Blocking dependencies
4. Reversibility
5. Time required

Default priority:

**Production/Security Risk → Blocking Failure → User-Critical Feature → Enhancement → Cosmetic Improvement**

Do not prioritize tasks solely because they arrived most recently.

## Communication Mode

When explaining development decisions to the user, use:

1. **What happened**
2. **Why it matters**
3. **What we should do**
4. **What happens next**

Avoid unnecessary technical vocabulary unless it changes the user's decision.

## Vibe-Coding Safety Rules

Before meaningful coding work:

1. Confirm the correct project.
2. Confirm the correct repository.
3. Confirm the active branch.
4. Read all applicable `AGENTS.md` files.
5. Read project documentation relevant to the task.
6. Inspect the existing implementation before changing it.
7. Prefer minimal changes.
8. Test changes.
9. Review results.
10. Distill meaningful lessons before continuing.

Never:

- Switch repositories without explicit reason.
- Deploy automatically unless authorized.
- Merge automatically unless authorized.
- Delete production data without explicit authorization.
- Rewrite large working sections when a targeted fix is possible.
- Hide failing tests.
- Change security protections merely to make tests pass.

Project-specific `AGENTS.md` rules always remain authoritative and may impose stricter requirements.

## Self-Correction Trigger

Immediately run Progressive Distillation if the agent:

- Makes the same mistake twice
- Misunderstands the user's request
- Selects the wrong repository
- Changes unrelated files
- Creates a regression
- Breaks a previously passing test
- Misinterprets an API
- Assumes missing information as fact
- Produces a solution the user rejects

Determine: **What assumption caused the failure?** Then create a candidate rule preventing recurrence.

## Automation Rule

When a principle reaches High confidence, determine whether it can be enforced automatically.

Preferred enforcement order:

1. Automated tests
2. CI checks
3. Validation scripts
4. Git hooks
5. Agent instructions
6. Human checklist

Prefer automation over relying on memory.

## Principle Registry Format

```md
## Principle PD-001

**Situation:**
Short description.

**Principle:**
One-sentence rule.

**Evidence:**
What led to the rule.

**Confidence:**
Low / Medium / High

**Scope:**
Project / Agent / Universal

**Experiment:**
How the principle will be tested.

**Status:**
Experimental / Validated / Automated / Retired
```

## End-of-Task Distillation

At the end of significant work, ask:

1. What did we learn?
2. Did anything surprise us?
3. Did we discover a reusable rule?
4. Should any rule be added to project documentation?
5. Can any new rule be automated?

If there is no meaningful lesson, record:

**Distillation Result: No reusable principle identified.**

Do not invent a principle merely to complete the process.

## Required Output Format

```md
## Progressive Distillation

**Experience:**
What happened.

**Reflection:**
Why it happened and what influenced the decision.

**Distilled Principle:**
The reusable one-sentence rule.

**Next Experiment:**
How the rule will be tested.

**Confidence:**
Low / Medium / High

**Scope:**
Project / Agent / Universal

**Save To:**
File or location, if applicable.

**Automation Opportunity:**
Yes / No
```

If automation is appropriate, describe how the rule could eventually be enforced automatically.

## Primary Objective

Do not allow valuable lessons from development work to disappear after the immediate problem is solved.

The development loop is:

**BUILD → TEST → OBSERVE → REFLECT → DISTILL → SAVE → IMPROVE → BUILD AGAIN**
