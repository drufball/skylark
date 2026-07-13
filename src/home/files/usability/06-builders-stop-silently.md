# 🔴 Builders stop mid-build silently (recurring — the #1 watchdog case)

Three instances in one day, two different builders:
- #zo3a (yesterday): idle 25 min mid-build, twice, after backgrounded jobs
  lost their resume callback. Needed 3 manual nudges to land.
- #4mna (tonight, 00:44): ended its turn with a long text message — no
  background job, no error, nothing running — and just… stopped. 141 tool
  calls in, implementation basically done, PR never opened. Needed a firm
  "finish the landing" nudge. (An earlier soft pace-check at 01:06 also
  helped it move from exploring to implementing.)

Common shape: the session looks 'running'/'thinking' from the outside (see
doc on dishonest status line — being fixed by #4mna itself, ironically), but
no turn is in flight and none is scheduled. Nothing in the product notices;
only a human polling postgres does.

The manual playbook that works (candidate for automation):
1. idle 15+ min mid-build AND no live background job → send a nudge via
   `npm run agent send <id> "<land it: check, commit, push, PR, handoff>"`.
2. If it was waiting on a lost background-job resume, say so explicitly and
   tell it to re-run in the foreground.
3. Escalate wording on the second nudge; it has worked every time so far.
